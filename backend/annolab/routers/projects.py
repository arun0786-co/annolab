from __future__ import annotations

import shutil
import statistics
from collections import Counter, defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from .. import schemas as S
from ..consensus import project_agreement
from ..deps import admin_only, current_user, get_db, get_project, require
from ..labelschema import normalize_schema
from ..models import AuditEvent, Item, Project, Review, Task, User
from ..serialize import project_out, status_counts, user_brief
from ..services import project_sets

router = APIRouter(tags=["projects"])

def _agreement(db: Session, p: Project) -> float | None:
    sets = project_sets(db, p.id)
    return project_agreement(p.schema, list(sets.values()))["mean_item_agreement"]

@router.get("/projects", response_model=list[S.ProjectOut], response_model_by_alias=True)
def list_projects(_: User = Depends(current_user), db: Session = Depends(get_db)):
    projects = db.scalars(select(Project).order_by(Project.id)).all()
    counts = status_counts(db, [p.id for p in projects])
    return [project_out(p, counts[p.id], _agreement(db, p)) for p in projects]

@router.post("/projects", response_model=S.ProjectOut, status_code=201, response_model_by_alias=True)
def create_project(body: S.ProjectIn, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    try:
        schema = normalize_schema(body.label_schema, body.modality)
    except ValueError as e:
        raise HTTPException(422, f"invalid schema: {e}") from None
    p = Project(name=body.name, description=body.description, modality=body.modality, schema=schema,
                annotators_per_item=body.annotators_per_item, review_required=body.review_required,
                instructions=body.instructions)
    db.add(p)
    db.flush()
    audit.record(db, admin.id, "project.create", "project", p.id, p.id, {"name": p.name, "modality": p.modality})
    db.commit()
    return project_out(p, {}, None)

@router.get("/projects/{project_id}", response_model=S.ProjectOut, response_model_by_alias=True)
def read_project(project_id: int, _: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_project(db, project_id)
    return project_out(p, status_counts(db, [p.id])[p.id], _agreement(db, p))

@router.patch("/projects/{project_id}", response_model=S.ProjectOut, response_model_by_alias=True)
def patch_project(project_id: int, body: S.ProjectPatch, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    p = get_project(db, project_id)
    changes = body.model_dump(exclude_none=True, by_alias=False)
    if "label_schema" in changes:
        try:
            new_schema = normalize_schema(changes.pop("label_schema"), p.modality)
        except ValueError as e:
            raise HTTPException(422, f"invalid schema: {e}") from None
        used = db.execute(
            select(Task.id).join(Item).where(Item.project_id == p.id).limit(1)
        ).first()
        if used:
            # Existing annotations must stay valid: keys and class values may be added, not removed.
            old_keys = _schema_values(p.schema)
            missing = old_keys - _schema_values(new_schema)
            if missing:
                raise HTTPException(409, "schema change would orphan existing labels: " + ", ".join(sorted(missing)))
        p.schema = new_schema
        changes["schema"] = "updated"
    for k, v in changes.items():
        if k != "schema":
            setattr(p, k, v)
    audit.record(db, admin.id, "project.update", "project", p.id, p.id, changes)
    db.commit()
    return project_out(p, status_counts(db, [p.id])[p.id], _agreement(db, p))

def _schema_values(schema: dict) -> set[str]:
    out = set()
    for t in schema.get("tools", []):
        out.add(f"{t['key']}:{t['type']}")
        out.update(f"{t['key']}/{c['value']}" for c in t["classes"])
    for c in schema.get("classifications", []):
        out.add(f"{c['key']}:{c['type']}")
        out.update(f"{c['key']}/{o}" for o in c.get("options", []))
    return out

@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: int, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    p = get_project(db, project_id)
    name = p.name
    db.delete(p)
    audit.record(db, admin.id, "project.delete", "project", project_id, project_id, {"name": name})
    db.commit()
    shutil.rmtree(request.app.state.settings.media_dir / str(project_id), ignore_errors=True)

@router.get("/projects/{project_id}/stats", response_model=S.StatsOut)
def project_stats(project_id: int, _: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_project(db, project_id)
    counts = status_counts(db, [p.id])[p.id]
    tasks = db.execute(
        select(Task.user_id, Task.status, Task.time_spent_ms, Task.submitted_at).join(Item).where(Item.project_id == p.id)
    ).all()
    task_counts = Counter(t.status for t in tasks)
    per_user: dict[int, dict] = defaultdict(lambda: {"submitted": 0, "skipped": 0, "secs": []})
    daily: Counter = Counter()
    for t in tasks:
        row = per_user[t.user_id]
        if t.status == "submitted":
            row["submitted"] += 1
            row["secs"].append((t.time_spent_ms or 0) / 1000)
            if t.submitted_at:
                daily[t.submitted_at.date().isoformat()] += 1
        elif t.status == "skipped":
            row["skipped"] += 1
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(list(per_user) or [0]))).all()}
    throughput = [
        S.ThroughputRow(
            user=user_brief(users[uid]), submitted=r["submitted"], skipped=r["skipped"],
            median_seconds=round(statistics.median(r["secs"]), 1) if r["secs"] else None,
            total_seconds=round(sum(r["secs"]), 1),
        )
        for uid, r in sorted(per_user.items())
    ]
    sets = project_sets(db, p.id)
    agreement = project_agreement(p.schema, list(sets.values()))
    dist: Counter = Counter()
    for by_user in sets.values():
        for anns in by_user.values():
            for a in anns:
                dist[(a["schema_key"], a["label"])] += 1
    reviews = Counter(
        d for (d,) in db.execute(select(Review.decision).join(Item).where(Item.project_id == p.id)).all()
    )
    return S.StatsOut(
        project_id=p.id,
        item_count=sum(counts.values()),
        status_counts=counts,
        task_counts=dict(task_counts),
        throughput=throughput,
        agreement=agreement,
        label_distribution=[S.LabelCount(schema_key=k, label=lab, count=n) for (k, lab), n in sorted(dist.items(), key=lambda kv: (kv[0][0], -kv[1], str(kv[0][1])))],
        daily=[S.DailyCount(date=d, submitted=n) for d, n in sorted(daily.items())],
        reviews=dict(reviews),
    )

@router.get("/projects/{project_id}/activity", response_model=S.Page[S.AuditOut])
def project_activity(
    project_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    action: str | None = None,
    _: User = Depends(require("admin", "reviewer")),
    db: Session = Depends(get_db),
):
    get_project(db, project_id)
    q = select(AuditEvent).where(AuditEvent.project_id == project_id)
    if action:
        q = q.where(AuditEvent.action.startswith(action))
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rows = db.scalars(q.order_by(AuditEvent.at.desc(), AuditEvent.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return S.Page[S.AuditOut](
        items=[S.AuditOut(id=e.id, user=user_brief(e.user) if e.user else None, action=e.action, entity=e.entity,
                          entity_id=e.entity_id, project_id=e.project_id, payload=e.payload, at=e.at) for e in rows],
        total=total, page=page, page_size=page_size,
    )
