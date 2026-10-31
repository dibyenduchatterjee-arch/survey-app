"""A supervisor sees only the forms in projects they are a member of; an admin sees all.

Real data throughout: two projects, two supervisors, one form each, with a submission, a
photograph and an export job. Nothing here overrides `staff_can_see_form`.
"""

import uuid as uuidlib
from contextlib import contextmanager
from pathlib import Path

import pytest

from app.api import exports
from app.core.config import get_settings
from app.core.crypto import encrypt_bytes
from app.core.security import create_access_token
from app.db.models import (
    Assignment, ExportJob, Form, FormVersion, MediaFile, Project, ProjectMember, Submission,
)
from app.export.drive import DriveUploader
from app.main import app
from test_drive import FakeDrive

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x07" * 64


def _h(u):
    return {"Authorization": f"Bearer {create_access_token(u.id, u.role)}"}


@pytest.fixture
def world(client, db, user_factory, tmp_path, monkeypatch):
    root = tmp_path / "m"
    root.mkdir()
    settings = get_settings()
    monkeypatch.setattr(settings, "media_root", root)
    monkeypatch.setattr(settings, "drive_folder_id", "FOLDER", raising=False)
    drive = FakeDrive()
    drive.created = [({"name": "a"}, b"a,b", "text/csv"), ({"name": "b"}, b"c,d", "text/csv")]

    @contextmanager
    def session():
        yield db  # the test owns the session; the background task must not close it

    app.dependency_overrides[exports.get_drive_uploader] = lambda: DriveUploader(drive, sleep=lambda s: None)
    app.dependency_overrides[exports.get_sheet_writer] = lambda: None
    app.dependency_overrides[exports.get_job_session] = lambda: session

    admin = user_factory(username="adm", role="admin")
    w = {"admin": admin, "client": client, "db": db}
    for tag in ("a", "b"):
        sup = user_factory(username=f"sup_{tag}", role="supervisor")
        p = Project(name=f"Project {tag}")
        db.add(p)
        db.flush()
        db.add(ProjectMember(project_id=p.id, user_id=sup.id))
        f = Form(form_id=f"form_{tag}", title=tag, project_id=p.id, created_by=admin.id)
        db.add(f)
        db.flush()
        v = FormVersion(form_id=f.id, version="2026103101", xlsform_blob=b"x", xform_xml="<x/>",
                        json_spec={"nodes": []}, published_by=admin.id, is_current=True,
                        published_at=admin.created_at)
        db.add(v)
        db.flush()
        uid = str(uuidlib.uuid4())
        s = Submission(uuid=uid, form_version_id=v.id, submitted_by=admin.id, data_json={"k": tag})
        db.add(s)
        db.flush()
        rel = f"{tag}.bin"
        (root / rel).write_bytes(encrypt_bytes(JPEG))
        db.add(MediaFile(submission_id=s.id, question_name="photo", filename="p.jpg",
                         content_type="image/jpeg", size=len(JPEG), storage_path=rel, sha256="0" * 64))
        job = ExportJob(form_id=f.id, requested_by=admin.id, status="done", drive_file_id=f"file-{len(w) - 2}")
        db.add(job)
        db.flush()
        w[tag] = {"sup": sup, "project": p, "form": f, "uuid": uid, "job": job.id}
    db.commit()
    yield w
    for dep in (exports.get_drive_uploader, exports.get_sheet_writer, exports.get_job_session):
        app.dependency_overrides.pop(dep, None)


def _same_as_missing(refused, missing):
    assert refused.status_code == missing.status_code == 404
    assert refused.json() == missing.json()


def test_forms_list_is_scoped_for_supervisors_and_whole_for_admin(world):
    c = world["client"]

    def ids(u):
        return [f["form_id"] for f in c.get("/api/forms", headers=_h(u)).json()]

    assert ids(world["a"]["sup"]) == ["form_a"]
    assert ids(world["b"]["sup"]) == ["form_b"]
    assert ids(world["admin"]) == ["form_a", "form_b"]


def test_submissions_list_is_scoped_even_when_a_foreign_form_is_asked_for_by_name(world):
    c = world["client"]
    h = _h(world["a"]["sup"])
    assert {i["form_id"] for i in c.get("/api/submissions", headers=h).json()["items"]} == {"form_a"}
    foreign = c.get("/api/submissions?form_id=form_b", headers=h).json()
    unknown = c.get("/api/submissions?form_id=nope", headers=h).json()
    assert foreign == unknown and foreign["total"] == 0
    assert c.get("/api/submissions", headers=_h(world["admin"])).json()["total"] == 2


