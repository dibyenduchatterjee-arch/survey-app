"""Projects: a project holds 1..N forms; assigning a user to it grants every form in it."""

import pytest
from sqlalchemy import select

from app.core.security import create_access_token
from app.db.models import Assignment, AuditLog, Form, FormVersion, Project, ProjectMember
from app.intake.submissions import IntakeRefused, resolve_form_version


@pytest.fixture
def as_(user_factory):
    def make(role, username=None):
        u = user_factory(username=username or role, role=role)
        return u, {"Authorization": f"Bearer {create_access_token(u.id, role)}"}

    return make


@pytest.fixture
def adm(as_):
    return as_("admin")


def mkform(db, owner, key):
    f = Form(form_id=key, title=key.upper(), created_by=owner.id)
    db.add(f)
    db.flush()
    db.add(FormVersion(form_id=f.id, version="2026103101", xlsform_blob=b"x", xform_xml="<x/>",
                       json_spec={"nodes": []}, published_by=owner.id, is_current=True,
                       published_at=owner.created_at))
    db.commit()
    return f


def mkproject(client, h, name="Anaemia"):
    r = client.post("/api/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def test_a_form_with_no_project_lands_in_the_default_project(db, adm):
    a, _ = adm
    f = mkform(db, a, "f1")
    assert db.get(Project, f.project_id).name == "Default project"
    mkform(db, a, "f2")
    assert len(db.scalars(select(Project)).all()) == 1  # reused, not duplicated


def test_create_list_update(client, adm):
    _, h = adm
    p = mkproject(client, h)
    assert p["name"] == "Anaemia" and p["form_count"] == 0 and p["member_count"] == 0
    assert client.post("/api/projects", json={"name": "Anaemia"}, headers=h).status_code == 409
    assert client.post("/api/projects", json={"name": ""}, headers=h).status_code == 422
    r = client.patch(f"/api/projects/{p['id']}", json={"name": "Anaemia 2"}, headers=h)
    assert r.status_code == 200 and r.json()["name"] == "Anaemia 2"
    assert [x["name"] for x in client.get("/api/projects", headers=h).json()] == ["Anaemia 2"]
    assert client.patch("/api/projects/999", json={"name": "x"}, headers=h).status_code == 404


def test_supervisor_allowed_enumerator_refused(client, as_):
    _, sh = as_("supervisor")
    _, eh = as_("enumerator")
    assert client.post("/api/projects", json={"name": "P"}, headers=sh).status_code == 201
    assert client.get("/api/projects", headers=eh).status_code == 403
    assert client.post("/api/projects", json={"name": "Q"}, headers=eh).status_code == 403
    assert client.get("/api/projects").status_code == 401


def test_assigning_a_user_grants_every_form_including_later_ones(client, db, adm, as_):
    a, h = adm
    p = mkproject(client, h)
    mkform(db, a, "f1")
    mkform(db, a, "f2")
    for k in ("f1", "f2"):
        assert client.put(f"/api/projects/{p['id']}/forms/{k}", headers=h).status_code == 200
    e, eh = as_("enumerator")
    assert client.get("/api/forms", headers=eh).json() == []
    r = client.post(f"/api/projects/{p['id']}/members", json={"user_id": e.id}, headers=h)
    assert r.status_code == 201
    assert sorted(x["form_id"] for x in client.get("/api/forms", headers=eh).json()) == ["f1", "f2"]
    mkform(db, a, "f3")  # added later: granted with no further bookkeeping
    client.put(f"/api/projects/{p['id']}/forms/f3", headers=h)
    assert sorted(x["form_id"] for x in client.get("/api/forms", headers=eh).json()) == ["f1", "f2", "f3"]
    assert client.get("/api/forms/f3/versions/2026103101/spec", headers=eh).status_code == 200
    assert resolve_form_version(db, e, "f3", "2026103101").version == "2026103101"


def test_other_projects_forms_stay_hidden_and_intake_refuses(client, db, adm, as_):
    a, h = adm
    p = mkproject(client, h)
    mkform(db, a, "mine")
    mkform(db, a, "theirs")  # default project
    client.put(f"/api/projects/{p['id']}/forms/mine", headers=h)
    e, eh = as_("enumerator")
    client.post(f"/api/projects/{p['id']}/members", json={"user_id": e.id}, headers=h)
    assert [x["form_id"] for x in client.get("/api/forms", headers=eh).json()] == ["mine"]
    assert client.get("/api/forms/theirs/versions/2026103101/spec", headers=eh).status_code == 404
    with pytest.raises(IntakeRefused):
        resolve_form_version(db, e, "theirs", "2026103101")


def test_members_list_duplicate_and_remove(client, db, adm, as_):
    a, h = adm
    p = mkproject(client, h)
    e, eh = as_("enumerator")
    url = f"/api/projects/{p['id']}/members"
    assert client.post(url, json={"user_id": 999}, headers=h).status_code == 404
    assert client.post(url, json={"user_id": e.id}, headers=h).status_code == 201
    assert client.post(url, json={"user_id": e.id}, headers=h).status_code == 409
    m = client.get(url, headers=h).json()
    assert [(x["user_id"], x["username"]) for x in m] == [(e.id, "enumerator")]
    assert client.delete(f"{url}/{e.id}", headers=h).status_code == 204
    assert client.get(url, headers=h).json() == []
    assert client.delete(f"{url}/{e.id}", headers=h).status_code == 404
    assert db.scalars(select(ProjectMember)).all() == []
    acts = [x.action for x in db.scalars(select(AuditLog).order_by(AuditLog.id))]
    assert acts == ["project.create", "project.member_add", "project.member_remove"]


def test_moving_forms_between_projects_and_removal_goes_to_default(client, db, adm):
    a, h = adm
    p = mkproject(client, h)
    f = mkform(db, a, "f1")
    default_id = f.project_id
    assert client.put(f"/api/projects/{p['id']}/forms/f1", headers=h).status_code == 200
    db.refresh(f)
    assert f.project_id == p["id"]
    detail = client.get(f"/api/projects/{p['id']}", headers=h).json()
    assert [x["form_id"] for x in detail["forms"]] == ["f1"]
    assert client.delete(f"/api/projects/{p['id']}/forms/f1", headers=h).status_code == 204
    db.refresh(f)
    assert f.project_id == default_id  # still exactly one project
    assert client.delete(f"/api/projects/{p['id']}/forms/f1", headers=h).status_code == 404
    assert client.delete(f"/api/projects/{default_id}/forms/f1", headers=h).status_code == 409
    assert client.put(f"/api/projects/{p['id']}/forms/nope", headers=h).status_code == 404


def test_direct_per_form_assignment_still_works(client, db, adm, as_):
    a, h = adm
    f = mkform(db, a, "solo")
    e, eh = as_("enumerator")
    db.add(Assignment(user_id=e.id, form_id=f.id))
    db.commit()
    assert [x["form_id"] for x in client.get("/api/forms", headers=eh).json()] == ["solo"]
