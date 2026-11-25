from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import audit
from .. import schemas as S
from ..consensus import item_consensus
from ..deps import admin_only, can_review, current_user, get_db, get_item, get_project, media_user
from ..media import EXTENSIONS, describe, make_thumbnail, range_response, store_bytes
from ..models import Annotation, Item, Project, Review, Task, User
from ..serialize import item_out, review_out, user_brief
from ..services import ann_dict

router = APIRouter(tags=["items"])


def _add_item(db: Session, project: Project, media_root: Path, filename: str, data: bytes) -> list[Item]:
    """Store one uploaded file. A .jsonl text file becomes one item per line."""
    ext = Path(filename).suffix.lower()
    if ext not in EXTENSIONS[project.modality]:
        raise ValueError(f"{ext or 'no extension'} is not accepted for {project.modality} projects")
    if project.modality == "text":
        text = data.decode("utf-8", errors="strict")
        if ext == ".jsonl":
            rows = []
            for n, line in enumerate(text.splitlines(), 1):
                if not line.strip():
                    continue
                obj = json.loads(line)
                if not isinstance(obj, dict) or not isinstance(obj.get("text"), str):
                    raise ValueError(f"line {n}: expected an object with a text field")
                rows.append((obj.get("id") or f"{Path(filename).stem}-{n}", obj["text"]))
        else:
            rows = [(filename, text)]
        items = []
        for name, body in rows:
            path = store_bytes(media_root, project.id, f"{Path(str(name)).stem}.txt", body.encode())
            it = Item(project_id=project.id, kind="text", filename=str(name),
                      media_path=str(path.relative_to(media_root)), meta={"text": body, "chars": len(body)})
            db.add(it)
            items.append(it)
        return items
    path = store_bytes(media_root, project.id, filename, data)
    try:
        meta = describe(path, project.modality)
    except Exception as e:
        path.unlink(missing_ok=True)
        raise ValueError(f"could not read file: {e}") from None
    thumb = make_thumbnail(path, project.modality)
    if thumb:
        meta["thumbnail"] = str(thumb.relative_to(media_root))
    it = Item(project_id=project.id, kind=project.modality, filename=filename,
              media_path=str(path.relative_to(media_root)), meta=meta)
    db.add(it)
    return [it]


@router.post("/projects/{project_id}/items", response_model=S.UploadResult, status_code=201)
async def upload_items(
    project_id: int,
    request: Request,
    files: list[UploadFile] = File(...),
    admin: User = Depends(admin_only),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id)
    media_root = request.app.state.settings.media_dir
    created, errors = [], []
    for f in files:
        data = await f.read()
        try:
            created += _add_item(db, project, media_root, f.filename or "file", data)
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as e:
            errors.append({"filename": f.filename or "", "error": str(e)})
    db.flush()
    audit.record(db, admin.id, "items.upload", "project", project.id, project.id,
                 {"created": len(created), "errors": len(errors)})
    db.commit()
    return S.UploadResult(created=[item_out(i, admin, 0) for i in created], errors=errors)


