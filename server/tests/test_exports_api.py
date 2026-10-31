"""The export job API (Task 14): POST /api/exports, GET /api/exports/{id}, .../download.

Google is always a fake: DriveUploader and SheetWriter are built over the fake clients from
test_drive.py and injected through FastAPI dependency overrides. TestClient runs background
tasks before it returns, so a POST followed by a GET sees the finished job.
"""

import csv
import io
import logging
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import select

from app.api import exports
from app.core.config import get_settings
from app.core.security import create_access_token
from app.db.models import AuditLog, ExportJob, Form, FormVersion, RepeatRow, Submission
from app.export.csv_export import build_csvs
from app.export.drive import DriveUploader
from app.export.sheets import SheetWriter
from app.forms.compile import compile_spec
from app.forms.xlsform import to_xform
from app.main import app
from test_drive import FAKE_KEY, FakeDrive, FakeSheets, http_error

FIX = Path(__file__).parent / "fixtures"
U1 = "11111111-1111-4111-8111-111111111111"
U2 = "22222222-2222-4222-8222-222222222222"


@pytest.fixture(scope="module")
def spec():
    return compile_spec(to_xform((FIX / "amb_asha_visit.xlsx").read_bytes()))


@pytest.fixture
def as_(user_factory):
    def make(role):
        u = user_factory(username=role, role=role)
        return u, {"Authorization": f"Bearer {create_access_token(u.id, role)}"}

    return make


@pytest.fixture
def form(db, spec, user_factory):
    owner = user_factory(username="owner", role="admin")
    f = Form(form_id="amb_asha_visit", title="AMB", created_by=owner.id)
    db.add(f)
    db.commit()
    v = FormVersion(form_id=f.id, version="1", xlsform_blob=b"x", xform_xml="<x/>",
                    json_spec=spec, published_by=owner.id, is_current=True)
    db.add(v)
    db.commit()
    return v


@pytest.fixture
def submissions(db, form):
    out = []
    for uid, name in ((U1, "मुजफ्फरपुर की सुनीता"), (U2, "Rani")):
        s = Submission(uuid=uid, form_version_id=form.id, submitted_by=1,
                       data_json={"asha_name": name, "visit_location": "25.6 85.1 0 4"})
        db.add(s)
        db.flush()
        db.add(RepeatRow(submission_id=s.id, repeat_name="children", row_index=1, data_json={}))
        out.append(s)
    db.commit()
    return out


@pytest.fixture
def drive():
    return FakeDrive()


@pytest.fixture
def sheets():
    return FakeSheets()


@pytest.fixture
def wired(client, db, drive, sheets, monkeypatch):
    """Fake Google in place, configured settings, and the background task on the test session."""
    settings = get_settings()
    monkeypatch.setattr(settings, "drive_folder_id", "FOLDER", raising=False)
    monkeypatch.setattr(settings, "google_sheet_id", "SHEET", raising=False)

    @contextmanager
    def session():
        yield db  # the test owns the session; the task must not close it

    app.dependency_overrides[exports.get_drive_uploader] = lambda: DriveUploader(drive, sleep=lambda s: None)
    app.dependency_overrides[exports.get_sheet_writer] = lambda: SheetWriter(sheets, sleep=lambda s: None)
    app.dependency_overrides[exports.get_job_session] = lambda: session
    return client


def start(client, headers, form_id="amb_asha_visit"):
    return client.post("/api/exports", json={"form_id": form_id}, headers=headers)


# ---- happy path -----------------------------------------------------------------------


