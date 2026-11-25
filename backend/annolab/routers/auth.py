from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from .. import schemas as S
from ..deps import admin_only, current_user, get_db
from ..models import User
from ..security import create_token, hash_password, verify_password
from ..services import close_user_tasks

router = APIRouter(tags=["auth"])


@router.post("/auth/login", response_model=S.TokenOut)
def login(body: S.LoginIn, request: Request, db: Session = Depends(get_db)):
    user = db.scalars(select(User).where(func.lower(User.email) == body.email.strip().lower())).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "wrong email or password")
    if not user.active:
        raise HTTPException(403, "account disabled")
    settings = request.app.state.settings
    audit.record(db, user.id, "auth.login", "user", user.id)
    db.commit()
    return S.TokenOut(token=create_token(user.id, settings.secret, settings.token_ttl_minutes),
                      user=S.UserOut.model_validate(user))


@router.get("/auth/me", response_model=S.UserOut)
def me(user: User = Depends(current_user)):
    return user


@router.get("/users", response_model=list[S.UserOut])
def list_users(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    return db.scalars(select(User).order_by(User.id)).all()


@router.post("/users", response_model=S.UserOut, status_code=201)
def create_user(body: S.UserCreate, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    email = body.email.lower()
    if db.scalars(select(User).where(func.lower(User.email) == email)).first():
        raise HTTPException(409, "email already registered")
    user = User(email=email, name=body.name, role=body.role, password_hash=hash_password(body.password))
    db.add(user)
    db.flush()
    audit.record(db, admin.id, "user.create", "user", user.id, payload={"email": email, "role": body.role})
    db.commit()
    return user


@router.patch("/users/{user_id}", response_model=S.UserOut)
def patch_user(user_id: int, body: S.UserPatch, actor: User = Depends(current_user), db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    is_admin = actor.role == "admin"
    if not is_admin and actor.id != user_id:
        raise HTTPException(403, "can only edit your own account")
    if not is_admin and (body.role is not None or body.active is not None):
        raise HTTPException(403, "only admins change roles or deactivate users")
    if is_admin and actor.id == user_id and (body.role not in (None, "admin") or body.active is False):
        raise HTTPException(409, "admins cannot demote or deactivate themselves")
    changed = body.model_dump(exclude_none=True, exclude={"password"})
    for k, v in changed.items():
        setattr(user, k, v)
    if body.password:
        user.password_hash = hash_password(body.password)
        changed["password"] = "changed"
    if body.active is False:
        changed["released_tasks"] = close_user_tasks(db, user)
    audit.record(db, actor.id, "user.update", "user", user.id, payload=changed)
    db.commit()
    return user
