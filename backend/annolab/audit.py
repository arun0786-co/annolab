from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from .models import AuditEvent, utcnow


def record(
    db: Session,
    user_id: int | None,
    action: str,
    entity: str,
    entity_id: int | None = None,
    project_id: int | None = None,
    payload: dict[str, Any] | None = None,
    at: datetime | None = None,
) -> AuditEvent:
    ev = AuditEvent(
        user_id=user_id,
        action=action,
        entity=entity,
        entity_id=entity_id,
        project_id=project_id,
        payload=payload or {},
        at=at or utcnow(),
    )
    db.add(ev)
    return ev
