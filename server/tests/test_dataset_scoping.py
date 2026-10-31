"""Datasets belong to a project (review finding I-4).

They carry village and ASHA lists - names and phone numbers of frontline workers - so a
dataset is readable only by people in its project, and writable only by staff in it.
"""

import pytest

from app.core.security import create_access_token
from app.db.models import (
    DEFAULT_PROJECT_NAME, Assignment, Dataset, Form, Project, ProjectMember,
)

CSV_A = "name,phone\nSunita,9000000001\n".encode()
CSV_B = "name,phone\nGeeta,9000000002\n".encode()


def _h(u):
    return {"Authorization": f"Bearer {create_access_token(u.id, u.role)}"}


def _put(client, user, name, data, **form):
    return client.post(f"/api/datasets/{name}", files={"file": ("d.csv", data)}, data=form, headers=_h(user))


@pytest.fixture
def world(client, db, user_factory):
    admin = user_factory(username="adm", role="admin")
    w = {"admin": admin, "client": client, "db": db}
    for tag in ("a", "b"):
        p = Project(name=f"Project {tag}")
        db.add(p)
        db.flush()
        sup = user_factory(username=f"sup_{tag}", role="supervisor")
        enum = user_factory(username=f"enum_{tag}", role="enumerator")
        db.add_all([ProjectMember(project_id=p.id, user_id=sup.id), ProjectMember(project_id=p.id, user_id=enum.id)])
        db.add(Form(form_id=f"form_{tag}", title=tag, project_id=p.id, created_by=admin.id))
        db.commit()
        w[tag] = {"project": p, "sup": sup, "enum": enum}
    w["outsider"] = user_factory(username="out", role="enumerator")
    w["assigned"] = user_factory(username="asg", role="enumerator")  # direct grant on form_b only
    db.add(Assignment(user_id=w["assigned"].id, form_id=db.query(Form).filter_by(form_id="form_b").one().id))
    db.commit()
    assert _put(client, w["a"]["sup"], "asha", CSV_A).status_code == 200
    assert _put(client, w["b"]["sup"], "asha_b", CSV_B).status_code == 200
    return w


def _get(client, user, project, name):
    pid = project.id if hasattr(project, "id") else project
    return client.get(f"/api/datasets/{pid}/{name}", headers=_h(user))


def _names(r):
    assert r.status_code == 200, r.text
    return sorted(d["name"] for d in r.json())


def test_listing_shows_each_person_only_their_projects_datasets(world):
    c = world["client"]
    assert _names(c.get("/api/datasets", headers=_h(world["a"]["sup"]))) == ["asha"]
    assert _names(c.get("/api/datasets", headers=_h(world["b"]["sup"]))) == ["asha_b"]
    assert _names(c.get("/api/datasets", headers=_h(world["a"]["enum"]))) == ["asha"]
    assert _names(c.get("/api/datasets", headers=_h(world["assigned"]))) == ["asha_b"]
    assert _names(c.get("/api/datasets", headers=_h(world["outsider"]))) == []
    assert _names(c.get("/api/datasets", headers=_h(world["admin"]))) == ["asha", "asha_b"]


@pytest.mark.parametrize("who", [("a", "sup"), ("a", "enum"), ("outsider", None), ("assigned", None)])
def test_reading_another_projects_dataset_is_the_same_404_as_a_missing_one(world, who):
    c = world["client"]
    user = world[who[0]][who[1]] if who[1] else world[who[0]]
    other = world["b"] if who[0] in ("a", "outsider") else world["a"]
    target = "asha_b" if other is world["b"] else "asha"
    refused = _get(c, user, other["project"], target)
    missing = _get(c, user, other["project"], "nope")
    wrong_project = _get(c, user, 99999, target)
    assert refused.status_code == missing.status_code == wrong_project.status_code == 404
    assert refused.json() == missing.json() == wrong_project.json()


def test_people_read_their_own_projects_datasets(world):
    c = world["client"]
    got = _get(c, world["a"]["enum"], world["a"]["project"], "asha").json()
    assert got["rows"] == [{"name": "Sunita", "phone": "9000000001"}]
    assert got["project_id"] == world["a"]["project"].id
    assert _get(c, world["admin"], world["a"]["project"], "asha").status_code == 200
    assert _get(c, world["admin"], world["b"]["project"], "asha_b").status_code == 200


def test_a_direct_form_assignment_is_a_grant_to_that_forms_project_and_no_further(world, db):
    """RULE: an enumerator with a direct Assignment on a form reads the datasets of that form's project."""
    c, who = world["client"], world["assigned"]
    assert _get(c, who, world["b"]["project"], "asha_b").status_code == 200  # via form_b
    assert _get(c, who, world["a"]["project"], "asha").status_code == 404  # no grant in project a
    db.query(Assignment).filter_by(user_id=who.id).delete()
    db.commit()
    assert _get(c, who, world["b"]["project"], "asha_b").status_code == 404  # the grant ends with the assignment
    assert _names(c.get("/api/datasets", headers=_h(who))) == []


