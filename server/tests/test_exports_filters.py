"""Export filters (Task 34): date range on received_at, a whole project, and the refusals.

Two setups: `local` (neither Drive nor a Sheet configured, the download is built here) and
`wired` from test_exports_api (fake Drive and Sheet). The same rules must hold on both.
"""

import csv
import io
import zipfile
from contextlib import contextmanager
from datetime import datetime

import pytest
from sqlalchemy import select

from app.api import exports
from app.core.config import get_settings
from app.core.security import create_access_token
from app.db.models import AuditLog, ExportJob, Form, FormVersion, Project, ProjectMember, Submission
from app.main import app
from test_exports_api import drive, sheets, spec, wired  # noqa: F401  (fixtures)

BOM = b"\xef\xbb\xbf"


def at(day: str, time: str = "12:00:00") -> datetime:
    return datetime.fromisoformat(f"{day}T{time}+00:00")


@pytest.fixture
def local(client, db, monkeypatch):
    """No Google at all: the job validates and counts, the download is built on request."""
    settings = get_settings()
    monkeypatch.setattr(settings, "google_service_account_file", None, raising=False)
    monkeypatch.setattr(settings, "drive_folder_id", None, raising=False)
    monkeypatch.setattr(settings, "google_sheet_id", None, raising=False)

    @contextmanager
    def session():
        yield db

    app.dependency_overrides[exports.get_job_session] = lambda: session
    return client


def _token(user):
    return {"Authorization": f"Bearer {create_access_token(user.id, user.role)}"}


@pytest.fixture
def world(db, spec, user_factory):  # noqa: F811
    """Project A (forms a1, a2), project B (form b1). A supervisor in A only, and an admin."""
    owner = user_factory(username="owner", role="admin")
    projects = {}
    forms = {}
    for pname, fids in (("Project A", ["a1", "a2"]), ("Project B", ["b1"])):
        p = Project(name=pname)
        db.add(p)
        db.flush()
        projects[pname[-1]] = p
        for fid in fids:
            f = Form(form_id=fid, title=fid.upper(), created_by=owner.id, project_id=p.id)
            db.add(f)
            db.flush()
            v = FormVersion(form_id=f.id, version="1", xlsform_blob=b"x", xform_xml="<x/>",
                            json_spec=spec, published_by=owner.id, is_current=True)
            db.add(v)
            db.flush()
            forms[fid] = v
    sup = user_factory(username="sup", role="supervisor")
    db.add(ProjectMember(project_id=projects["A"].id, user_id=sup.id))
    db.commit()
    return {"projects": projects, "forms": forms, "sup": _token(sup), "admin": _token(owner), "owner": owner}


def add_sub(db, world, form_id, uid, received, **kw):
    s = Submission(uuid=uid, form_version_id=world["forms"][form_id].id, submitted_by=world["owner"].id,
                   received_at=received, data_json={"asha_name": uid}, **kw)
    db.add(s)
    db.commit()
    return s


def uuids_in(csv_bytes: bytes) -> list[str]:
    assert csv_bytes.startswith(BOM)
    return [r["uuid"] for r in csv.DictReader(io.StringIO(csv_bytes.decode("utf-8-sig"), newline=""))]


def export(client, headers, **body):
    r = client.post("/api/exports", json=body, headers=headers)
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    return job_id, client.get(f"/api/exports/{job_id}", headers=headers).json()


def uid(n: int) -> str:
    return f"{n:08d}-0000-4000-8000-000000000000"


def main_csvs(z: zipfile.ZipFile, *form_ids: str) -> dict[str, bytes]:
    """The one-row-per-submission file of each form in a project bundle: `<form>_<stamp>.csv`."""
    out = {}
    for n in z.namelist():
        stem, _, rest = n.partition("_20")
        if stem in form_ids and n.endswith(".csv") and "_" not in rest:
            out[stem] = z.read(n)
    return out


# ---- date range --------------------------------------------------------------------------


def test_a_date_range_includes_both_boundary_days_and_excludes_the_days_outside(local, db, world):
    add_sub(db, world, "a1", uid(1), at("2026-10-04", "23:59:59"))  # just before
    add_sub(db, world, "a1", uid(2), at("2026-10-05", "00:00:00"))  # first instant of date_from
    add_sub(db, world, "a1", uid(3), at("2026-10-06"))
    add_sub(db, world, "a1", uid(4), at("2026-10-07", "23:59:59"))  # last second of date_to
    add_sub(db, world, "a1", uid(5), at("2026-10-08", "00:00:00"))  # first instant after
    job_id, job = export(local, world["sup"], form_id="a1", date_from="2026-10-05", date_to="2026-10-07")
    assert job["status"] == "done" and job["row_count"] == 3
    r = local.get(f"/api/exports/{job_id}/download", headers=world["sup"])
    assert sorted(uuids_in(r.content)) == [uid(2), uid(3), uid(4)]