@pytest.mark.parametrize("me,other", [("a", "b"), ("b", "a")])
def test_submission_detail_and_media_refused_for_the_other_project(world, me, other):
    c, h = world["client"], _h(world[me]["sup"])
    theirs = world[other]["uuid"]
    ghost = str(uuidlib.uuid4())
    _same_as_missing(c.get(f"/api/submissions/{theirs}", headers=h), c.get(f"/api/submissions/{ghost}", headers=h))
    _same_as_missing(
        c.get(f"/api/submissions/{theirs}/media/photo", headers=h),
        c.get(f"/api/submissions/{ghost}/media/photo", headers=h),
    )
    assert c.get(f"/api/submissions/{world[me]['uuid']}", headers=h).status_code == 200
    assert c.get(f"/api/submissions/{world[me]['uuid']}/media/photo", headers=h).content == JPEG


def test_admin_reaches_both_projects_submissions_and_media(world):
    c, h = world["client"], _h(world["admin"])
    for t in ("a", "b"):
        assert c.get(f"/api/submissions/{world[t]['uuid']}", headers=h).status_code == 200
        assert c.get(f"/api/submissions/{world[t]['uuid']}/media/photo", headers=h).content == JPEG


@pytest.mark.parametrize("me,other", [("a", "b"), ("b", "a")])
def test_exports_refused_for_the_other_project(world, me, other):
    c, h = world["client"], _h(world[me]["sup"])
    jobs_before = world["db"].query(ExportJob).count()
    ghost = 9999
    _same_as_missing(c.get(f"/api/exports/{world[other]['job']}", headers=h), c.get(f"/api/exports/{ghost}", headers=h))
    _same_as_missing(
        c.get(f"/api/exports/{world[other]['job']}/download", headers=h),
        c.get(f"/api/exports/{ghost}/download", headers=h),
    )
    _same_as_missing(
        c.post("/api/exports", json={"form_id": f"form_{other}"}, headers=h),
        c.post("/api/exports", json={"form_id": "nope"}, headers=h),
    )
    assert world["db"].query(ExportJob).count() == jobs_before  # the refusals created no job
    assert c.get(f"/api/exports/{world[me]['job']}", headers=h).status_code == 200
    assert c.get(f"/api/exports/{world[me]['job']}/download", headers=h).status_code != 404


def test_admin_reaches_both_exports(world):
    c, h = world["client"], _h(world["admin"])
    for t in ("a", "b"):
        assert c.get(f"/api/exports/{world[t]['job']}", headers=h).status_code == 200
        assert c.get(f"/api/exports/{world[t]['job']}/download", headers=h).status_code != 404
        assert c.post("/api/exports", json={"form_id": f"form_{t}"}, headers=h).status_code == 202


@pytest.mark.parametrize("me,other", [("a", "b"), ("b", "a")])
def test_publish_and_spec_refused_for_the_other_project(world, me, other):
    c, h = world["client"], _h(world[me]["sup"])
    _same_as_missing(
        c.post(f"/api/forms/form_{other}/publish", json={"version": "2026103101"}, headers=h),
        c.post("/api/forms/nope/publish", json={"version": "2026103101"}, headers=h),
    )
    _same_as_missing(
        c.get(f"/api/forms/form_{other}/versions/2026103101/spec", headers=h),
        c.get("/api/forms/nope/versions/2026103101/spec", headers=h),
    )
    assert c.get(f"/api/forms/form_{me}/versions/2026103101/spec", headers=h).status_code == 200
    assert c.post(f"/api/forms/form_{me}/publish", json={"version": "2026103101"}, headers=h).status_code == 200


def test_admin_publishes_and_reads_specs_in_any_project(world):
    c, h = world["client"], _h(world["admin"])
    for t in ("a", "b"):
        assert c.get(f"/api/forms/form_{t}/versions/2026103101/spec", headers=h).status_code == 200
        assert c.post(f"/api/forms/form_{t}/publish", json={"version": "2026103101"}, headers=h).status_code == 200


def test_a_supervisor_cannot_overwrite_another_projects_form_by_uploading_the_same_id(world, db):
    data = (Path(__file__).parent / "fixtures" / "amb_asha_visit.xlsx").read_bytes()
    admin = world["admin"]
    db.add(Form(form_id="amb_asha_visit", title="hidden", project_id=world["b"]["project"].id,
                created_by=admin.id))
    db.commit()
    c = world["client"]
    r = c.post("/api/forms", files={"file": ("f.xlsx", data, XLSX)}, headers=_h(world["a"]["sup"]))
    assert r.status_code == 404
    assert db.query(FormVersion).join(Form).filter(Form.form_id == "amb_asha_visit").count() == 0
    assert c.post(
        "/api/forms", files={"file": ("f.xlsx", data, XLSX)}, data={"project_id": world["b"]["project"].id},
        headers=_h(admin),
    ).status_code == 201


