"""Dataset export: COCO (json), YOLO (zip), JSONL (all modalities)."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .consensus import best_annotator, item_consensus
from .geometry import bounds, polygon_area
from .models import Item, Project, Review, Task, User
from .serialize import public_meta
from .services import ann_dict

SPATIAL = ("bbox", "polygon")


class ExportError(Exception):
    pass


def _items(db: Session, project: Project, status: str) -> list[Item]:
    q = select(Item).where(Item.project_id == project.id).order_by(Item.id)
    if status == "approved":
        q = q.where(Item.status == "approved")
    return list(db.scalars(q).all())


def _chosen_sets(db: Session, project: Project, item: Item, annotator: str) -> dict[int, list[dict[str, Any]]]:
    sets: dict[int, list[dict[str, Any]]] = {}
    for t in db.scalars(select(Task).where(Task.item_id == item.id, Task.status == "submitted")).all():
        sets[t.user_id] = [ann_dict(a) for a in t.annotations]
    if not sets or annotator == "all":
        return sets
    if annotator == "best":
        if len(sets) == 1:
            return sets
        uid = best_annotator(item_consensus(project.schema, sets))
        return {uid: sets[uid]}
    uid = int(annotator)
    return {uid: sets[uid]} if uid in sets else {}


def categories(project: Project) -> list[dict[str, Any]]:
    """One category per class value across the spatial tools, in schema order."""
    seen: dict[str, dict[str, Any]] = {}
    for tool in project.schema.get("tools", []):
        if tool["type"] not in SPATIAL:
            continue
        for c in tool["classes"]:
            if c["value"] not in seen:
                seen[c["value"]] = {"id": len(seen) + 1, "name": c["value"], "supercategory": tool["key"]}
    return list(seen.values())


def _tool_types(project: Project) -> dict[str, str]:
    return {t["key"]: t["type"] for t in project.schema.get("tools", [])}


def export_coco(db: Session, project: Project, status: str = "done", annotator: str = "best") -> dict[str, Any]:
    if project.modality != "image":
        raise ExportError("COCO export is for image projects; use jsonl")
    cats = categories(project)
    cat_id = {c["name"]: c["id"] for c in cats}
    types = _tool_types(project)
    images, anns = [], []
    for item in _items(db, project, status):
        sets = _chosen_sets(db, project, item, annotator)
        if not sets:
            continue
        images.append({"id": item.id, "file_name": item.filename,
                       "width": item.meta.get("width"), "height": item.meta.get("height")})
        for uid, lst in sets.items():
            for a in lst:
                kind = types.get(a["schema_key"])
                if kind not in SPATIAL or a["label"] not in cat_id:
                    continue
                x, y, w, h = bounds(kind, a["geometry"])
                if kind == "polygon":
                    pts = a["geometry"]["points"]
                    seg = [[c for p in pts for c in p]]
                    area = polygon_area(pts)
                else:
                    seg = [[x, y, x + w, y, x + w, y + h, x, y + h]]
                    area = w * h
                anns.append({
                    "id": len(anns) + 1, "image_id": item.id, "category_id": cat_id[a["label"]],
                    "bbox": [x, y, w, h], "area": area, "segmentation": seg, "iscrowd": 0,
                    "attributes": {**a["attributes"], "annotator_id": uid, "source": a["source"]},
                })
    return {
        "info": {"description": project.name, "version": "1.0"},
        "licenses": [],
        "images": images,
        "annotations": anns,
        "categories": cats,
    }


def export_yolo(db: Session, project: Project, media_root: Path, status: str = "done", annotator: str = "best") -> bytes:
    if project.modality != "image":
        raise ExportError("YOLO export is for image projects; use jsonl")
    cats = categories(project)
    index = {c["name"]: i for i, c in enumerate(cats)}
    types = _tool_types(project)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        names = "\n".join(f"  {i}: {c['name']}" for i, c in enumerate(cats))
        z.writestr("data.yaml", f"path: .\ntrain: images\nval: images\nnc: {len(cats)}\nnames:\n{names}\n")
        for item in _items(db, project, status):
            sets = _chosen_sets(db, project, item, annotator)
            if not sets:
                continue
            W, H = item.meta.get("width"), item.meta.get("height")
            if not W or not H:
                continue
            stem = f"{item.id:06d}_{Path(item.filename).stem}"
            lines = []
            for lst in sets.values():
                for a in lst:
                    kind = types.get(a["schema_key"])
                    if kind not in SPATIAL or a["label"] not in index:
                        continue
                    x, y, w, h = bounds(kind, a["geometry"])
                    x0, y0 = max(0.0, x), max(0.0, y)
                    x1, y1 = min(float(W), x + w), min(float(H), y + h)
                    if x1 <= x0 or y1 <= y0:
                        continue
                    lines.append(f"{index[a['label']]} {(x0 + x1) / 2 / W:.6f} {(y0 + y1) / 2 / H:.6f} {(x1 - x0) / W:.6f} {(y1 - y0) / H:.6f}")
            z.writestr(f"labels/{stem}.txt", "\n".join(lines) + ("\n" if lines else ""))
            src = media_root / item.media_path
            if src.exists():
                z.write(src, f"images/{stem}{Path(item.filename).suffix.lower()}")
    return buf.getvalue()


def export_jsonl(db: Session, project: Project, status: str = "done", annotator: str = "all") -> str:
    users = {u.id: u for u in db.scalars(select(User)).all()}
    lines = []
    for item in _items(db, project, status):
        sets = _chosen_sets(db, project, item, annotator)
        if not sets and status != "all":
            continue
        tasks = {t.user_id: t for t in db.scalars(select(Task).where(Task.item_id == item.id)).all()}
        all_sets = _chosen_sets(db, project, item, "all")
        score = item_consensus(project.schema, all_sets)["score"] if len(all_sets) >= 2 else None
        reviews = db.scalars(select(Review).where(Review.item_id == item.id).order_by(Review.created_at)).all()
        record = {
            "item": {"id": item.id, "filename": item.filename, "kind": item.kind, "status": item.status,
                     "meta": public_meta({k: v for k, v in item.meta.items() if k != "peaks"}, None)},
            "annotators": [
                {
                    "user_id": uid, "email": users[uid].email if uid in users else None,
                    "time_spent_ms": tasks[uid].time_spent_ms if uid in tasks else None,
                    "annotations": [{k: v for k, v in a.items() if k != "user_id"} for a in lst],
                }
                for uid, lst in sets.items()
            ],
            "consensus_score": score,
            "reviews": [
                {"decision": r.decision, "comment": r.comment, "reviewer_id": r.reviewer_id,
                 "created_at": r.created_at.isoformat(),
                 "comments": [{"annotation_id": c.annotation_id, "body": c.body, "x": c.x, "y": c.y, "t": c.t} for c in r.comments]}
                for r in reviews
            ],
        }
        lines.append(json.dumps(record, ensure_ascii=False))
    return "\n".join(lines) + ("\n" if lines else "")