def test_a_one_sided_range_and_a_single_day_work(local, db, world):
    for n, day in enumerate(["2026-10-01", "2026-10-02", "2026-10-03"], start=1):
        add_sub(db, world, "a1", uid(n), at(day))

    def run(**kw):
        job_id, _ = export(local, world["sup"], form_id="a1", **kw)
        return sorted(uuids_in(local.get(f"/api/exports/{job_id}/download", headers=world["sup"]).content))

    assert run(date_from="2026-10-02") == [uid(2), uid(3)]
    assert run(date_to="2026-10-02") == [uid(1), uid(2)]
    assert run(date_from="2026-10-02", date_to="2026-10-02") == [uid(2)]
    assert run() == [uid(1), uid(2), uid(3)]  # no dates: everything


def test_the_range_uses_the_servers_received_at_never_the_devices_clock(local, db, world):
    add_sub(db, world, "a1", uid(1), at("2026-10-20"), started_at=at("2026-10-05"), finished_at=at("2026-10-05"))
    add_sub(db, world, "a1", uid(2), at("2026-10-05"), started_at=at("2026-01-01"), finished_at=at("2026-01-01"))
    job_id, _ = export(local, world["sup"], form_id="a1", date_from="2026-10-05", date_to="2026-10-05")
    assert uuids_in(local.get(f"/api/exports/{job_id}/download", headers=world["sup"]).content) == [uid(2)]


def test_the_filter_also_applies_when_drive_holds_the_file(wired, db, world, drive):  # noqa: F811
    add_sub(db, world, "a1", uid(1), at("2026-10-05"))
    add_sub(db, world, "a1", uid(2), at("2026-11-05"))
    job_id, job = export(wired, world["sup"], form_id="a1", date_from="2026-10-01", date_to="2026-10-31")
    assert job["row_count"] == 1
    assert uuids_in(drive.created[0][1]) == [uid(1)]
    assert uuids_in(wired.get(f"/api/exports/{job_id}/download", headers=world["sup"]).content) == [uid(1)]


# ---- empty result ------------------------------------------------------------------------


def test_an_empty_range_gives_a_header_only_csv_and_says_so_plainly(local, db, world):
    add_sub(db, world, "a1", uid(1), at("2026-10-05"))
    job_id, job = export(local, world["sup"], form_id="a1", date_from="2027-01-01", date_to="2027-01-31")
    assert job["status"] == "done" and job["error"] is None and job["row_count"] == 0
    assert "No submissions" in job["message"] and "2027-01-01" in job["message"] and "2027-01-31" in job["message"]
    r = local.get(f"/api/exports/{job_id}/download", headers=world["sup"])
    assert r.status_code == 200 and r.content.startswith(BOM)
    lines = r.content.decode("utf-8-sig").strip().splitlines()
    assert len(lines) == 1 and lines[0].startswith("uuid,submitted_by,received_at")


def test_a_form_with_no_submissions_at_all_is_also_just_empty(local, world):
    _, job = export(local, world["sup"], form_id="a1")
    assert job["status"] == "done" and job["row_count"] == 0 and "No submissions" in job["message"]


def test_a_non_empty_export_has_no_empty_message(local, db, world):
    add_sub(db, world, "a1", uid(1), at("2026-10-05"))
    _, job = export(local, world["sup"], form_id="a1")
    assert job["row_count"] == 1 and job["message"] is None


# ---- project export ----------------------------------------------------------------------


def test_a_project_export_covers_every_form_in_the_project_and_nothing_else(local, db, world):
    add_sub(db, world, "a1", uid(1), at("2026-10-05"))
    add_sub(db, world, "a2", uid(2), at("2026-10-06"))
    add_sub(db, world, "a2", uid(3), at("2026-10-07"))
    add_sub(db, world, "b1", uid(9), at("2026-10-06"))  # another project
    pid = world["projects"]["A"].id
    job_id, job = export(local, world["sup"], project_id=pid)
    assert job["status"] == "done" and job["row_count"] == 3
    assert job["project_id"] == pid and job["project_name"] == "Project A" and job["form_id"] is None
    r = local.get(f"/api/exports/{job_id}/download", headers=world["sup"])
    assert r.headers["content-type"].startswith("application/zip")
    assert r.headers["content-disposition"].startswith('attachment; filename="Project_A_')
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert len(set(z.namelist())) == len(z.namelist())
    got = {k: uuids_in(v) for k, v in main_csvs(z, "a1", "a2").items()}
    assert got == {"a1": [uid(1)], "a2": [uid(2), uid(3)]}
    assert not any(n.startswith("b1") for n in z.namelist())


