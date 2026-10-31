import pytest
from sqlalchemy import func, select

from app.api import admin
from app.core.security import create_access_token
from app.db.models import Assignment, AuditLog, Form, RefreshToken, User
from app.main import app

# main.py mounts the router in the integrated build; mount it here too when it has not.
if not any(getattr(r, "path", "") == "/api/users" for r in app.routes):
    app.include_router(admin.router)

GOOD_PW = "a-long-enough-pass"
WORKER_PW = "correct-horse-battery"  # the user_factory default


@pytest.fixture
def as_(user_factory):
    def make(role, username=None):
        u = user_factory(username=username or role, role=role)
        return u, {"Authorization": f"Bearer {create_access_token(u.id, role)}"}

    return make


@pytest.fixture
def adm(as_):
    return as_("admin")


def _new_user(client, headers, **over):
    body = {
        "username": "rani",
        "password": GOOD_PW,
        "role": "enumerator",
        "full_name": "Rani Kumari",
    }
    body.update(over)
    return client.post("/api/users", json=body, headers=headers)


def _audit_actions(db):
    return [a.action for a in db.scalars(select(AuditLog).order_by(AuditLog.id))]


def _form(db, admin_id):
    f = Form(form_id="amb_visit", title="AMB visit", created_by=admin_id)
    db.add(f)
    db.commit()
    return f


def _login(client, username="worker", password=WORKER_PW):
    return client.post("/api/auth/login", json={"username": username, "password": password})


# ---- create / list ---------------------------------------------------------


def test_admin_creates_a_user_and_the_response_has_no_hash(client, db, adm):
    _, h = adm
    r = _new_user(client, h, phone="9800000000")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["username"] == "rani" and body["role"] == "enumerator"
    assert body["is_active"] is True and body["phone"] == "9800000000"
    assert "password" not in r.text and "argon2" not in r.text
    stored = db.scalar(select(User).where(User.username == "rani"))
    assert stored.password_hash.startswith("$argon2")  # really hashed
    lst = client.get("/api/users", headers=h)
    assert lst.status_code == 200
    assert "argon2" not in lst.text and "password" not in lst.text
    assert {u["username"] for u in lst.json()} == {"admin", "rani"}


@pytest.mark.parametrize("pw", ["1234", "short", "123456789"])
def test_a_short_password_is_refused_with_a_clear_message(client, db, adm, pw):
    _, h = adm
    r = _new_user(client, h, password=pw)
    assert r.status_code == 422
    assert "at least 10 characters" in r.text
    assert db.scalar(select(User).where(User.username == "rani")) is None


@pytest.mark.parametrize("pw", ["password123", "Password1234", "1234567890", "qwertyuiop"])
def test_an_obvious_password_is_refused_with_a_clear_message(client, adm, pw):
    _, h = adm
    r = _new_user(client, h, password=pw)
    assert r.status_code == 422
    assert "too common" in r.text


def test_bad_role_and_duplicate_username(client, adm):
    _, h = adm
    assert _new_user(client, h, role="superuser").status_code == 422
    assert _new_user(client, h).status_code == 201
    dup = _new_user(client, h)
    assert dup.status_code == 409
    assert "argon2" not in dup.text and GOOD_PW not in dup.text


def test_unknown_fields_are_rejected(client, adm):
    _, h = adm
    assert _new_user(client, h, password_hash="x").status_code == 422
    assert _new_user(client, h, is_active=False).status_code == 422


@pytest.mark.parametrize("role", ["supervisor", "enumerator"])
def test_a_non_admin_cannot_manage_users(client, as_, role):
    u, h = as_(role)
    assert _new_user(client, h).status_code == 403
    assert client.get("/api/users", headers=h).status_code == 403
    assert client.patch(f"/api/users/{u.id}", json={"full_name": "x"}, headers=h).status_code == 403
    assert client.get("/api/audit", headers=h).status_code == 403
    body = {"user_id": 1, "form_id": "f"}
    assert client.post("/api/assignments", json=body, headers=h).status_code == 403
    assert client.delete("/api/assignments/1", headers=h).status_code == 403


def test_no_token_is_401(client):
    assert client.get("/api/users").status_code == 401
    assert client.get("/api/audit").status_code == 401


# ---- patch -----------------------------------------------------------------


def test_deactivating_a_user_revokes_their_refresh_tokens(client, db, adm, user_factory):
    _, h = adm
    victim = user_factory(username="worker")
    rt = _login(client).json()["refresh_token"]
    r = client.patch(f"/api/users/{victim.id}", json={"is_active": False}, headers=h)
    assert r.status_code == 200 and r.json()["is_active"] is False
    assert client.post("/api/auth/refresh", json={"refresh_token": rt}).status_code == 401
    live = db.scalar(
        select(func.count())
        .select_from(RefreshToken)
        .where(RefreshToken.user_id == victim.id, RefreshToken.revoked_at.is_(None))
    )
    assert live == 0


