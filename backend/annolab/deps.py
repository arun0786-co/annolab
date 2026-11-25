from __future__ import annotations

from collections.abc import Iterator

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .models import Item, Project, Task, User
from .security import decode_token

bearer = HTTPBearer(auto_error=False)


def get_db(request: Request) -> Iterator[Session]:
    yield from request.app.state.db.session()


def _user_from_token(request: Request, db: Session, token: str | None) -> User:
    if not token:
        raise HTTPException(401, "not authenticated")
    uid = decode_token(token, request.app.state.settings.secret)
    user = db.get(User, uid) if uid is not None else None
    if user is None or not user.active:
        raise HTTPException(401, "invalid or expired token")
    return user


def current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    return _user_from_token(request, db, creds.credentials if creds else None)


def media_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    """Media elements (<audio>, <video>, <img>) cannot send headers, so allow ?token=."""
    token = creds.credentials if creds else request.query_params.get("token")
    return _user_from_token(request, db, token)


def require(*roles: str):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, f"requires role: {' or '.join(roles)}")
        return user

    return dep


admin_only = require("admin")
can_label = require("admin", "annotator")
can_review = require("admin", "reviewer")


def get_project(db: Session, project_id: int) -> Project:
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "project not found")
    return p


def get_item(db: Session, item_id: int) -> Item:
    it = db.get(Item, item_id)
    if it is None:
        raise HTTPException(404, "item not found")
    return it


def get_task(db: Session, task_id: int, user: User) -> Task:
    t = db.get(Task, task_id)
    if t is None:
        raise HTTPException(404, "task not found")
    if t.user_id != user.id and user.role not in ("admin", "reviewer"):
        raise HTTPException(403, "not your task")
    return t