@router.post("/projects/{project_id}/items/import", response_model=S.UploadResult, status_code=201)
def import_folder(project_id: int, body: S.ImportIn, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    """Import every accepted file from a folder on the server's disk."""
    project = get_project(db, project_id)
    folder = Path(body.path).expanduser()
    if not folder.is_dir():
        raise HTTPException(422, "path is not a folder on the server")
    media_root = request.app.state.settings.media_dir
    created, errors = [], []
    for path in sorted(folder.iterdir()):
        if not path.is_file() or path.name.startswith("."):
            continue
        if path.suffix.lower() not in EXTENSIONS[project.modality]:
            continue
        try:
            created += _add_item(db, project, media_root, path.name, path.read_bytes())
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as e:
            errors.append({"filename": path.name, "error": str(e)})
    db.flush()
    audit.record(db, admin.id, "items.import", "project", project.id, project.id,
                 {"created": len(created), "errors": len(errors), "path": str(folder)})
    db.commit()
    return S.UploadResult(created=[item_out(i, admin, 0) for i in created], errors=errors)


@router.get("/projects/{project_id}/items", response_model=S.Page[S.ItemOut])
def list_items(
    project_id: int,
    status: str | None = Query(None, description="One status or a comma-separated list"),
    q: str | None = Query(None, description="Search in filename and note text"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    get_project(db, project_id)
    query = select(Item).where(Item.project_id == project_id)
    if status:
        query = query.where(Item.status.in_([s.strip() for s in status.split(",") if s.strip()]))
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(Item.filename.ilike(like), func.json_extract(Item.meta, "$.text").ilike(like)))
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.scalars(query.order_by(Item.id).offset((page - 1) * page_size).limit(page_size)).all()
    counts = dict(db.execute(
        select(Task.item_id, func.count()).where(Task.item_id.in_([r.id for r in rows] or [0]), Task.status == "submitted").group_by(Task.item_id)
    ).all())
    return S.Page[S.ItemOut](items=[item_out(r, user, counts.get(r.id, 0)) for r in rows], total=total, page=page, page_size=page_size)


@router.get("/items/{item_id}", response_model=S.ItemOut)
def read_item(item_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return item_out(get_item(db, item_id), user)


@router.get("/items/{item_id}/media", responses={206: {"description": "Partial content"}, 416: {"description": "Bad range"}})
def item_media(item_id: int, request: Request, _: User = Depends(media_user), db: Session = Depends(get_db)):
    """File stream. Supports Range for seeking. Accepts ?token= for media elements."""
    item = get_item(db, item_id)
    if not item.media_path:
        raise HTTPException(404, "item has no media file")
    return range_response(request, request.app.state.settings.media_dir / item.media_path)


@router.get("/items/{item_id}/thumbnail")
def item_thumbnail(item_id: int, request: Request, _: User = Depends(media_user), db: Session = Depends(get_db)):
    item = get_item(db, item_id)
    rel = item.meta.get("thumbnail")
    if not rel:
        raise HTTPException(404, "no thumbnail for this item")
    return range_response(request, request.app.state.settings.media_dir / rel, "image/jpeg")


@router.get("/items/{item_id}/annotations", response_model=list[S.AnnotationOut])
def item_annotations(
    item_id: int,
    user_id: int | None = None,
    include_open: bool = Query(False, description="Also return annotations of tasks not yet submitted (admin/reviewer)"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Annotators see only their own annotations; reviewers and admins see everyone's."""
    get_item(db, item_id)
    q = select(Annotation).join(Task, Task.id == Annotation.task_id).where(Annotation.item_id == item_id)
    if user.role == "annotator":
        if user_id is not None and user_id != user.id:
            raise HTTPException(403, "annotators can only read their own annotations")
        q = q.where(Annotation.user_id == user.id)
    else:
        if user_id is not None:
            q = q.where(Annotation.user_id == user_id)
        if not include_open:
            q = q.where(Task.status == "submitted")
    return db.scalars(q.order_by(Annotation.user_id, Annotation.id)).all()


@router.get("/items/{item_id}/reviews", response_model=list[S.ReviewOut])
def item_reviews(item_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_item(db, item_id)
    if user.role == "annotator":
        mine = db.scalar(select(Task.id).where(Task.item_id == item_id, Task.user_id == user.id))
        if mine is None:
            raise HTTPException(403, "you have not worked on this item")
    rows = db.scalars(select(Review).where(Review.item_id == item_id).order_by(Review.created_at.desc())).all()
    return [review_out(r) for r in rows]


def annotator_sets(db: Session, item: Item) -> list[S.AnnotatorSet]:
    tasks = db.scalars(select(Task).where(Task.item_id == item.id, Task.status == "submitted").order_by(Task.user_id)).all()
    return [
        S.AnnotatorSet(user=user_brief(t.user), task_id=t.id, time_spent_ms=t.time_spent_ms,
                       annotations=[S.AnnotationOut.model_validate(a) for a in sorted(t.annotations, key=lambda a: a.id)])
        for t in tasks
    ]


@router.get("/items/{item_id}/consensus", response_model=S.ConsensusOut)
def consensus(
    item_id: int,
    threshold: float | None = Query(None, ge=0.05, le=1.0, description="Override the match threshold for every tool"),
    _: User = Depends(can_review),
    db: Session = Depends(get_db),
):
    item = get_item(db, item_id)
    sets = annotator_sets(db, item)
    data = {s.user.id: [ann_dict(a) for a in s.annotations] for s in sets}
    thr = None
    if threshold is not None:
        thr = {k: threshold for k in ("bbox", "polygon", "segment", "track", "span", "point")}
    result = item_consensus(item.project.schema, data, thr)
    return S.ConsensusOut(item_id=item.id, annotators=sets, tools=result["tools"],
                          classifications=result["classifications"], per_annotator=result["per_annotator"], score=result["score"])