def test_the_deactivated_users_access_token_stops_working_too(client, adm, as_):
    _, h = adm
    w, wh = as_("supervisor", "sup")
    assert client.get("/api/forms", headers=wh).status_code == 200
    client.patch(f"/api/users/{w.id}", json={"is_active": False}, headers=h)
    assert client.get("/api/forms", headers=wh).status_code == 401


def test_reactivating_does_not_revive_old_tokens(client, adm, user_factory):
    _, h = adm
    victim = user_factory(username="worker")
    rt = _login(client).json()["refresh_token"]
    client.patch(f"/api/users/{victim.id}", json={"is_active": False}, headers=h)
    client.patch(f"/api/users/{victim.id}", json={"is_active": True}, headers=h)
    assert client.post("/api/auth/refresh", json={"refresh_token": rt}).status_code == 401


def test_resetting_a_password_changes_it_and_revokes_tokens(client, adm, user_factory):
    _, h = adm
    victim = user_factory(username="worker")
    rt = _login(client).json()["refresh_token"]
    r = client.patch(f"/api/users/{victim.id}", json={"password": "brand-new-passphrase"}, headers=h)
    assert r.status_code == 200
    assert "argon2" not in r.text and "brand-new" not in r.text
    assert client.post("/api/auth/refresh", json={"refresh_token": rt}).status_code == 401
    assert _login(client, password="brand-new-passphrase").status_code == 200
    assert _login(client, password=WORKER_PW).status_code == 401


def test_a_weak_reset_password_is_refused(client, adm, user_factory):
    _, h = adm
    v = user_factory(username="worker")
    r = client.patch(f"/api/users/{v.id}", json={"password": "short"}, headers=h)
    assert r.status_code == 422 and "at least 10 characters" in r.text
    assert _login(client, password=WORKER_PW).status_code == 200  # unchanged


def test_role_change_applies_immediately_from_the_database(client, adm, as_):
    _, h = adm
    s, sh = as_("supervisor", "sup")
    assert client.get("/api/forms", headers=sh).status_code == 200
    r = client.patch(f"/api/users/{s.id}", json={"role": "enumerator"}, headers=h)
    assert r.status_code == 200 and r.json()["role"] == "enumerator"
    # the token still claims supervisor; the database now says enumerator
    files = {"file": ("x.xlsx", b"PK\x03\x04", "application/octet-stream")}
    assert client.post("/api/forms", files=files, headers=sh).status_code == 403


def test_patch_unknown_user_is_404_and_bad_bodies_are_422(client, adm):
    u, h = adm
    assert client.patch("/api/users/9999", json={"full_name": "x"}, headers=h).status_code == 404
    assert client.patch(f"/api/users/{u.id}", json={}, headers=h).status_code == 422
    assert client.patch(f"/api/users/{u.id}", json={"username": "z"}, headers=h).status_code == 422


# ---- last admin ------------------------------------------------------------


def test_an_admin_cannot_deactivate_their_own_last_admin_account(client, db, adm):
    u, h = adm
    r = client.patch(f"/api/users/{u.id}", json={"is_active": False}, headers=h)
    assert r.status_code == 409
    assert "last active admin" in r.text
    db.refresh(u)
    assert u.is_active is True


def test_the_last_admin_cannot_be_demoted(client, db, adm):
    u, h = adm
    r = client.patch(f"/api/users/{u.id}", json={"role": "supervisor"}, headers=h)
    assert r.status_code == 409
    db.refresh(u)
    assert u.role == "admin"


def test_an_inactive_admin_does_not_count_as_a_spare(client, adm, user_factory):
    u, h = adm
    user_factory(username="old_admin", role="admin", is_active=False)
    assert client.patch(f"/api/users/{u.id}", json={"is_active": False}, headers=h).status_code == 409


def test_with_a_spare_active_admin_one_can_be_deactivated_or_demoted(client, adm, user_factory):
    u, h = adm
    other = user_factory(username="admin2", role="admin")
    third = user_factory(username="admin3", role="admin")
    assert client.patch(f"/api/users/{other.id}", json={"is_active": False}, headers=h).status_code == 200
    assert client.patch(f"/api/users/{third.id}", json={"role": "supervisor"}, headers=h).status_code == 200
    # now u is the last one again
    assert client.patch(f"/api/users/{u.id}", json={"is_active": False}, headers=h).status_code == 409


def test_a_refused_last_admin_change_changes_nothing(client, db, adm):
    u, h = adm
    before = _audit_actions(db)
    client.patch(f"/api/users/{u.id}", json={"is_active": False, "full_name": "Changed"}, headers=h)
    db.expire_all()
    assert db.get(User, u.id).full_name != "Changed"
    assert _audit_actions(db) == before


# ---- audit of changes ------------------------------------------------------


