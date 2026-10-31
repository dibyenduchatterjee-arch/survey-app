from datetime import UTC, datetime, timedelta

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core.rbac import current_user, require_role
from app.core.security import create_access_token
from app.db.models import User
from app.db.session import get_session


@pytest.fixture
def rbac_client(db):
    """A throwaway app (Task 15's real /api/users does not exist yet) wired to the test db."""
    app = FastAPI()

    @app.get("/api/users")
    def admin_only(user: User = Depends(require_role("admin"))):
        return {"id": user.id}

    @app.get("/api/either")
    def either(user: User = Depends(require_role("admin", "supervisor"))):
        return {"id": user.id}

    @app.get("/api/me")
    def me(user: User = Depends(current_user)):
        return {"id": user.id, "role": user.role}

    app.dependency_overrides[get_session] = lambda: db
    return TestClient(app)


def _bearer(user_id, role):
    return {"Authorization": f"Bearer {create_access_token(user_id, role)}"}


def test_enumerator_is_refused_an_admin_route(rbac_client, user_factory):
    u = user_factory(role="enumerator")
    assert rbac_client.get("/api/users", headers=_bearer(u.id, "enumerator")).status_code == 403


def test_admin_is_allowed_and_multiple_roles_are_accepted(rbac_client, user_factory):
    a = user_factory(username="a", role="admin")
    s = user_factory(username="s", role="supervisor")
    assert rbac_client.get("/api/users", headers=_bearer(a.id, "admin")).status_code == 200
    assert rbac_client.get("/api/users", headers=_bearer(s.id, "supervisor")).status_code == 403
    assert rbac_client.get("/api/either", headers=_bearer(s.id, "supervisor")).status_code == 200


def test_missing_token_is_401_not_403(rbac_client):
    r = rbac_client.get("/api/users")
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize("header", ["Basic abc", "Bearer", "Bearer not.a.jwt", "Bearer "])
def test_malformed_credentials_are_401(rbac_client, header):
    assert rbac_client.get("/api/users", headers={"Authorization": header}).status_code == 401


def test_expired_token_is_401(rbac_client, user_factory):
    u = user_factory(role="admin")
    old = datetime.now(UTC) - timedelta(hours=1)
    token = create_access_token(u.id, "admin", now=old)
    r = rbac_client.get("/api/users", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_role_comes_from_the_database_not_the_token(rbac_client, user_factory):
    u = user_factory(role="enumerator")
    forged = _bearer(u.id, "admin")  # valid signature, claim says admin, database says enumerator
    assert rbac_client.get("/api/users", headers=forged).status_code == 403


def test_a_demotion_takes_effect_before_the_token_expires(rbac_client, user_factory, db):
    u = user_factory(role="admin")
    headers = _bearer(u.id, "admin")
    assert rbac_client.get("/api/users", headers=headers).status_code == 200
    u.role = "enumerator"
    db.commit()
    assert rbac_client.get("/api/users", headers=headers).status_code == 403


def test_deactivated_user_with_an_unexpired_token_is_refused(rbac_client, user_factory, db):
    u = user_factory(role="admin")
    headers = _bearer(u.id, "admin")
    u.is_active = False
    db.commit()
    assert rbac_client.get("/api/users", headers=headers).status_code == 401
    assert rbac_client.get("/api/me", headers=headers).status_code == 401


def test_token_for_a_user_that_does_not_exist_is_401(rbac_client):
    assert rbac_client.get("/api/users", headers=_bearer(9999, "admin")).status_code == 401


def test_current_user_returns_the_database_role(rbac_client, user_factory):
    u = user_factory(role="supervisor")
    r = rbac_client.get("/api/me", headers=_bearer(u.id, "admin"))
    assert r.json() == {"id": u.id, "role": "supervisor"}


def test_refusals_do_not_leak_the_token_or_the_role_set(rbac_client, user_factory):
    u = user_factory(role="enumerator")
    headers = _bearer(u.id, "admin")
    r = rbac_client.get("/api/users", headers=headers)
    assert headers["Authorization"].split()[1] not in r.text
    assert "admin" not in r.text


def test_require_role_rejects_an_unknown_role_name_at_definition_time():
    with pytest.raises(ValueError):
        require_role("adimn")
    with pytest.raises(ValueError):
        require_role()
