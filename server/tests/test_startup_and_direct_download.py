"""Stuck export jobs after a restart, and downloads that work before Google is configured."""

from contextlib import contextmanager

import pytest

from app.api import exports
from app.core.config import get_settings
from app.core.security import create_access_token
from app.db.models import ExportJob
from app.main import app, fail_orphaned_export_jobs
from test_exports_api import (  # noqa: F401  (fixtures)
    as_, drive, form, sheets, spec, start, submissions, wired,
)


def test_running_jobs_are_failed_on_startup_and_others_untouched(db, form, user_factory):
    u = user_factory(username="u", role="admin")
    rows = {s: ExportJob(form_id=form.form_id, requested_by=u.id, status=s) for s in ("pending", "running", "done", "failed")}
    rows["failed"].error = "earlier error"
    db.add_all(rows.values())
    db.commit()

    @contextmanager
    def session():
        yield db

    assert fail_orphaned_export_jobs(session) == 1
    for r in rows.values():
        db.refresh(r)
    assert rows["running"].status == "failed" and "restart" in rows["running"].error.lower()
    assert [rows[s].status for s in ("pending", "done", "failed")] == ["pending", "done", "failed"]
    assert rows["failed"].error == "earlier error"


def test_the_lifespan_runs_the_sweep(monkeypatch):
    from fastapi.testclient import TestClient

    calls = []
    monkeypatch.setattr("app.main.fail_orphaned_export_jobs", lambda *a, **k: calls.append(1) or 0)
    with TestClient(app):
        pass
    assert calls == [1]


@pytest.fixture
def no_google(wired, monkeypatch):
    """Drive is not configured: the real dependency raises, as it does with no key file."""
    settings = get_settings()
    monkeypatch.setattr(settings, "drive_folder_id", None, raising=False)
    monkeypatch.setattr(settings, "google_service_account_file", None, raising=False)
    monkeypatch.setattr(settings, "google_sheet_id", None, raising=False)
    app.dependency_overrides.pop(exports.get_drive_uploader)
    app.dependency_overrides.pop(exports.get_sheet_writer)
    return wired


def test_without_drive_an_export_is_built_and_downloaded_from_the_server(no_google, as_, form, submissions):
    _, h = as_("supervisor")
    r = start(no_google, h)
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    job = no_google.get(f"/api/exports/{job_id}", headers=h).json()
    assert job["status"] == "done" and job["drive_file_id"] is None and job["row_count"] == 2
    d = no_google.get(f"/api/exports/{job_id}/download", headers=h)
    assert d.status_code == 200
    assert d.content.startswith(b"\xef\xbb\xbf") and "मुजफ्फरपुर की सुनीता".encode() in d.content
    assert d.headers["content-type"] == "text/csv; charset=utf-8"
    assert d.headers["content-disposition"].startswith("attachment") and d.headers["content-disposition"].endswith('.csv"')


def test_direct_download_keeps_rbac_and_hides_other_projects(no_google, as_, form, submissions, user_factory):
    _, h = as_("supervisor")
    job_id = start(no_google, h).json()["job_id"]
    assert no_google.get(f"/api/exports/{job_id}/download").status_code == 401
    _, eh = as_("enumerator")
    assert no_google.get(f"/api/exports/{job_id}/download", headers=eh).status_code == 403
    outsider = user_factory(username="out", role="supervisor")  # in no project
    oh = {"Authorization": f"Bearer {create_access_token(outsider.id, 'supervisor')}"}
    r = no_google.get(f"/api/exports/{job_id}/download", headers=oh)
    missing = no_google.get("/api/exports/9999/download", headers=oh)
    assert r.status_code == 404 and r.json() == {"detail": "Export job not found"} == missing.json()


def test_with_drive_configured_the_download_still_comes_through_drive(wired, as_, form, submissions, drive):
    _, h = as_("supervisor")
    job_id = start(wired, h).json()["job_id"]
    r = wired.get(f"/api/exports/{job_id}/download", headers=h)
    assert r.status_code == 200 and r.content == drive.created[0][1] and r.content.startswith(b"\xef\xbb\xbf")