def test_every_user_change_writes_an_audit_row(client, db, adm):
    a, h = adm
    uid = _new_user(client, h).json()["id"]
    client.patch(f"/api/users/{uid}", json={"role": "supervisor"}, headers=h)
    client.patch(f"/api/users/{uid}", json={"password": "another-long-passphrase"}, headers=h)
    client.patch(f"/api/users/{uid}", json={"is_active": False}, headers=h)
    assert _audit_actions(db) == ["user.create", "user.update", "user.update", "user.update"]
    rows = list(db.scalars(select(AuditLog).order_by(AuditLog.id)))
    assert all(
        r.actor_user_id == a.id and r.object_type == "user" and r.object_id == str(uid) for r in rows
    )
    assert rows[0].detail_json == {"username": "rani", "role": "enumerator"}
    assert rows[1].detail_json["role"] == {"from": "enumerator", "to": "supervisor"}
    assert rows[2].detail_json == {"credential_reset": True}
    assert rows[3].detail_json["is_active"] == {"from": True, "to": False}
    dump = " ".join(str(r.detail_json) for r in rows)
    assert "another-long" not in dump and GOOD_PW not in dump and "argon2" not in dump


# ---- assignments -----------------------------------------------------------


def test_assign_and_unassign(client, db, adm, user_factory):
    a, h = adm
    _form(db, a.id)
    w = user_factory(username="worker")
    r = client.post("/api/assignments", json={"user_id": w.id, "form_id": "amb_visit"}, headers=h)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body == {"id": body["id"], "user_id": w.id, "form_id": "amb_visit"}
    assert db.scalar(select(func.count()).select_from(Assignment)) == 1
    assert client.delete(f"/api/assignments/{body['id']}", headers=h).status_code == 204
    assert db.scalar(select(func.count()).select_from(Assignment)) == 0
    assert _audit_actions(db) == ["assignment.create", "assignment.delete"]
    rows = list(db.scalars(select(AuditLog).order_by(AuditLog.id)))
    assert rows[0].detail_json == {"user_id": w.id, "form_id": "amb_visit"}


def test_assignment_errors(client, db, adm, user_factory):
    a, h = adm
    _form(db, a.id)
    w = user_factory(username="worker")
    ok = {"user_id": w.id, "form_id": "amb_visit"}
    assert client.post("/api/assignments", json={**ok, "user_id": 999}, headers=h).status_code == 404
    assert client.post("/api/assignments", json={**ok, "form_id": "nope"}, headers=h).status_code == 404
    assert client.post("/api/assignments", json=ok, headers=h).status_code == 201
    assert client.post("/api/assignments", json=ok, headers=h).status_code == 409
    assert client.delete("/api/assignments/999", headers=h).status_code == 404
    assert db.scalar(select(func.count()).select_from(Assignment)) == 1


# ---- audit viewing ---------------------------------------------------------


def test_audit_list_is_read_only(client, adm):
    _, h = adm
    assert client.delete("/api/audit/1", headers=h).status_code in (404, 405)
    assert client.put("/api/audit/1", json={}, headers=h).status_code in (404, 405)
    assert client.patch("/api/audit/1", json={}, headers=h).status_code in (404, 405)
    assert client.post("/api/audit", json={}, headers=h).status_code in (404, 405)
    assert client.delete("/api/audit", headers=h).status_code in (404, 405)
    methods = {
        m for r in app.routes if getattr(r, "path", "").startswith("/api/audit") for m in r.methods
    }
    assert methods <= {"GET", "HEAD"}


def test_audit_is_paginated_newest_first_and_filterable(client, adm, user_factory):
    a, h = adm
    w = user_factory(username="worker")
    for i in range(3):
        client.patch(f"/api/users/{w.id}", json={"full_name": f"n{i}"}, headers=h)
    _new_user(client, h)
    r = client.get("/api/audit", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"items", "total", "limit", "offset"}
    assert body["total"] == 4 and body["limit"] == 50 and body["offset"] == 0
    ids = [i["id"] for i in body["items"]]
    assert ids == sorted(ids, reverse=True)
    assert set(body["items"][0]) == {
        "id", "at", "actor_user_id", "action", "object_type", "object_id", "ip", "user_agent",
        "detail",
    }
    page = client.get("/api/audit?limit=2&offset=1", headers=h).json()
    assert page["total"] == 4 and [i["id"] for i in page["items"]] == ids[1:3]
    by_action = client.get("/api/audit?action=user.create", headers=h).json()
    assert by_action["total"] == 1 and by_action["items"][0]["action"] == "user.create"
    assert client.get(f"/api/audit?actor_id={a.id}", headers=h).json()["total"] == 4
    assert client.get("/api/audit?actor_id=999", headers=h).json()["total"] == 0
    assert client.get("/api/audit?limit=0", headers=h).status_code == 422
    assert client.get("/api/audit?limit=1000", headers=h).status_code == 422
    assert client.get("/api/audit?offset=-1", headers=h).status_code == 422
    assert "argon2" not in r.text
