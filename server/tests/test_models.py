import re
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError, StatementError

from app.db.models import (
    Assignment,
    RepeatRow,
    ExportJob,
    Form,
    FormVersion,
    Submission,
    User,
)

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def user(db):
    u = User(username="asha1", password_hash="x", role="enumerator", full_name="Test")
    db.add(u)
    db.commit()
    return u


@pytest.fixture
def form(db, user):
    f = Form(form_id="anaemia", title="Anaemia survey", created_by=user.id)
    db.add(f)
    db.commit()
    return f


def _version(form, number, user):
    return dict(
        form_id=form.id,
        version=number,
        xlsform_blob=b"x",
        xform_xml="<x/>",
        json_spec={},
        published_by=user.id,
    )


def test_submission_uuid_is_unique(db, form, user):
    fv = FormVersion(**_version(form, "1", user), is_current=True)
    db.add(fv)
    db.commit()
    db.add(Submission(uuid="u1", form_version_id=fv.id, submitted_by=user.id, data_json={}))
    db.commit()
    db.add(Submission(uuid="u1", form_version_id=fv.id, submitted_by=user.id, data_json={}))
    with pytest.raises(IntegrityError):
        db.commit()


def test_submission_status_is_constrained(db, form, user):
    fv = FormVersion(**_version(form, "1", user))
    db.add(fv)
    db.commit()
    db.add(
        Submission(
            uuid="u2", form_version_id=fv.id, submitted_by=user.id,
            data_json={}, status="bogus",
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()


def test_export_status_is_constrained(db, form, user):
    db.add(ExportJob(form_id=form.id, requested_by=user.id, status="bogus"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_only_one_current_version_per_form(db, form, user):
    form.publish(FormVersion(**_version(form, "1", user)))
    db.commit()
    form.publish(FormVersion(**_version(form, "2", user)))
    db.commit()
    db.refresh(form)
    assert [v.version for v in form.versions if v.is_current] == ["2"]


def test_database_refuses_two_current_versions(db, form, user):
    db.add(FormVersion(**_version(form, "1", user), is_current=True))
    db.add(FormVersion(**_version(form, "2", user), is_current=True))
    with pytest.raises(IntegrityError):
        db.commit()


def test_timestamps_round_trip_as_utc_aware(db, user):
    db.expire_all()
    assert user.created_at.tzinfo is not None
    assert user.created_at.utcoffset().total_seconds() == 0


def test_naive_device_timestamp_is_stored_not_rejected(db, form, user):
    """Device clocks are untrusted data: a naive started_at must not lose the submission.
    Naive values are assumed UTC."""
    fv = FormVersion(**_version(form, "1", user))
    db.add(fv)
    db.commit()
    db.add(
        Submission(
            uuid="n1", form_version_id=fv.id, submitted_by=user.id, data_json={},
            started_at=datetime(2026, 10, 1, 9, 30), finished_at=datetime(2026, 10, 1, 9, 45),
        )
    )
    db.commit()
    db.expire_all()
    sub = db.query(Submission).filter_by(uuid="n1").one()
    assert sub.started_at == datetime(2026, 10, 1, 9, 30, tzinfo=UTC)
    assert sub.finished_at == datetime(2026, 10, 1, 9, 45, tzinfo=UTC)


def test_server_set_timestamp_rejects_naive_datetime(db):
    db.add(
        User(
            username="u", password_hash="x", role="admin", full_name="U",
            created_at=datetime(2026, 10, 1, 9, 30),
        )
    )
    with pytest.raises(StatementError, match="naive datetime"):
        db.commit()


def test_user_role_is_constrained(db):
    db.add(User(username="x", password_hash="x", role="enumerater", full_name="X"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_assignment_pair_is_unique(db, form, user):
    db.add(Assignment(user_id=user.id, form_id=form.id))
    db.commit()
    db.add(Assignment(user_id=user.id, form_id=form.id))
    with pytest.raises(IntegrityError):
        db.commit()


def test_form_version_number_is_unique_per_form(db, form, user):
    db.add(FormVersion(**_version(form, "1", user)))
    db.commit()
    db.add(FormVersion(**_version(form, "1", user)))
    with pytest.raises(IntegrityError):
        db.commit()


def test_retried_repeat_row_cannot_be_inserted_twice(db, form, user):
    fv = FormVersion(**_version(form, "1", user))
    db.add(fv)
    db.commit()
    sub = Submission(uuid="r1", form_version_id=fv.id, submitted_by=user.id, data_json={})
    db.add(sub)
    db.commit()
    db.add(RepeatRow(submission_id=sub.id, repeat_name="children", row_index=0, data_json={}))
    db.commit()
    db.add(RepeatRow(submission_id=sub.id, repeat_name="children", row_index=0, data_json={}))
    with pytest.raises(IntegrityError):
        db.commit()


def test_none_in_nullable_json_is_sql_null(db, form, user):
    """An assigned None and an omitted attribute must both be SQL NULL, so that
    `failures_json IS NULL` finds every row."""
    fv = FormVersion(**_version(form, "1", user))
    db.add(fv)
    db.commit()
    db.add(Submission(uuid="j1", form_version_id=fv.id, submitted_by=user.id,
                      data_json={}, failures_json=None))
    db.add(Submission(uuid="j2", form_version_id=fv.id, submitted_by=user.id, data_json={}))
    db.commit()
    nulls = db.query(Submission).filter(Submission.failures_json.is_(None)).count()
    assert nulls == 2


def test_audit_rows_are_never_mutated_by_the_api():
    """Append-only is enforced by discipline plus this test. SQLite cannot express a
    table-level grant, so the deployment adds one on PostgreSQL (see OPERATIONS.md)."""
    api = ROOT / "server" / "app" / "api"
    files = api.rglob("*.py") if api.is_dir() else []
    src = " ".join(p.read_text(encoding="utf-8") for p in files)
    assert "delete(AuditLog)" not in src
    assert "update(AuditLog)" not in src
    # delete of an audit row: session.delete(audit...) / db.delete(audit_row)
    assert not re.search(r"\.delete\(\s*audit", src, re.IGNORECASE)
    # attribute assignment on an audit row, but not a comparison (==, !=, <=, >=)
    assert not re.search(r"\baudit\w*\.\w+\s*=(?!=)", src, re.IGNORECASE)