def test_assignments_list_hides_other_projects_forms_from_supervisors(world, db):
    admin = world["admin"]
    for t in ("a", "b"):
        db.add(Assignment(user_id=admin.id, form_id=world[t]["form"].id))
    db.commit()
    c = world["client"]
    got = c.get("/api/assignments", headers=_h(world["a"]["sup"])).json()
    assert {x["form_id"] for x in got} == {"form_a"}
    assert {x["form_id"] for x in c.get("/api/assignments", headers=_h(admin)).json()} == {"form_a", "form_b"}


@pytest.mark.parametrize("me,other", [("a", "b"), ("b", "a")])
def test_a_supervisor_cannot_manage_or_join_another_project(world, me, other):
    """Otherwise adding themselves as a member would undo every other rule."""
    c, db = world["client"], world["db"]
    sup, h = world[me]["sup"], _h(world[me]["sup"])
    pid = world[other]["project"].id
    _same_as_missing(c.get(f"/api/projects/{pid}", headers=h), c.get("/api/projects/9999", headers=h))
    _same_as_missing(c.get(f"/api/projects/{pid}/members", headers=h), c.get("/api/projects/9999/members", headers=h))
    _same_as_missing(
        c.post(f"/api/projects/{pid}/members", json={"user_id": sup.id}, headers=h),
        c.post("/api/projects/9999/members", json={"user_id": sup.id}, headers=h),
    )
    _same_as_missing(
        c.patch(f"/api/projects/{pid}", json={"name": "x"}, headers=h),
        c.patch("/api/projects/9999", json={"name": "x"}, headers=h),
    )
    assert db.query(ProjectMember).filter_by(project_id=pid, user_id=sup.id).count() == 0
    mine_p = world[me]["project"].id
    _same_as_missing(
        c.put(f"/api/projects/{pid}/forms/form_{me}", headers=h),
        c.put(f"/api/projects/9999/forms/form_{me}", headers=h),
    )
    _same_as_missing(
        c.put(f"/api/projects/{mine_p}/forms/form_{other}", headers=h),
        c.put(f"/api/projects/{mine_p}/forms/nope", headers=h),
    )
    _same_as_missing(
        c.delete(f"/api/projects/{pid}/members/{world[other]['sup'].id}", headers=h),
        c.delete("/api/projects/9999/members/1", headers=h),
    )
    assert db.get(Form, world[other]["form"].id).project_id == pid


def test_projects_list_is_scoped_and_admin_sees_all(world):
    c = world["client"]

    def names(u):
        return [p["name"] for p in c.get("/api/projects", headers=_h(u)).json()]

    assert names(world["a"]["sup"]) == ["Project a"]
    assert names(world["admin"]) == ["Project a", "Project b"]


def test_a_supervisor_who_creates_a_project_becomes_its_member(world):
    c, h = world["client"], _h(world["a"]["sup"])
    p = c.post("/api/projects", json={"name": "Mine"}, headers=h).json()
    assert c.get(f"/api/projects/{p['id']}", headers=h).status_code == 200


def test_removing_membership_takes_effect_on_the_next_request(world, db):
    c, h = world["client"], _h(world["a"]["sup"])
    assert c.get(f"/api/submissions/{world['a']['uuid']}", headers=h).status_code == 200
    db.query(ProjectMember).filter_by(user_id=world["a"]["sup"].id).delete()
    db.commit()
    assert c.get(f"/api/submissions/{world['a']['uuid']}", headers=h).status_code == 404
    assert c.get("/api/forms", headers=h).json() == []


def test_a_supervisors_new_form_lands_where_they_can_see_it(world, db):
    data = (Path(__file__).parent / "fixtures" / "amb_asha_visit.xlsx").read_bytes()
    c, sup = world["client"], world["a"]["sup"]
    assert c.post("/api/forms", files={"file": ("f.xlsx", data, XLSX)}, headers=_h(sup)).status_code == 201
    assert db.query(Form).filter_by(form_id="amb_asha_visit").one().project_id == world["a"]["project"].id
    assert "amb_asha_visit" not in [f["form_id"] for f in c.get("/api/forms", headers=_h(world["b"]["sup"])).json()]


# ---- every route that resolves a form, OpenRosa and intake included (review finding C-1) ----

PW = "correct-horse-battery"
VERSION = "2026103101"


def _basic(u):
    return (u.username, PW)


