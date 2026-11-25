"""Workflow logic shared by the API and the seed script: queue, tasks, reviews."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from . import audit
from .labelschema import validate_annotation
from .models import Annotation, Item, Project, Review, ReviewComment, Task, User, utcnow

OPEN = ("assigned", "in_progress")
COUNTED = ("assigned", "in_progress", "submitted")
QUEUEABLE_ITEM = ("unlabeled", "in_progress")
# An assigned task that was never saved gives its slot back after this long.
LEASE = timedelta(hours=2)


class WorkflowError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def refresh_item_status(db: Session, item: Item) -> str:
    """Derive the item status from its tasks and latest review."""
    project = item.project
    tasks = db.scalars(select(Task).where(Task.item_id == item.id)).all()
    submitted = [t for t in tasks if t.status == "submitted"]
    active = [t for t in tasks if t.status in OPEN]
    last_review = db.scalars(
        select(Review).where(Review.item_id == item.id).order_by(Review.created_at.desc(), Review.id.desc()).limit(1)
    ).first()
    last_submit = max((t.submitted_at for t in submitted if t.submitted_at), default=None)

    if last_review and last_review.decision == "reject" and active:
        status = "rejected"
    elif last_review and last_submit and last_review.created_at >= last_submit and not active:
        status = "approved" if last_review.decision == "approve" else "rejected"
    elif len(submitted) >= project.annotators_per_item and not active:
        status = "in_review" if project.review_required else "labeled"
    elif submitted or active:
        status = "in_progress"
    else:
        status = "unlabeled"
    item.status = status
    return status


def next_task(db: Session, project: Project, user: User, now: datetime | None = None) -> Task | None:
    """Return the user's open task in the project, or assign a new item.

    Must run inside one write transaction (the engine issues BEGIN IMMEDIATE),
    so the capacity check and the insert cannot interleave with another
    request. The unique (item_id, user_id) constraint is a second guard.
    """
    open_task = db.scalars(
        select(Task)
        .join(Item, Item.id == Task.item_id)
        .where(Item.project_id == project.id, Task.user_id == user.id, Task.status.in_(OPEN))
        .order_by((Item.status == "rejected").desc(), Task.started_at, Task.id)
        .limit(1)
    ).first()
    if open_task:
        return open_task

    release_stale(db, project, now or utcnow())
    counted = (
        select(Task.item_id, func.count().label("n"))
        .where(Task.status.in_(COUNTED))
        .group_by(Task.item_id)
        .subquery()
    )
    mine = select(Task.item_id).where(Task.user_id == user.id)
    n = func.coalesce(counted.c.n, 0)
    item = db.scalars(
        select(Item)
        .outerjoin(counted, counted.c.item_id == Item.id)
        .where(
            Item.project_id == project.id,
            Item.status.in_(QUEUEABLE_ITEM),
            Item.id.not_in(mine),
            n < project.annotators_per_item,
        )
        # Finish items that others started before opening fresh ones.
        .order_by(n.desc(), Item.id)
        .limit(1)
    ).first()
    if item is None:
        return None
    task = Task(item_id=item.id, user_id=user.id, status="assigned", started_at=now or utcnow())
    db.add(task)
    db.flush()
    item.project = project
    refresh_item_status(db, item)
    audit.record(db, user.id, "task.assign", "task", task.id, project.id, {"item_id": item.id}, at=now)
    return task


def release_stale(db: Session, project: Project, now: datetime) -> int:
    """Drop assigned-but-never-saved tasks older than LEASE so their items can be served again."""
    stale = db.scalars(
        select(Task)
        .join(Item, Item.id == Task.item_id)
        .where(Item.project_id == project.id, Task.status == "assigned", Task.started_at < now - LEASE)
    ).all()
    for task in stale:
        item = task.item
        audit.record(db, task.user_id, "task.expire", "task", task.id, project.id, {"item_id": item.id}, at=now)
        db.delete(task)
        db.flush()
        db.expire(item, ["tasks"])
        refresh_item_status(db, item)
    return len(stale)


def replace_annotations(
    db: Session, task: Task, payload: list[dict[str, Any]], time_spent_ms: int | None = None, now: datetime | None = None
) -> list[Annotation]:
    """Replace the task's annotation set. Entries with a known id keep that id."""
    if task.status == "submitted":
        raise WorkflowError(409, "task already submitted")
    if task.status == "skipped":
        raise WorkflowError(409, "task was skipped")
    schema = task.item.project.schema
    cleaned = []
    for i, raw in enumerate(payload):
        try:
            c = validate_annotation(schema, raw)
        except ValueError as e:
            raise WorkflowError(422, f"annotation {i}: {e}") from None
        c["id"] = raw.get("id")
        c["source"] = raw.get("source") or "human"
        if c["source"] not in ("human", "model"):
            raise WorkflowError(422, f"annotation {i}: source must be human or model")
        cleaned.append(c)

    existing = {a.id: a for a in task.annotations}
    keep: set[int] = set()
    result = []
    ts = now or utcnow()
    for c in cleaned:
        ann = existing.get(c["id"]) if c["id"] is not None else None
        if ann is None:
            ann = Annotation(task_id=task.id, item_id=task.item_id, user_id=task.user_id, created_at=ts)
            db.add(ann)
            task.annotations.append(ann)
        else:
            keep.add(ann.id)
        changed = (ann.schema_key, ann.label, ann.geometry, ann.attributes, ann.source) != (
            c["schema_key"], c["label"], c["geometry"], c["attributes"], c["source"])
        ann.schema_key = c["schema_key"]
        ann.label = c["label"]
        ann.geometry = c["geometry"]
        ann.attributes = c["attributes"]
        ann.source = c["source"]
        if changed:
            ann.updated_at = ts
        result.append(ann)
    for aid, ann in existing.items():
        if aid not in keep:
            task.annotations.remove(ann)
            db.delete(ann)
    if task.status == "assigned":
        task.status = "in_progress"
    if time_spent_ms is not None:
        task.time_spent_ms = max(task.time_spent_ms or 0, int(time_spent_ms))
    db.flush()
    return result