def test_a_project_export_respects_the_date_range_in_every_form(local, db, world):
    add_sub(db, world, "a1", uid(1), at("2026-10-05"))
    add_sub(db, world, "a1", uid(2), at("2026-12-05"))
    add_sub(db, world, "a2", uid(3), at("2026-10-06"))
    add_sub(db, world, "a2", uid(4), at("2026-09-06"))
    job_id, job = export(local, world["admin"], project_id=world["projects"]["A"].id,
                         date_from="2026-10-01", date_to="2026-10-31")
    assert job["row_count"] == 2
    z = zipfile.ZipFile(io.BytesIO(local.get(f"/api/exports/{job_id}/download", headers=world["admin"]).content))
    got = {k: uuids_in(v) for k, v in main_csvs(z, "a1", "a2").items()}
    assert got == {"a1": [uid(1)], "a2": [uid(3)]}


def test_a_project_export_puts_a_distinct_file_set_per_form_on_drive(wired, db, world, drive, sheets):  # noqa: F811
    add_sub(db, world, "a1", uid(1), at("2026-10-05"))
    add_sub(db, world, "a2", uid(2), at("2026-10-05"))
    add_sub(db, world, "b1", uid(3), at("2026-10-05"))
    _, job = export(wired, world["sup"], project_id=world["projects"]["A"].id)
    assert job["status"] == "done" and job["row_count"] == 2
    names = [b["name"] for b, _, _ in drive.created]
    assert len(set(names)) == len(names)
    for fid in ("a1", "a2"):
        assert any(n.startswith(f"{fid}_20") and n.endswith("Z.csv") for n in names)
        assert any(n.startswith(f"{fid}_children_20") for n in names)
    assert not any(n.startswith("b1") for n in names)
    assert sorted(c[2] for c in sheets.calls if c[0] == "clear") == ["'a1'", "'a2'"]


def test_a_project_export_downloads_a_zip_of_every_form_with_drive_configured_too(wired, db, world):  # noqa: F811
    add_sub(db, world, "a1", uid(1), at("2026-10-05"))
    add_sub(db, world, "a2", uid(2), at("2026-10-05"))
    job_id, _ = export(wired, world["sup"], project_id=world["projects"]["A"].id)
    r = wired.get(f"/api/exports/{job_id}/download", headers=world["sup"])
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(main_csvs(z, "a1", "a2")) == ["a1", "a2"]


def test_a_project_export_with_no_data_is_header_only_files_and_a_message(local, world):
    job_id, job = export(local, world["sup"], project_id=world["projects"]["A"].id,
                         date_from="2030-01-01", date_to="2030-01-02")
    assert job["row_count"] == 0 and "No submissions" in job["message"] and "Project A" in job["message"]
    z = zipfile.ZipFile(io.BytesIO(local.get(f"/api/exports/{job_id}/download", headers=world["sup"]).content))
    mains = main_csvs(z, "a1", "a2")
    assert sorted(mains) == ["a1", "a2"]
    assert all(len(v.decode("utf-8-sig").strip().splitlines()) == 1 for v in mains.values())


def test_a_project_export_includes_the_media_zip_when_there_is_media(local, db, world, tmp_path, monkeypatch):
    from app.core.crypto import encrypt_bytes
    from app.db.models import MediaFile

    s = add_sub(db, world, "a1", uid(1), at("2026-10-05"))
    root = tmp_path / "media"
    (root / uid(1)).mkdir(parents=True)
    (root / uid(1) / "0.jpg").write_bytes(encrypt_bytes(b"\xff\xd8\xffjpeg"))
    monkeypatch.setattr(get_settings(), "media_root", root)
    db.add(MediaFile(submission_id=s.id, question_name="photo", filename="p.jpg", content_type="image/jpeg",
                     size=7, storage_path=f"{uid(1)}/0.jpg", sha256="0" * 64))
    db.commit()
    job_id, _ = export(local, world["sup"], project_id=world["projects"]["A"].id)
    z = zipfile.ZipFile(io.BytesIO(local.get(f"/api/exports/{job_id}/download", headers=world["sup"]).content))
    media = [n for n in z.namelist() if "_media_" in n and n.endswith(".zip")]
    assert len(media) == 1 and zipfile.ZipFile(io.BytesIO(z.read(media[0]))).namelist() == [f"{uid(1)}_photo.jpg"]


# ---- validation --------------------------------------------------------------------------


def test_form_id_and_project_id_together_is_a_422_that_explains_why(local, world):
    r = local.post("/api/exports", json={"form_id": "a1", "project_id": world["projects"]["A"].id},
                   headers=world["sup"])
    assert r.status_code == 422
    text = str(r.json()["detail"])
    assert "form_id" in text and "project_id" in text and "not both" in text


def test_neither_form_nor_project_is_a_422(local, world):
    assert local.post("/api/exports", json={"date_from": "2026-10-01"}, headers=world["sup"]).status_code == 422


