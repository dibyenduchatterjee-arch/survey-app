"""Supervisors can list users (slim) to pick project members; moving a form moves its access."""

import pytest

from app.core.security import create_access_token
from app.db.models import Assignment, Form, FormVersion, Project, ProjectMember


def _h(u):
    return {"Authorization": f"Bearer {create_access_token(u.id, u.role)}"}


@pytest.fixture
def w(client, db, user_factory):
    admin = user_factory(username="adm", role="admin", full_name="Admin")
    ps = {}
    for n in ("A", "B"):
        p = Project(name=n)
        db.add(p)
        ps[n] = p
    db.commit()
    return {"c": client, "db": db, "mk": user_factory, "admin": admin, "p": ps}


def test_a_supervisor_lists_users_with_only_four_fields(w):
    sup = w["mk"](username="sup", role="supervisor")
    w["mk"](username="enum", role="enumerator", full_name="Enu Merator")
    r = w["c"].get("/api/users", headers=_h(sup))
    assert r.status_code == 200
    assert all(set(u) == {"id", "username", "full_name", "role"} for u in r.json())
    assert {u["username"] for u in r.json()} == {"adm", "sup", "enum"}
    assert "hash" not in r.text and "phone" not in r.text


def test_the_admin_list_is_unchanged_and_enumerators_are_refused(w):
    r = w["c"].get("/api/users", headers=_h(w["admin"]))
    assert "created_at" in r.json()[0] and "is_active" in r.json()[0]
    e = w["mk"](username="enum", role="enumerator")
    assert w["c"].get("/api/users", headers=_h(e)).status_code == 403


def test_a_supervisor_still_cannot_create_or_change_users(w):
    sup = w["mk"](username="sup", role="supervisor")
    body = {"username": "x1", "password": "a long unusual passphrase", "role": "enumerator", "full_name": "X"}
    assert w["c"].post("/api/users", json=body, headers=_h(sup)).status_code == 403
    assert w["c"].patch(f"/api/users/{sup.id}", json={"role": "admin"}, headers=_h(sup)).status_code == 403


def test_a_supervisor_adds_and_removes_members_only_on_their_projects(w):
    sup = w["mk"](username="sup", role="supervisor")
    worker = w["mk"](username="worker", role="enumerator")
    w["db"].add(ProjectMember(project_id=w["p"]["A"].id, user_id=sup.id))
    w["db"].commit()
    c, h = w["c"], _h(sup)
    a, b = w["p"]["A"].id, w["p"]["B"].id
    assert c.post(f"/api/projects/{a}/members", json={"user_id": worker.id}, headers=h).status_code == 201
    assert c.delete(f"/api/projects/{a}/members/{worker.id}", headers=h).status_code == 204
    add_b = c.post(f"/api/projects/{b}/members", json={"user_id": worker.id}, headers=h)
    add_missing = c.post("/api/projects/9999/members", json={"user_id": worker.id}, headers=h)
    assert add_b.status_code == add_missing.status_code == 404 and add_b.json() == add_missing.json()
    del_b = c.delete(f"/api/projects/{b}/members/{worker.id}", headers=h)
    assert del_b.status_code == 404 and del_b.json() == add_b.json()
    assert c.get(f"/api/projects/{b}/members", headers=h).status_code == 404


# ---- moving a form moves its access --------------------------------------------------------


@pytest.fixture
def moved(w):
    db, admin = w["db"], w["admin"]
    f = Form(form_id="f1", title="F1", project_id=w["p"]["A"].id, created_by=admin.id)
    db.add(f)
    db.flush()
    db.add(FormVersion(form_id=f.id, version="2026103101", xlsform_blob=b"x", xform_xml="<x/>",
                       json_spec={"nodes": []}, published_by=admin.id, is_current=True,
                       published_at=admin.created_at))
    people = {}
    for name, role, proj in (
        ("src_enum", "enumerator", "A"), ("dst_enum", "enumerator", "B"),
        ("src_sup", "supervisor", "A"), ("dst_sup", "supervisor", "B"),
        ("both_enum", "enumerator", None),
    ):
        u = w["mk"](username=name, role=role)
        people[name] = u
        if proj:
            db.add(ProjectMember(project_id=w["p"][proj].id, user_id=u.id))
    db.add_all([ProjectMember(project_id=w["p"][n].id, user_id=people["both_enum"].id) for n in ("A", "B")])
    db.commit()
    w["people"] = people
    return w


def _sees(w, name):
    u = w["people"][name]
    listed = "f1" in [x["form_id"] for x in w["c"].get("/api/forms", headers=_h(u)).json()]
    spec = w["c"].get("/api/forms/f1/versions/2026103101/spec", headers=_h(u)).status_code
    assert listed == (spec == 200)
    return listed


ORDER = ("src_enum", "dst_enum", "src_sup", "dst_sup", "both_enum")


def test_moving_a_form_gives_access_to_the_destination_and_takes_it_from_the_source(moved):
    w = moved
    assert [_sees(w, n) for n in ORDER] == [True, False, True, False, True]
    r = w["c"].put(f"/api/projects/{w['p']['B'].id}/forms/f1", headers=_h(w["admin"]))
    assert r.status_code == 200
    assert [_sees(w, n) for n in ORDER] == [False, True, False, True, True]


def test_the_source_only_user_gets_the_ordinary_404_for_the_moved_form(moved):
    w = moved
    w["c"].put(f"/api/projects/{w['p']['B'].id}/forms/f1", headers=_h(w["admin"]))
    gone = w["c"].get("/api/forms/f1/versions/2026103101/spec", headers=_h(w["people"]["src_enum"]))
    nope = w["c"].get("/api/forms/zzz/versions/2026103101/spec", headers=_h(w["people"]["src_enum"]))
    assert gone.status_code == nope.status_code == 404 and gone.json() == nope.json()


def test_a_direct_per_form_assignment_is_kept_when_the_form_moves(moved):
    w = moved
    direct = w["mk"](username="direct", role="enumerator")
    w["people"]["direct"] = direct
    w["db"].add(Assignment(user_id=direct.id, form_id=w["db"].query(Form).one().id))
    w["db"].commit()
    w["c"].put(f"/api/projects/{w['p']['B'].id}/forms/f1", headers=_h(w["admin"]))
    assert _sees(w, "direct") is True  # an explicit per-form grant is not project membership


def test_taking_a_form_out_of_a_project_moves_its_access_to_the_default_project(moved):
    w = moved
    assert w["c"].delete(f"/api/projects/{w['p']['A'].id}/forms/f1", headers=_h(w["admin"])).status_code == 204
    assert [_sees(w, n) for n in ("src_enum", "src_sup", "dst_enum", "both_enum")] == [False, False, False, False]
    assert w["db"].query(Form).one().project_id != w["p"]["A"].id
