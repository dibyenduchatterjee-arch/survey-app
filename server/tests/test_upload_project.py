"""POST /api/forms: where a new form lands is always explicit; the server never guesses."""

from pathlib import Path

import pytest

from app.core.security import create_access_token
from app.db.models import Form, Project, ProjectMember

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DATA = (Path(__file__).parent / "fixtures" / "amb_asha_visit.xlsx").read_bytes()


def _h(u):
    return {"Authorization": f"Bearer {create_access_token(u.id, u.role)}"}


@pytest.fixture
def world(client, db, user_factory):
    admin = user_factory(username="adm", role="admin")
    projects = {}
    for name in ("Alpha", "Beta", "Gamma"):
        p = Project(name=name)
        db.add(p)
        projects[name] = p
    db.commit()
    return {"admin": admin, "p": projects, "c": client, "db": db, "mk": user_factory}


def up(w, user, **data):
    return w["c"].post("/api/forms", files={"file": ("f.xlsx", DATA, XLSX)}, data=data, headers=_h(user))


def member(w, user, *names):
    for n in names:
        w["db"].add(ProjectMember(project_id=w["p"][n].id, user_id=user.id))
    w["db"].commit()


def test_a_supervisor_in_one_project_lands_there_without_naming_it(world):
    sup = world["mk"](username="s1", role="supervisor")
    member(world, sup, "Beta")
    assert up(world, sup).status_code == 201
    assert world["db"].query(Form).one().project_id == world["p"]["Beta"].id


def test_a_supervisor_in_several_projects_must_choose_and_is_told_which(world):
    sup = world["mk"](username="s2", role="supervisor")
    member(world, sup, "Alpha", "Gamma")
    r = up(world, sup)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["error"] == "project_required"
    assert sorted(p["name"] for p in detail["projects"]) == ["Alpha", "Gamma"]
    assert world["db"].query(Form).count() == 0  # nothing filed anywhere
    assert up(world, sup, project_id=world["p"]["Gamma"].id).status_code == 201
    assert world["db"].query(Form).one().project_id == world["p"]["Gamma"].id


def test_a_supervisor_in_no_project_is_refused_and_no_private_project_appears(world):
    sup = world["mk"](username="s3", role="supervisor")
    r = up(world, sup)
    assert r.status_code == 422 and r.json()["detail"]["projects"] == []
    assert world["db"].query(Project).count() == 3 and world["db"].query(Form).count() == 0


def test_a_supervisor_cannot_name_a_project_they_are_not_in(world):
    sup = world["mk"](username="s4", role="supervisor")
    member(world, sup, "Alpha")
    other = up(world, sup, project_id=world["p"]["Beta"].id)
    missing = up(world, sup, project_id=9999)
    assert other.status_code == missing.status_code == 404
    assert other.json() == missing.json()  # indistinguishable: Beta's existence is not revealed
    assert world["db"].query(Form).count() == 0


def test_an_admin_must_always_name_a_project(world):
    r = up(world, world["admin"])
    assert r.status_code == 422
    assert sorted(p["name"] for p in r.json()["detail"]["projects"]) == ["Alpha", "Beta", "Gamma"]
    assert world["db"].query(Form).count() == 0
    assert up(world, world["admin"], project_id=world["p"]["Beta"].id).status_code == 201
    assert world["db"].query(Form).one().project_id == world["p"]["Beta"].id


def test_an_admin_naming_a_missing_project_gets_404(world):
    assert up(world, world["admin"], project_id=9999).status_code == 404


def test_a_malformed_project_id_is_422(world):
    assert up(world, world["admin"], project_id="abc").status_code == 422


def test_a_new_version_of_an_existing_form_keeps_its_project(world):
    sup = world["mk"](username="s5", role="supervisor")
    member(world, sup, "Alpha", "Beta")
    assert up(world, sup, project_id=world["p"]["Alpha"].id).status_code == 201
    assert up(world, sup).status_code == 201  # no project_id needed: the form already has one
    assert world["db"].query(Form).one().project_id == world["p"]["Alpha"].id
    r = up(world, sup, project_id=world["p"]["Beta"].id)  # would be a move; that has its own route
    assert r.status_code == 422 and world["db"].query(Form).one().project_id == world["p"]["Alpha"].id