def test_export_runs_end_to_end_and_records_the_drive_file_id(wired, as_, form, submissions, drive, sheets, db, spec):
    _, h = as_("supervisor")
    r = start(wired, h)
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    assert set(r.json()) == {"job_id"}

    got = wired.get(f"/api/exports/{job_id}", headers=h).json()
    assert got["status"] == "done" and got["error"] is None
    assert got["drive_file_id"] == "file-1"  # the main CSV is uploaded first
    assert got["sheet_id"] == "SHEET" and got["row_count"] == 2
    assert got["form_id"] == "amb_asha_visit"

    names = [body["name"] for body, _, _ in drive.created]
    assert all(body["parents"] == ["FOLDER"] for body, _, _ in drive.created)
    assert names[0].startswith("amb_asha_visit_20") and names[0].endswith("Z.csv")
    assert any(n.startswith("amb_asha_visit_children_20") for n in names)
    assert any(n.startswith("amb_asha_visit_children_ifa_doses_20") for n in names)
    assert not any("media" in n for n in names)  # no photos, no empty zip
    assert not any("export_errors" in n for n in names)  # nothing malformed, so no report


def test_the_csv_bytes_reach_drive_exactly_as_built_bom_included(wired, as_, form, submissions, drive, db, spec):
    _, h = as_("admin")
    assert start(wired, h).status_code == 202
    expected = build_csvs(spec, submissions)["amb_asha_visit.csv"]
    (_, sent, mime) = drive.created[0]
    assert sent == expected and sent.startswith(b"\xef\xbb\xbf") and mime == "text/csv"
    assert "मुजफ्फरपुर की सुनीता" in sent.decode("utf-8-sig")


def test_the_sheet_gets_the_main_file_as_rows_in_a_tab_named_for_the_form(wired, as_, form, submissions, sheets):
    _, h = as_("supervisor")
    start(wired, h)
    assert [c[0] for c in sheets.calls] == ["clear", "update"]
    assert sheets.calls[0][2] == "'amb_asha_visit'"
    rows = sheets.calls[1][4]["values"]
    assert rows[0][:2] == ["uuid", "submitted_by"] and len(rows) == 3
    assert rows[1][0] == U1 and "मुजफ्फरपुर की सुनीता" in rows[1]
    assert not rows[0][0].startswith("﻿")  # the BOM belongs to the file, not the cells


def test_without_a_sheet_configured_only_drive_is_used(wired, as_, form, submissions, sheets, monkeypatch):
    monkeypatch.setattr(get_settings(), "google_sheet_id", None, raising=False)
    app.dependency_overrides[exports.get_sheet_writer] = lambda: None
    _, h = as_("supervisor")
    job = start(wired, h).json()["job_id"]
    got = wired.get(f"/api/exports/{job}", headers=h).json()
    assert got["status"] == "done" and got["sheet_id"] is None and sheets.calls == []


def test_a_malformed_geopoint_report_is_uploaded_alongside(wired, as_, form, submissions, drive, db):
    submissions[0].data_json = {"asha_name": "Rani", "visit_location": "somewhere"}
    db.commit()
    _, h = as_("supervisor")
    start(wired, h)
    errs = [(b["name"], d) for b, d, _ in drive.created if "export_errors" in b["name"]]
    assert len(errs) == 1 and errs[0][0].endswith(".txt") and U1.encode() in errs[0][1]


def test_media_is_zipped_and_uploaded_when_there_is_any(wired, as_, form, submissions, drive, db, tmp_path, monkeypatch):
    from app.core.crypto import encrypt_bytes
    from app.db.models import MediaFile

    root = tmp_path / "media"
    (root / U1).mkdir(parents=True)
    (root / U1 / "0.jpg").write_bytes(encrypt_bytes(b"\xff\xd8\xffjpeg"))
    monkeypatch.setattr(get_settings(), "media_root", root)
    db.add(MediaFile(submission_id=submissions[0].id, question_name="photo", filename="p.jpg",
                     content_type="image/jpeg", size=7, storage_path=f"{U1}/0.jpg", sha256="0" * 64))
    db.commit()
    _, h = as_("supervisor")
    start(wired, h)
    zips = [(b["name"], m) for b, _, m in drive.created if b["name"].endswith(".zip")]
    assert len(zips) == 1 and zips[0][0].startswith("amb_asha_visit_media_20") and zips[0][1] == "application/zip"


# ---- authorisation and validation -----------------------------------------------------


