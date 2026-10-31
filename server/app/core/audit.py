"""Append-only audit trail.

Rows are only ever added here; nothing in the API updates or deletes them.
Secrets must never reach the table, so `detail` is scrubbed before it is stored.
"""

import re
from datetime import UTC, datetime
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.core.clientip import client_ip
from app.core.config import get_settings
from app.db.models import AuditLog

_SENSITIVE_KEY = re.compile(r"password|token|secret|key", re.IGNORECASE)


def _scrub(value: Any) -> Any:
    """A copy of `value` with every sensitive key dropped, at any depth."""
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items() if not _SENSITIVE_KEY.search(str(k))}
    if isinstance(value, (list, tuple)):
        return [_scrub(v) for v in value]
    return value


def record(
    db: Session,
    actor_id: int | None,
    action: str,
    object_type: str | None,
    object_id: int | str | None,
    request: Request,
    detail: dict[str, Any] | None = None,
) -> None:
    """Add one audit row to the caller's transaction (flushed, never committed).

    The IP is resolved with the same `client_ip` the login rate limiter uses, so the
    two records agree about who the caller was.
    """
    user_agent = request.headers.get("user-agent")
    db.add(
        AuditLog(
            at=datetime.now(UTC),
            actor_user_id=actor_id,
            action=action,
            object_type=object_type,
            object_id=None if object_id is None else str(object_id),
            ip=client_ip(request, get_settings())[:64],
            user_agent=user_agent[:500] if user_agent else None,
            detail_json=None if detail is None else _scrub(detail),
        )
    )
    db.flush()  # the caller owns the commit, so this row shares its transaction