def _json_submit(client, form_id, **auth):
    import json

    sub = {"uuid": str(uuidlib.uuid4()), "form_id": form_id, "version": VERSION, "data": {}, "repeats": {}}
    return client.post("/api/submissions", files={"submission": (None, json.dumps(sub), "application/json")}, **auth)


def _openrosa_submit(client, form_id, **auth):
    xml = (
        f'<?xml version="1.0"?><data id="{form_id}" version="{VERSION}">'
        f"<meta><instanceID>uuid:{uuidlib.uuid4()}</instanceID></meta></data>"
    ).encode()
    return client.post("/openrosa/submission", files={"xml_submission_file": ("s.xml", xml, "text/xml")}, **auth)


def _stored(db):
    return db.query(Submission).count()


@pytest.mark.parametrize("me,other", [("a", "b"), ("b", "a")])
def test_openrosa_download_is_refused_for_the_other_project_exactly_like_a_missing_form(world, me, other):
    c, sup = world["client"], world[me]["sup"]
    refused = c.get(f"/openrosa/forms/form_{other}/{VERSION}.xml", auth=_basic(sup))
    missing = c.get(f"/openrosa/forms/form_nope/{VERSION}.xml", auth=_basic(sup))
    assert refused.status_code == missing.status_code == 404
    assert refused.text == missing.text
    assert "<x/>" not in refused.text
    assert c.get(f"/openrosa/forms/form_{me}/{VERSION}.xml", auth=_basic(sup)).status_code == 200


def test_openrosa_download_admin_reaches_every_project(world):
    c, adm = world["client"], world["admin"]
    for t in ("a", "b"):
        assert c.get(f"/openrosa/forms/form_{t}/{VERSION}.xml", auth=_basic(adm)).status_code == 200


@pytest.mark.parametrize("me,other", [("a", "b"), ("b", "a")])
def test_json_submission_into_another_projects_form_is_refused_like_a_missing_form(world, me, other):
    c, sup, db = world["client"], world[me]["sup"], world["db"]
    before = _stored(db)
    refused = _json_submit(c, f"form_{other}", headers=_h(sup))
    missing = _json_submit(c, "form_nope", headers=_h(sup))
    assert refused.status_code == missing.status_code == 404
    assert refused.json() == missing.json()
    assert _stored(db) == before
    assert _json_submit(c, f"form_{me}", headers=_h(sup)).status_code in (201, 202)


@pytest.mark.parametrize("me,other", [("a", "b"), ("b", "a")])
def test_openrosa_submission_into_another_projects_form_is_refused_like_a_missing_form(world, me, other):
    c, sup, db = world["client"], world[me]["sup"], world["db"]
    before = _stored(db)
    refused = _openrosa_submit(c, f"form_{other}", auth=_basic(sup))
    missing = _openrosa_submit(c, "form_nope", auth=_basic(sup))
    assert refused.status_code == missing.status_code == 404
    assert refused.text.replace(f"form_{other}", "X") == missing.text.replace("form_nope", "X")
    assert _stored(db) == before
    assert _openrosa_submit(c, f"form_{me}", auth=_basic(sup)).status_code in (201, 202)


def test_a_supervisor_who_lost_membership_can_no_longer_submit_or_download(world):
    c, db, sup = world["client"], world["db"], world["a"]["sup"]
    assert c.get(f"/openrosa/forms/form_a/{VERSION}.xml", auth=_basic(sup)).status_code == 200
    db.query(ProjectMember).filter_by(user_id=sup.id).delete()
    db.commit()
    assert c.get(f"/openrosa/forms/form_a/{VERSION}.xml", auth=_basic(sup)).status_code == 404
    assert _json_submit(c, "form_a", headers=_h(sup)).status_code == 404


def test_openrosa_form_list_is_scoped_for_supervisors(world):
    c = world["client"]
    for t in ("a", "b"):
        text = c.get("/openrosa/formList", auth=_basic(world[t]["sup"])).text
        assert f"<formID>form_{t}</formID>" in text
        assert f"<formID>form_{'b' if t == 'a' else 'a'}</formID>" not in text


def test_intake_itself_refuses_staff_without_access_even_when_called_directly(world):
    """Defence in depth: store_submission does not rely on its caller having resolved access."""
    from starlette.requests import Request

    from app.intake.submissions import IntakeRefused, store_submission

    db = world["db"]
    fv_b = db.query(FormVersion).filter_by(form_id=world["b"]["form"].id).one()
    req = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1)})
    with pytest.raises(IntakeRefused) as exc:
        store_submission(db, fv_b, world["a"]["sup"], {}, {}, {}, str(uuidlib.uuid4()), req)
    assert exc.value.status_code == 404