def test_an_enumerator_cannot_start_an_export(wired, as_, form):
    _, h = as_("enumerator")
    assert wired.post("/api/exports", json={"form_id": "x"}, headers=h).status_code == 403
    assert wired.post("/api/exports", json={"form_id": "amb_asha_visit"}, headers=h).status_code == 403


def test_an_enumerator_cannot_read_a_job_or_its_download(wired, as_, form, submissions):
    _, sh = as_("supervisor")
    job = start(wired, sh).json()["job_id"]
    _, eh = as_("enumerator")
    assert wired.get(f"/api/exports/{job}", headers=eh).status_code == 403
    assert wired.get(f"/api/exports/{job}/download", headers=eh).status_code == 403


def test_no_token_is_401(wired, form):
    assert wired.post("/api/exports", json={"form_id": "amb_asha_visit"}).status_code == 401
    assert wired.get("/api/exports/1").status_code == 401


def test_an_unknown_form_is_404_and_leaves_no_job(wired, as_, db):
    _, h = as_("supervisor")
    assert start(wired, h, "nope").status_code == 404
    assert db.scalars(select(ExportJob)).all() == []


@pytest.mark.parametrize("body", [{}, {"form_id": ""}, {"form_id": 5}, {"form_id": "a" * 200}])
def test_a_bad_body_is_422(wired, as_, body):
    _, h = as_("supervisor")
    assert wired.post("/api/exports", json=body, headers=h).status_code == 422


def test_an_unknown_job_is_404(wired, as_):
    _, h = as_("supervisor")
    assert wired.get("/api/exports/999", headers=h).status_code == 404
    assert wired.get("/api/exports/999/download", headers=h).status_code == 404


def test_a_form_with_no_version_fails_the_job_with_a_reason(wired, as_, db, user_factory):
    owner = user_factory(username="o2", role="admin")
    db.add(Form(form_id="empty_form", title="E", created_by=owner.id))
    db.commit()
    _, h = as_("supervisor")
    job = start(wired, h, "empty_form").json()["job_id"]
    got = wired.get(f"/api/exports/{job}", headers=h).json()
    assert got["status"] == "failed" and "version" in got["error"]


def test_unconfigured_google_is_a_loud_503_not_a_silent_no_op(client, as_, form, db, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "google_service_account_file", None, raising=False)
    monkeypatch.setattr(settings, "drive_folder_id", "FOLDER", raising=False)
    _, h = as_("supervisor")
    r = client.post("/api/exports", json={"form_id": "amb_asha_visit"}, headers=h)
    assert r.status_code == 503 and "GOOGLE_SERVICE_ACCOUNT_FILE" in r.json()["detail"]
    assert db.scalars(select(ExportJob)).all() == []


def test_a_missing_drive_folder_is_a_loud_503(wired, as_, form, monkeypatch):
    monkeypatch.setattr(get_settings(), "drive_folder_id", None, raising=False)
    _, h = as_("supervisor")
    r = start(wired, h)
    assert r.status_code == 503 and "DRIVE_FOLDER_ID" in r.json()["detail"]


# ---- failure ----------------------------------------------------------------------------


def test_a_permanent_403_marks_the_job_failed_with_the_reason(wired, as_, form, submissions, drive):
    drive.failures = [http_error(403, "The user does not have sufficient permissions for this file")]
    _, h = as_("supervisor")
    r = start(wired, h)
    assert r.status_code == 202  # accepted; the failure belongs to the job
    got = wired.get(f"/api/exports/{r.json()['job_id']}", headers=h).json()
    assert got["status"] == "failed"
    assert "403" in got["error"] and "sufficient permissions" in got["error"]
    assert got["drive_file_id"] is None


def test_a_failed_export_leaves_the_job_row_with_its_error_not_deleted(wired, as_, form, submissions, drive, db):
    drive.failures = [http_error(403, "nope")]
    _, h = as_("supervisor")
    job_id = start(wired, h).json()["job_id"]
    db.expire_all()
    row = db.get(ExportJob, job_id)
    assert row is not None and row.status == "failed" and "403" in row.error
    assert wired.get(f"/api/exports/{job_id}", headers=h).status_code == 200  # still readable


