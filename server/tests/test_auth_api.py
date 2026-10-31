from datetime import timedelta

from sqlalchemy import select

from app.core.security import decode_access_token
from app.db.models import RefreshToken, User

PASSWORD = "correct-horse-battery"


def login(client, username="sita", password=PASSWORD):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def refresh(client, token):
    return client.post("/api/auth/refresh", json={"refresh_token": token})


def test_login_returns_tokens_for_valid_credentials(client, user_factory, db):
    user = user_factory()
    r = login(client)
    assert r.status_code == 200
    body = r.json()
    assert body["user"] == {
        "id": user.id,
        "username": "sita",
        "full_name": "Sita Devi",
        "role": "enumerator",
    }
    claims = decode_access_token(body["access_token"])
    assert claims.user_id == user.id and claims.role == "enumerator"
    assert db.scalars(select(User)).one().last_login_at is not None
    # only the hash of the refresh token is stored
    row = db.scalars(select(RefreshToken)).one()
    assert row.token_hash != body["refresh_token"]
    assert row.expires_at > row.issued_at + timedelta(days=1)


def test_login_rejects_wrong_password_with_401(client, user_factory):
    user_factory()
    assert login(client, password="wrong").status_code == 401


def test_login_error_is_identical_for_unknown_user_and_wrong_password(client, user_factory):
    user_factory()
    a = login(client, "nobody", "x")
    b = login(client, "sita", "wrong")
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json()
    assert a.headers.keys() == b.headers.keys()


def test_login_rejects_a_deactivated_user_identically(client, user_factory):
    user_factory(is_active=False)
    a = login(client)  # correct password, deactivated
    b = login(client, "nobody", "x")
    assert a.status_code == 401
    assert a.json() == b.json()


def test_unknown_user_still_runs_a_password_check(client, monkeypatch):
    from app.api import auth

    calls = []
    monkeypatch.setattr(auth, "dummy_verify", lambda p: calls.append(p) or False)
    assert login(client, "nobody", "x").status_code == 401
    assert calls == ["x"]


def test_response_never_contains_the_password_hash(client, user_factory):
    user_factory()
    for r in (login(client), login(client, password="wrong"), login(client, "nobody", "x")):
        assert "argon2" not in r.text


def test_login_validates_the_body(client):
    assert client.post("/api/auth/login", json={"username": "sita"}).status_code == 422
    too_long = {"username": "s" * 500, "password": "x"}
    assert client.post("/api/auth/login", json=too_long).status_code == 422


def test_refresh_issues_a_new_pair_and_revokes_the_old(client, user_factory, db):
    user_factory()
    old_rt = login(client).json()["refresh_token"]
    r = refresh(client, old_rt)
    assert r.status_code == 200
    body = r.json()
    assert body["refresh_token"] != old_rt
    assert decode_access_token(body["access_token"]).role == "enumerator"
    old_row, new_row = db.scalars(select(RefreshToken).order_by(RefreshToken.id)).all()
    assert old_row.revoked_at is not None and old_row.replaced_by == new_row.id
    assert new_row.revoked_at is None
    assert refresh(client, body["refresh_token"]).status_code == 200


def test_reusing_a_rotated_refresh_token_revokes_the_whole_family(client, user_factory, db):
    user_factory()
    old_rt = login(client).json()["refresh_token"]
    new_rt = refresh(client, old_rt).json()["refresh_token"]
    newest_rt = refresh(client, new_rt).json()["refresh_token"]
    assert refresh(client, old_rt).status_code == 401  # replay
    assert refresh(client, new_rt).status_code == 401
    assert refresh(client, newest_rt).status_code == 401  # the newest dies too
    assert all(t.revoked_at is not None for t in db.scalars(select(RefreshToken)))


def test_reuse_detection_leaves_other_sessions_alone(client, user_factory):
    user_factory()
    other = login(client).json()["refresh_token"]  # the same user on another device
    old_rt = login(client).json()["refresh_token"]
    refresh(client, old_rt)
    assert refresh(client, old_rt).status_code == 401
    assert refresh(client, other).status_code == 200


def test_refresh_rejects_unknown_expired_and_malformed_tokens(client, user_factory, db):
    user_factory()
    assert refresh(client, "not-a-real-token").status_code == 401
    rt = login(client).json()["refresh_token"]
    row = db.scalars(select(RefreshToken)).one()
    row.expires_at = row.issued_at - timedelta(seconds=1)
    db.commit()
    assert refresh(client, rt).status_code == 401
    assert client.post("/api/auth/refresh", json={}).status_code == 422


def test_refresh_rejects_a_user_deactivated_since_login(client, user_factory, db):
    user = user_factory()
    rt = login(client).json()["refresh_token"]
    user.is_active = False
    db.commit()
    assert refresh(client, rt).status_code == 401


def test_logout_revokes_the_refresh_token(client, user_factory):
    user_factory()
    rt = login(client).json()["refresh_token"]
    assert client.post("/api/auth/logout", json={"refresh_token": rt}).status_code == 204
    assert refresh(client, rt).status_code == 401
    # idempotent, and does not reveal whether a token existed
    assert client.post("/api/auth/logout", json={"refresh_token": rt}).status_code == 204
    assert client.post("/api/auth/logout", json={"refresh_token": "nope"}).status_code == 204


def test_sixth_failed_login_in_the_window_is_rate_limited(client, user_factory):
    user_factory()
    for _ in range(5):
        assert login(client, password="bad").status_code == 401
    r = login(client, password="bad")
    assert r.status_code == 429
    assert int(r.headers["retry-after"]) > 0
    # even the right password is refused while locked out
    assert login(client).status_code == 429
    assert "argon2" not in r.text


def test_rate_limit_is_per_username_not_global(client, user_factory):
    user_factory()
    user_factory(username="ram", full_name="Ram Kumar")
    for _ in range(6):
        login(client, "sita", "bad")
    assert login(client, "sita", "bad").status_code == 429
    assert login(client, "ram").status_code == 200


def test_rate_limit_also_applies_per_ip_across_usernames(client, user_factory):
    from app.api import auth

    user_factory()
    # one address spraying many different usernames
    for i in range(auth.ip_limiter.limit):
        assert login(client, f"user{i}", "x").status_code == 401
    assert login(client, "sita").status_code == 429


def test_successful_login_clears_the_username_counter(client, user_factory):
    user_factory()
    for _ in range(4):
        login(client, password="bad")
    assert login(client).status_code == 200
    for _ in range(5):
        assert login(client, password="bad").status_code == 401
