from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import schemas as S
from .. import services
from ..consensus import item_consensus
from ..deps import can_label, can_review, current_user, get_db, get_item, get_project, get_task
from ..models import Item, Review, Task, User
from ..serialize import item_out, review_out, task_detail, task_out
from ..services import WorkflowError, ann_dict
from .items import annotator_sets

router = APIRouter(tags=["labeling"])


def _wf(fn, *args, **kw):
    try:
        return fn(*args, **kw)
    except WorkflowError as e:
        raise HTTPException(e.status, e.detail) from None


@router.get("/projects/{project_id}/queue/next", response_model=S.TaskDetail,
            responses={204: {"description": "Nothing left for this user"}})
def queue_next(project_id: int, user: User = Depends(can_label), db: Session = Depends(get_db)):
    """The user's open task in this project, or a newly assigned one."""
    project = get_project(db, project_id)
    task = services.next_task(db, project, user)
    if task is None:
        db.rollback()
        return Response(status_code=204)
    db.commit()
    return task_detail(db, task, user)


@router.get("/tasks", response_model=list[S.TaskOut])
def my_tasks(
    project_id: int | None = None,
    status: str | None = None,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """The current user's tasks, newest first."""
    q = select(Task).join(Item).where(Task.user_id == user.id)
    if project_id is not None:
        q = q.where(Item.project_id == project_id)
    if status:
        q = q.where(Task.status.in_(status.split(",")))
    return [task_out(t) for t in db.scalars(q.order_by(Task.started_at.desc()).limit(500)).all()]


@router.get("/tasks/{task_id}", response_model=S.TaskDetail)
def read_task(task_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return task_detail(db, get_task(db, task_id, user), user)


def _own_task(db: Session, task_id: int, user: User) -> Task:
    task = get_task(db, task_id, user)
    if task.user_id != user.id:
        raise HTTPException(403, "only the assignee can change this task")
    return task


@router.put("/tasks/{task_id}/annotations", response_model=list[S.AnnotationOut])
def put_annotations(task_id: int, body: S.AnnotationsPut, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Replace the task's full annotation set (autosave). Send `id` to keep an annotation's identity."""
    task = _own_task(db, task_id, user)
    anns = _wf(services.replace_annotations, db, task, [a.model_dump() for a in body.annotations], body.time_spent_ms)
    db.commit()
    return anns


@router.post("/tasks/{task_id}/submit", response_model=S.TaskOut)
def submit(task_id: int, body: S.SubmitIn | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    task = _own_task(db, task_id, user)
    if body and body.annotations is not None:
        _wf(services.replace_annotations, db, task, [a.model_dump() for a in body.annotations], body.time_spent_ms)
    elif body and body.time_spent_ms is not None:
        task.time_spent_ms = max(task.time_spent_ms, body.time_spent_ms)
    _wf(services.submit_task, db, task)
    db.commit()
    return task_out(task)


@router.post("/tasks/{task_id}/skip", response_model=S.TaskOut)
def skip(task_id: int, body: S.SkipIn | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    task = _own_task(db, task_id, user)
    _wf(services.skip_task, db, task, body.reason if body else "")
    db.commit()
    return task_out(task)


def _review_item(db: Session, item: Item, user: User) -> S.ReviewItemOut:
    sets = annotator_sets(db, item)
    data = {s.user.id: [ann_dict(a) for a in s.annotations] for s in sets}
    score = item_consensus(item.project.schema, data)["score"] if len(data) >= 2 else None
    reviews = db.scalars(select(Review).where(Review.item_id == item.id).order_by(Review.created_at.desc())).all()
    return S.ReviewItemOut(item=item_out(item, user), annotators=sets, reviews=[review_out(r) for r in reviews], consensus_score=score)


@router.get("/projects/{project_id}/review/queue/next", response_model=S.ReviewItemOut,
            responses={204: {"description": "Nothing waiting for review"}})
def review_next(
    project_id: int,
    after: int | None = Query(None, description="Return the first waiting item with a larger id (to step past one)"),
    user: User = Depends(can_review),
    db: Session = Depends(get_db),
):
    """Oldest item waiting for review (status in_review; labeled items too when review is optional)."""
    project = get_project(db, project_id)
    statuses = ["in_review"] if project.review_required else ["in_review", "labeled"]
    q = select(Item).where(Item.project_id == project.id, Item.status.in_(statuses))
    if after is not None:
        q = q.where(Item.id > after)
    item = db.scalars(q.order_by(Item.id).limit(1)).first()
    if item is None:
        return Response(status_code=204)
    return _review_item(db, item, user)


@router.get("/items/{item_id}/review", response_model=S.ReviewItemOut)
def review_item(item_id: int, user: User = Depends(can_review), db: Session = Depends(get_db)):
    """Everything a reviewer needs for one item."""
    return _review_item(db, get_item(db, item_id), user)


@router.post("/items/{item_id}/reviews", response_model=S.ReviewOut, status_code=201)
def post_review(item_id: int, body: S.ReviewIn, user: User = Depends(can_review), db: Session = Depends(get_db)):
    item = get_item(db, item_id)
    review = _wf(services.create_review, db, item, user, body.decision, body.comment,
                 [c.model_dump() for c in body.comments], body.reopen_user_ids)
    db.commit()
    return review_out(review)


@router.post("/items/{item_id}/prelabel", response_model=S.PrelabelOut)
def prelabel(item_id: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Model proposals (source=model). Not stored: the editor adds the ones the annotator keeps."""
    from ..prelabel_service import propose

    item = get_item(db, item_id)
    try:
        method, proposals = propose(item, request.app.state.settings.media_dir)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    return S.PrelabelOut(item_id=item.id, method=method, proposals=proposals)
