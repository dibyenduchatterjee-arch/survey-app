from datetime import UTC, datetime, timedelta

import pytest

from app.core.audit import record
from app.db.models import AuditLog


class _Req:
    def __init__(self, xff=None, host="10.0.0.5", ua="TestAgent/1.0"):
        from starlette.datastructures import Headers

        raw = []
        if xff is not None:
            raw.append((b"x-forwarded-for", xff.encode()))
        if ua is not None:
            raw.append((b"user-agent", ua.encode()))
        self.headers = Headers(raw=raw)
        self.client = type("C", (), {"host": host})()


@pytest.fixture
def actor(user_factory):
    """The id of a real user: audit_log.actor_user_id is a foreign key."""
    return user_factory().id


@pytest.fixture
def request_stub():
    return _Req()


def test_audit_records_actor_action_ip_and_time(db, request_stub, actor):
    before = datetime.now(UTC) - timedelta(seconds=5)
    record(db, actor, "form.publish", "form_version", 9, request_stub)
    row = db.query(AuditLog).one()
    assert (row.actor_user_id, row.action, row.ip) == (actor, "form.publish", "10.0.0.5")
    assert (row.object_type, row.object_id, row.user_agent) == (
        "form_version",
        "9",
        "TestAgent/1.0",
    )
    assert row.detail_json is None
    at = row.at if row.at.tzinfo else row.at.replace(tzinfo=UTC)
    assert before <= at <= datetime.now(UTC) + timedelta(seconds=5)


def test_audit_detail_never_stores_a_password_or_token(db, request_stub, actor):
    detail = {"password": "x", "ok": True}
    record(db, actor, "auth.login", "user", actor, request_stub, detail=detail)
    stored = db.query(AuditLog).one().detail_json
    assert "password" not in stored
    assert stored == {"ok": True}


def test_redaction_is_case_insensitive_substring_and_recursive(db, request_stub, actor):
    detail = {
        "new_password": "a",
        "API_KEY": "b",
        "Refresh_Token": "c",
        "clientSecret": "d",
        "keep": 1,
        "nested": {"password": "e", "fine": 2, "deeper": [{"token": "f", "n": 3}]},
        "items": [{"secret": "g", "id": 4}, "plain", 5],
    }
    record(db, actor, "x.y", "user", actor, request_stub, detail=detail)
    stored = db.query(AuditLog).one().detail_json
    assert stored == {
        "keep": 1,
        "nested": {"fine": 2, "deeper": [{"n": 3}]},
        "items": [{"id": 4}, "plain", 5],
    }
    assert detail["new_password"] == "a"  # the caller's dict is not mutated


def test_ip_goes_through_client_ip_and_honours_forwarded_for(db, monkeypatch, actor):
    from app.core import audit
    from app.core.config import get_settings

    settings = get_settings().model_copy(update={"trust_proxy_headers": True})
    monkeypatch.setattr(audit, "get_settings", lambda: settings)
    record(db, actor, "a.b", "user", actor, _Req(xff="203.0.113.9"))
    assert db.query(AuditLog).one().ip == "203.0.113.9"


def test_actor_may_be_none_and_overlong_user_agent_is_truncated(db):
    record(db, None, "auth.login_failed", "user", None, _Req(ua="u" * 900))
    row = db.query(AuditLog).one()
    assert row.actor_user_id is None and row.object_id is None
    assert len(row.user_agent) == 500


def test_missing_user_agent_is_stored_as_null(db, actor):
    record(db, actor, "a.b", "user", actor, _Req(ua=None))
    assert db.query(AuditLog).one().user_agent is None
