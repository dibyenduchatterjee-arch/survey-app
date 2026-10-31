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
    target = "asha_b" if who[0] in ("a", "outsider") else "asha"
    refused, missing = c.get(f"/api/datasets/{target}", headers=_h(user)), c.get("/api/datasets/nope", headers=_h(user))
    assert refused.status_code == missing.status_code == 404
    assert refused.json() == missing.json()


def test_people_read_their_own_projects_datasets(world):
    c = world["client"]
    got = c.get("/api/datasets/asha", headers=_h(world["a"]["enum"])).json()
    assert got["rows"] == [{"name": "Sunita", "phone": "9000000001"}]
    assert c.get("/api/datasets/asha_b", headers=_h(world["assigned"])).status_code == 200
    assert c.get("/api/datasets/asha", headers=_h(world["admin"])).status_code == 200
    assert c.get("/api/datasets/asha_b", headers=_h(world["admin"])).status_code == 200


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
    assert c.get("/api/datasets/asha_b", headers=_h(world["b"]["sup"])).json()["rows"][0]["name"] == "Geeta"


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


def test_the_same_name_may_exist_in_two_projects_and_the_admin_names_which(world):
    c = world["client"]
    assert _put(c, world["b"]["sup"], "asha", CSV_B).status_code == 200
    assert c.get("/api/datasets/asha", headers=_h(world["a"]["sup"])).json()["rows"][0]["name"] == "Sunita"
    assert c.get("/api/datasets/asha", headers=_h(world["b"]["sup"])).json()["rows"][0]["name"] == "Geeta"
    ambiguous = c.get("/api/datasets/asha", headers=_h(world["admin"]))
    assert ambiguous.status_code == 409
    pid = world["b"]["project"].id
    assert c.get(f"/api/datasets/asha?project_id={pid}", headers=_h(world["admin"])).json()["rows"][0]["name"] == "Geeta"


def test_a_dataset_always_has_a_project(db):
    ds = Dataset(name="orphan", csv_blob=b"a\n1\n", version=1)
    db.add(ds)
    db.commit()
    assert db.get(Project, ds.project_id).name == DEFAULT_PROJECT_NAME
