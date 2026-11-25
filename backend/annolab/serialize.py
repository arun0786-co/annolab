"""ORM -> response model helpers."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import schemas as S
from .models import Item, Project, Review, Task, User

HIDDEN_META = ("truth",)


def public_meta(meta: dict[str, Any], user: User | None) -> dict[str, Any]:
    """Synthetic ground truth stays visible to admins only."""
    if user is not None and user.role == "admin":
        return dict(meta)
    return {k: v for k, v in meta.items() if k not in HIDDEN_META}


def item_out(item: Item, user: User | None, annotator_count: int | None = None) -> S.ItemOut:
    has_thumb = bool(item.meta.get("thumbnail"))
    return S.ItemOut(
        id=item.id,
        project_id=item.project_id,
        kind=item.kind,
        filename=item.filename,
        meta=public_meta(item.meta, user),
        status=item.status,
        created_at=item.created_at,
        annotator_count=annotator_count if annotator_count is not None else sum(1 for t in item.tasks if t.status == "submitted"),
        media_url=f"/api/items/{item.id}/media",
        thumbnail_url=f"/api/items/{item.id}/thumbnail" if has_thumb else None,
    )


def user_brief(u: User) -> S.UserBrief:
    return S.UserBrief.model_validate(u)


def review_out(r: Review) -> S.ReviewOut:
    return S.ReviewOut(
        id=r.id, item_id=r.item_id, reviewer=user_brief(r.reviewer), decision=r.decision, comment=r.comment,
        created_at=r.created_at, comments=[S.ReviewCommentOut.model_validate(c) for c in r.comments],
    )


def task_out(t: Task) -> S.TaskOut:
    return S.TaskOut(
        id=t.id, item_id=t.item_id, project_id=t.item.project_id, user_id=t.user_id, status=t.status,
        started_at=t.started_at, submitted_at=t.submitted_at, time_spent_ms=t.time_spent_ms,
    )


def task_detail(db: Session, t: Task, user: User) -> S.TaskDetail:
    reviews = db.scalars(select(Review).where(Review.item_id == t.item_id).order_by(Review.created_at.desc())).all()
    return S.TaskDetail(
        **task_out(t).model_dump(),
        item=item_out(t.item, user),
        annotations=[S.AnnotationOut.model_validate(a) for a in sorted(t.annotations, key=lambda a: a.id)],
        reviews=[review_out(r) for r in reviews],
    )


def status_counts(db: Session, project_ids: list[int]) -> dict[int, dict[str, int]]:
    rows = db.execute(
        select(Item.project_id, Item.status, func.count()).where(Item.project_id.in_(project_ids)).group_by(Item.project_id, Item.status)
    ).all()
    out: dict[int, dict[str, int]] = {pid: {} for pid in project_ids}
    for pid, status, n in rows:
        out[pid][status] = n
    return out


DONE = ("labeled", "in_review", "approved")


def project_out(p: Project, counts: dict[str, int], agreement: float | None) -> S.ProjectOut:
    total = sum(counts.values())
    done = sum(counts.get(s, 0) for s in DONE)
    return S.ProjectOut(
        id=p.id, name=p.name, description=p.description, modality=p.modality, label_schema=p.schema,
        annotators_per_item=p.annotators_per_item, review_required=p.review_required, instructions=p.instructions,
        created_at=p.created_at, item_count=total, status_counts=counts,
        progress=(done / total) if total else 0.0, agreement=agreement,
    )