def test_a_date_to_before_date_from_is_a_422_and_leaves_no_job(local, db, world):
    r = local.post("/api/exports", json={"form_id": "a1", "date_from": "2026-10-08", "date_to": "2026-10-07"},
                   headers=world["sup"])
    assert r.status_code == 422 and "date_to" in str(r.json()["detail"])
    assert db.scalars(select(ExportJob)).all() == []


@pytest.mark.parametrize("bad", ["05/10/2026", "2026-13-01", "yesterday", 20261005, "2026-10-05T10:00:00", ""])
def test_dates_must_be_iso_yyyy_mm_dd(local, world, bad):
    for field in ("date_from", "date_to"):
        r = local.post("/api/exports", json={"form_id": "a1", field: bad}, headers=world["sup"])
        assert r.status_code == 422, (field, bad)


def test_unknown_fields_are_still_refused(local, world):
    assert local.post("/api/exports", json={"form_id": "a1", "since": "x"}, headers=world["sup"]).status_code == 422


# ---- authorisation -----------------------------------------------------------------------


def test_a_supervisor_cannot_export_another_projects_data_and_it_looks_like_a_missing_one(local, db, world):
    other = world["projects"]["B"].id
    missing = local.post("/api/exports", json={"project_id": 9999}, headers=world["sup"])
    refused = local.post("/api/exports", json={"project_id": other}, headers=world["sup"])
    assert missing.status_code == refused.status_code == 404
    assert missing.json() == refused.json()  # identical: no hint that project B exists
    # a form inside it is refused exactly like a form that does not exist
    f_missing = local.post("/api/exports", json={"form_id": "nope"}, headers=world["sup"])
    f_refused = local.post("/api/exports", json={"form_id": "b1"}, headers=world["sup"])
    assert f_missing.status_code == f_refused.status_code == 404 and f_missing.json() == f_refused.json()
    assert db.scalars(select(ExportJob)).all() == []


def test_a_supervisors_project_export_never_includes_another_projects_forms(local, db, world):
    add_sub(db, world, "b1", uid(9), at("2026-10-05"))
    _, job = export(local, world["sup"], project_id=world["projects"]["A"].id)
    assert job["row_count"] == 0


def test_a_supervisor_cannot_read_the_job_of_a_project_they_are_not_in(local, db, world):
    job_id, _ = export(local, world["admin"], project_id=world["projects"]["B"].id)
    assert local.get(f"/api/exports/{job_id}", headers=world["sup"]).status_code == 404
    assert local.get(f"/api/exports/{job_id}/download", headers=world["sup"]).status_code == 404
    assert local.get(f"/api/exports/{job_id}", headers=world["admin"]).status_code == 200


def test_an_admin_can_export_any_project(local, db, world):
    add_sub(db, world, "b1", uid(9), at("2026-10-05"))
    _, job = export(local, world["admin"], project_id=world["projects"]["B"].id)
    assert job["row_count"] == 1 and job["project_name"] == "Project B"


def test_an_enumerator_still_cannot_export_a_project(local, world, user_factory):
    e = user_factory(username="enum", role="enumerator")
    r = local.post("/api/exports", json={"project_id": world["projects"]["A"].id}, headers=_token(e))
    assert r.status_code == 403


# ---- what the job says about itself -----------------------------------------------------


def test_the_job_reports_what_it_covers(local, db, world):
    add_sub(db, world, "a1", uid(1), at("2026-10-05"))
    _, job = export(local, world["sup"], form_id="a1", date_from="2026-10-01", date_to="2026-10-31")
    assert job["form_id"] == "a1" and job["project_id"] is None and job["project_name"] is None
    assert job["date_from"] == "2026-10-01" and job["date_to"] == "2026-10-31"
    _, plain = export(local, world["sup"], form_id="a1")
    assert plain["date_from"] is None and plain["date_to"] is None


def test_the_audit_row_records_the_filters(local, db, world):
    pid = world["projects"]["A"].id
    export(local, world["sup"], project_id=pid, date_from="2026-10-01", date_to="2026-10-31")
    row = db.scalars(select(AuditLog).where(AuditLog.action == "export.start")).one()
    assert row.detail_json == {"project_id": pid, "date_from": "2026-10-01", "date_to": "2026-10-31"}


def test_a_single_form_download_name_carries_the_range(local, db, world):
    add_sub(db, world, "a1", uid(1), at("2026-10-05"))
    job_id, _ = export(local, world["sup"], form_id="a1", date_from="2026-10-01", date_to="2026-10-31")
    cd = local.get(f"/api/exports/{job_id}/download", headers=world["sup"]).headers["content-disposition"]
    assert "a1_2026-10-01_to_2026-10-31_" in cd and cd.endswith('.csv"')