def submit_task(db: Session, task: Task, now: datetime | None = None) -> Task:
    if task.status == "submitted":
        raise WorkflowError(409, "task already submitted")
    if task.status == "skipped":
        raise WorkflowError(409, "task was skipped")
    task.status = "submitted"
    task.submitted_at = now or utcnow()
    db.flush()
    item = task.item
    refresh_item_status(db, item)
    audit.record(db, task.user_id, "task.submit", "task", task.id, item.project_id,
                 {"item_id": item.id, "annotations": len(task.annotations), "time_spent_ms": task.time_spent_ms}, at=now)
    return task


def skip_task(db: Session, task: Task, reason: str = "", now: datetime | None = None) -> Task:
    if task.status not in OPEN:
        raise WorkflowError(409, f"cannot skip a {task.status} task")
    task.status = "skipped"
    for ann in list(task.annotations):
        task.annotations.remove(ann)
        db.delete(ann)
    db.flush()
    refresh_item_status(db, task.item)
    audit.record(db, task.user_id, "task.skip", "task", task.id, task.item.project_id,
                 {"item_id": task.item_id, "reason": reason}, at=now)
    return task


def create_review(
    db: Session,
    item: Item,
    reviewer: User,
    decision: str,
    comment: str = "",
    comments: list[dict[str, Any]] | None = None,
    reopen_user_ids: list[int] | None = None,
    now: datetime | None = None,
) -> Review:
    if decision not in ("approve", "reject"):
        raise WorkflowError(422, "decision must be approve or reject")
    tasks = db.scalars(select(Task).where(Task.item_id == item.id)).all()
    submitted = [t for t in tasks if t.status == "submitted"]
    if not submitted:
        raise WorkflowError(409, "item has no submitted work to review")
    if any(t.status in OPEN for t in tasks):
        raise WorkflowError(409, "item still has open tasks")
    ann_ids = {a.id: a for t in submitted for a in t.annotations}
    review = Review(item_id=item.id, reviewer_id=reviewer.id, decision=decision, comment=comment or "",
                    created_at=now or utcnow())
    db.add(review)
    pinned_users: set[int] = set()
    for c in comments or []:
        aid = c.get("annotation_id")
        if aid is not None:
            if aid not in ann_ids:
                raise WorkflowError(422, f"annotation {aid} does not belong to this item")
            pinned_users.add(ann_ids[aid].user_id)
        if not (c.get("body") or "").strip():
            raise WorkflowError(422, "comment body is empty")
        review.comments.append(ReviewComment(
            annotation_id=aid, body=c["body"].strip(), x=c.get("x"), y=c.get("y"), t=c.get("t")))
    db.flush()
    reopened = []
    if decision == "reject":
        targets = set(reopen_user_ids or []) or pinned_users or {t.user_id for t in submitted}
        for t in submitted:
            if t.user_id in targets:
                t.status = "in_progress"
                reopened.append(t.user_id)
        db.flush()
    refresh_item_status(db, item)
    audit.record(db, reviewer.id, f"review.{decision}", "item", item.id, item.project_id,
                 {"review_id": review.id, "comments": len(review.comments), "reopened": reopened}, at=now)
    return review


def annotation_sets(db: Session, item_id: int, submitted_only: bool = True) -> dict[int, list[Annotation]]:
    q = select(Task).where(Task.item_id == item_id)
    if submitted_only:
        q = q.where(Task.status == "submitted")
    out: dict[int, list[Annotation]] = {}
    for t in db.scalars(q).all():
        out[t.user_id] = list(t.annotations)
    return out


def ann_dict(a: Annotation) -> dict[str, Any]:
    return {"id": a.id, "user_id": a.user_id, "schema_key": a.schema_key, "label": a.label,
            "geometry": a.geometry, "attributes": a.attributes, "source": a.source}


def project_sets(db: Session, project_id: int) -> dict[int, dict[int, list[dict[str, Any]]]]:
    """item id -> annotator id -> annotation dicts, submitted tasks only."""
    rows = db.execute(
        select(Task.item_id, Task.user_id, Annotation)
        .join(Item, Item.id == Task.item_id)
        .outerjoin(Annotation, and_(Annotation.task_id == Task.id))
        .where(Item.project_id == project_id, Task.status == "submitted")
    ).all()
    out: dict[int, dict[int, list[dict[str, Any]]]] = {}
    for item_id, user_id, ann in rows:
        lst = out.setdefault(item_id, {}).setdefault(user_id, [])
        if ann is not None:
            lst.append(ann_dict(ann))
    return out
