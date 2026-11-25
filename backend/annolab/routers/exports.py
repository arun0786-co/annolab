from __future__ import annotations

import json
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from .. import audit
from ..deps import can_review, get_db, get_project
from ..exporters import ExportError, export_coco, export_jsonl, export_yolo
from ..models import User

router = APIRouter(tags=["export"])


@router.get(
    "/projects/{project_id}/export",
    responses={200: {"content": {"application/json": {}, "application/zip": {}, "application/x-ndjson": {}}}},
)
def export(
    project_id: int,
    request: Request,
    format: Literal["coco", "yolo", "jsonl"] = "jsonl",
    status: Literal["done", "approved", "all"] = Query("done", description="done: items with submitted work"),
    annotator: str = Query("best", description="best (most agreeing annotator per item), all, or a user id"),
    user: User = Depends(can_review),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id)
    if annotator not in ("best", "all") and not annotator.isdigit():
        raise HTTPException(422, "annotator must be best, all or a user id")
    slug = re.sub(r"[^a-z0-9]+", "-", project.name.lower()).strip("-") or f"project-{project.id}"
    try:
        if format == "coco":
            body = json.dumps(export_coco(db, project, status, annotator)).encode()
            media, ext = "application/json", "json"
        elif format == "yolo":
            body = export_yolo(db, project, request.app.state.settings.media_dir, status, annotator)
            media, ext = "application/zip", "zip"
        else:
            body = export_jsonl(db, project, status, annotator).encode()
            media, ext = "application/x-ndjson", "jsonl"
    except ExportError as e:
        raise HTTPException(422, str(e)) from None
    audit.record(db, user.id, "project.export", "project", project.id, project.id,
                 {"format": format, "status": status, "annotator": annotator, "bytes": len(body)})
    db.commit()
    return Response(body, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{slug}-{format}.{ext}"'})