def test_an_unexpected_exception_is_recorded_too(wired, as_, form, submissions, drive, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("disk exploded")

    monkeypatch.setattr(exports, "build_csvs", boom)
    _, h = as_("supervisor")
    job_id = start(wired, h).json()["job_id"]
    got = wired.get(f"/api/exports/{job_id}", headers=h).json()
    assert got["status"] == "failed" and "disk exploded" in got["error"]


def test_a_sheet_failure_fails_the_job_but_keeps_the_drive_file_id(wired, as_, form, submissions, sheets):
    sheets.fail_update = http_error(404, "Requested entity was not found")
    _, h = as_("supervisor")
    got = wired.get(f"/api/exports/{start(wired, h).json()['job_id']}", headers=h).json()
    assert got["status"] == "failed" and "404" in got["error"] and "Sheet" in got["error"]
    assert got["drive_file_id"] == "file-1"  # the CSV did land; the user can still find it


def test_the_key_never_reaches_the_job_error_or_the_logs(wired, as_, form, submissions, drive, caplog):
    drive.failures = [http_error(403, f"leaked {FAKE_KEY}")]
    _, h = as_("supervisor")
    with caplog.at_level(logging.DEBUG):
        job_id = start(wired, h).json()["job_id"]
    got = wired.get(f"/api/exports/{job_id}", headers=h).json()
    assert "MIIEvQ" not in got["error"] and "PRIVATE KEY" not in got["error"]
    assert "private_key" not in caplog.text and "MIIEvQ" not in caplog.text


def test_status_moves_through_running_before_done(wired, as_, form, submissions, drive, db):
    seen = []
    real_create = drive.create

    def spying_create(**kw):
        seen.append(db.scalars(select(ExportJob.status)).one())
        return real_create(**kw)

    drive.create = spying_create
    _, h = as_("supervisor")
    start(wired, h)
    assert seen and set(seen) == {"running"}
    assert db.scalars(select(ExportJob.status)).one() == "done"


# ---- audit and download ---------------------------------------------------------------


def test_export_writes_an_audit_row(wired, as_, form, submissions, db):
    u, h = as_("supervisor")
    job_id = start(wired, h).json()["job_id"]
    row = db.scalars(select(AuditLog).where(AuditLog.action == "export.start")).one()
    assert row.actor_user_id == u.id and row.object_type == "export_job" and row.object_id == str(job_id)
    assert row.detail_json == {"form_id": "amb_asha_visit"}


def test_download_gives_the_drive_link_for_a_finished_job(wired, as_, form, submissions):
    _, h = as_("supervisor")
    job_id = start(wired, h).json()["job_id"]
    r = wired.get(f"/api/exports/{job_id}/download", headers=h)
    assert r.status_code == 200
    assert r.json() == {"drive_file_id": "file-1", "url": "https://drive.google.com/file/d/file-1/view"}


def test_download_of_a_failed_job_is_409_with_the_reason(wired, as_, form, submissions, drive):
    drive.failures = [http_error(403, "nope")]
    _, h = as_("supervisor")
    job_id = start(wired, h).json()["job_id"]
    r = wired.get(f"/api/exports/{job_id}/download", headers=h)
    assert r.status_code == 409 and "403" in r.json()["detail"]


def test_the_background_task_stamps_a_utc_aware_requested_at(wired, as_, form, submissions, db):
    _, h = as_("supervisor")
    job_id = start(wired, h).json()["job_id"]
    ts = wired.get(f"/api/exports/{job_id}", headers=h).json()["requested_at"]
    assert ts.endswith("Z") or "+00:00" in ts


def test_csv_rows_round_trip_through_the_sheet_unchanged(wired, as_, form, submissions, sheets, drive):
    _, h = as_("supervisor")
    start(wired, h)
    sent = drive.created[0][1].decode("utf-8-sig")
    assert sheets.calls[1][4]["values"] == list(csv.reader(io.StringIO(sent, newline="")))