def test_a_supervisor_cannot_overwrite_another_projects_dataset(world, db):
    c = world["client"]
    before = db.query(Dataset).filter_by(name="asha_b").one().version
    named = _put(c, world["a"]["sup"], "asha_b", CSV_A, project_id=world["b"]["project"].id)
    ghost = _put(c, world["a"]["sup"], "asha_b", CSV_A, project_id=99999)
    assert named.status_code == ghost.status_code == 404 and named.json() == ghost.json()
    # With no project named it lands in the supervisor's own project and B's copy is untouched.
    own = _put(c, world["a"]["sup"], "asha_b", CSV_A)
    assert own.status_code == 200 and own.json()["rows"][0]["name"] == "Sunita"
    db.expire_all()
    theirs = db.query(Dataset).filter_by(name="asha_b", project_id=world["b"]["project"].id).one()
    assert theirs.version == before and b"Geeta" in theirs.csv_blob
    assert _get(c, world["b"]["sup"], world["b"]["project"], "asha_b").json()["rows"][0]["name"] == "Geeta"


def test_enumerators_cannot_write_datasets(world):
    assert _put(world["client"], world["a"]["enum"], "x", CSV_A).status_code == 403


def test_a_supervisor_in_one_project_uploads_there_and_an_admin_must_say_where(world, db):
    c = world["client"]
    r = _put(c, world["a"]["sup"], "villages", CSV_A)
    assert r.status_code == 200
    assert db.query(Dataset).filter_by(name="villages").one().project_id == world["a"]["project"].id
    refused = _put(c, world["admin"], "villages2", CSV_A)
    assert refused.status_code == 422 and refused.json()["detail"]["error"] == "project_required"
    ok = _put(c, world["admin"], "villages2", CSV_A, project_id=world["b"]["project"].id)
    assert ok.status_code == 200
    assert db.query(Dataset).filter_by(name="villages2").one().project_id == world["b"]["project"].id


def test_the_same_name_in_two_projects_is_two_datasets_each_addressed_by_project(world):
    c = world["client"]
    assert _put(c, world["b"]["sup"], "asha", CSV_B).status_code == 200
    pa, pb = world["a"]["project"], world["b"]["project"]
    assert _get(c, world["a"]["sup"], pa, "asha").json()["rows"][0]["name"] == "Sunita"
    assert _get(c, world["b"]["sup"], pb, "asha").json()["rows"][0]["name"] == "Geeta"
    assert _get(c, world["admin"], pa, "asha").json()["rows"][0]["name"] == "Sunita"
    assert _get(c, world["admin"], pb, "asha").json()["rows"][0]["name"] == "Geeta"
    # A supervisor naming the other project's copy is refused like a missing dataset.
    assert _get(c, world["a"]["sup"], pb, "asha").status_code == 404


def test_an_enumerator_in_two_projects_lists_both_same_named_datasets_and_reads_each(world, db):
    c = world["client"]
    for tag in ("a", "b"):
        assert _put(c, world[tag]["sup"], "villages", CSV_A if tag == "a" else CSV_B).status_code == 200
    both = world["a"]["enum"]
    db.add(ProjectMember(project_id=world["b"]["project"].id, user_id=both.id))
    db.commit()
    listed = [d for d in c.get("/api/datasets", headers=_h(both)).json() if d["name"] == "villages"]
    assert sorted(d["project_id"] for d in listed) == sorted([world["a"]["project"].id, world["b"]["project"].id])
    got = {d["project_id"]: _get(c, both, d["project_id"], "villages").json()["rows"][0]["name"] for d in listed}
    assert got == {world["a"]["project"].id: "Sunita", world["b"]["project"].id: "Geeta"}


def test_the_old_name_only_address_no_longer_exists(world):
    r = world["client"].get("/api/datasets/asha", headers=_h(world["a"]["enum"]))
    assert r.status_code == 404


def test_upload_by_a_supervisor_in_two_projects_must_name_one_and_is_told_the_choices(world, db):
    c, sup = world["client"], world["a"]["sup"]
    db.add(ProjectMember(project_id=world["b"]["project"].id, user_id=sup.id))
    db.commit()
    refused = _put(c, sup, "villages", CSV_A)
    assert refused.status_code == 422
    detail = refused.json()["detail"]
    assert detail["error"] == "project_required"
    assert sorted(p["id"] for p in detail["projects"]) == sorted([world["a"]["project"].id, world["b"]["project"].id])
    assert {p["name"] for p in detail["projects"]} == {"Project a", "Project b"}
    assert db.query(Dataset).filter_by(name="villages").count() == 0
    ok = _put(c, sup, "villages", CSV_B, project_id=world["b"]["project"].id)
    assert ok.status_code == 200 and ok.json()["project_id"] == world["b"]["project"].id
    assert db.query(Dataset).filter_by(name="villages").one().project_id == world["b"]["project"].id


def test_upload_to_a_project_the_caller_is_outside_is_refused_like_a_missing_project(world):
    c = world["client"]
    a = _put(c, world["a"]["sup"], "villages", CSV_A, project_id=world["b"]["project"].id)
    b = _put(c, world["a"]["sup"], "villages", CSV_A, project_id=99999)
    assert a.status_code == b.status_code == 404 and a.json() == b.json()


def test_a_dataset_always_has_a_project(db):
    ds = Dataset(name="orphan", csv_blob=b"a\n1\n", version=1)
    db.add(ds)
    db.commit()
    assert db.get(Project, ds.project_id).name == DEFAULT_PROJECT_NAME
