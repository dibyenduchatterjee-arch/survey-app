import re
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError

from app.db.models import (
    AuditLog,
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


def test_audit_rows_are_never_mutated_by_the_api():
    """Append-only is enforced by discipline plus this test. SQLite cannot express a
    table-level grant, so the deployment adds one on PostgreSQL (see OPERATIONS.md)."""
    api = ROOT / "server" / "app" / "api"
    files = api.rglob("*.py") if api.is_dir() else []
    src = " ".join(p.read_text(encoding="utf-8") for p in files)
    assert "delete(AuditLog)" not in src
    assert not re.search(r"\baudit(_row|_log)?\.\w+\s*=", src)
    assert AuditLog.__tablename__ == "audit_log"
