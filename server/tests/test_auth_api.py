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


# --- only failures count; success clears both counters -----------------------------


def test_successful_logins_do_not_count_toward_either_limit(client, user_factory):
    from app.api import auth

    user_factory()
    for _ in range(auth.ip_limiter.limit + 5):  # more than either limit
        assert login(client).status_code == 200
    # a full allowance of failures is still available afterwards
    for _ in range(auth.username_limiter.limit):
        assert login(client, password="bad").status_code == 401


def test_successful_login_clears_the_ip_counter_too(client, user_factory):
    from app.api import auth

    user_factory()
    limit = auth.ip_limiter.limit
    for i in range(limit - 1):
        assert login(client, f"user{i}", "x").status_code == 401
    assert login(client).status_code == 200
    for i in range(limit - 1):  # would be refused if the IP counter had not been cleared
        assert login(client, f"other{i}", "x").status_code == 401


# --- client IP behind a proxy ------------------------------------------------------


class _Req:
    def __init__(self, xff=None, host="10.0.0.1"):
        self.headers = {"x-forwarded-for": xff} if xff is not None else {}
        self.client = type("C", (), {"host": host})()


def _settings(**kw):
    from app.core.config import Settings

    return Settings(jwt_secret="x" * 40, media_key="m", **kw)


def test_proxy_settings_default_to_off():
    s = _settings()
    assert s.trust_proxy_headers is False and s.trusted_proxy_hops == 1
    assert (s.refresh_token_days, s.login_rate_limit_per_username) == (30, 5)
    assert (s.login_rate_limit_per_ip, s.login_rate_limit_window_seconds) == (20, 900)


def test_forwarded_header_is_ignored_when_trust_is_off():
    from app.api.auth import client_ip

    assert client_ip(_Req("203.0.113.9"), _settings()) == "10.0.0.1"


def test_client_ip_takes_the_right_hand_entry_for_one_hop():
    from app.api.auth import client_ip

    s = _settings(trust_proxy_headers=True)
    assert client_ip(_Req("203.0.113.9"), s) == "203.0.113.9"
    assert client_ip(_Req("1.1.1.1, 203.0.113.9"), s) == "203.0.113.9"


def test_client_ip_skips_the_configured_number_of_proxy_hops():
    from app.api.auth import client_ip

    s = _settings(trust_proxy_headers=True, trusted_proxy_hops=2)
    assert client_ip(_Req("6.6.6.6, 203.0.113.7, 192.0.2.1"), s) == "203.0.113.7"


def test_client_ip_falls_back_to_the_peer_when_the_header_is_unusable():
    from app.api.auth import client_ip

    s = _settings(trust_proxy_headers=True, trusted_proxy_hops=3)
    assert client_ip(_Req(None), s) == "10.0.0.1"
    assert client_ip(_Req("203.0.113.9"), s) == "10.0.0.1"  # fewer entries than hops
    assert client_ip(_Req("garbage"), _settings(trust_proxy_headers=True)) == "10.0.0.1"


def _trust_proxy(_client, **kw):
    from app.core.config import get_settings
    from app.main import app

    app.dependency_overrides[get_settings] = lambda: _settings(trust_proxy_headers=True, **kw)


def test_forged_left_most_forwarded_value_does_not_escape_the_ip_limit(client, user_factory):
    from app.api import auth

    user_factory()
    _trust_proxy(client)
    # the real client (as the proxy saw it) is always 203.0.113.9; the attacker varies the left
    for i in range(auth.ip_limiter.limit):
        r = client.post(
            "/api/auth/login",
            json={"username": f"u{i}", "password": "x"},
            headers={"X-Forwarded-For": f"10.9.9.{i}, 203.0.113.9"},
        )
        assert r.status_code == 401
    r = client.post(
        "/api/auth/login",
        json={"username": "sita", "password": PASSWORD},
        headers={"X-Forwarded-For": "10.9.9.200, 203.0.113.9"},
    )
    assert r.status_code == 429


def test_different_real_clients_behind_the_proxy_get_separate_ip_buckets(client, user_factory):
    from app.api import auth

    user_factory()
    _trust_proxy(client)
    for i in range(auth.ip_limiter.limit):
        client.post(
            "/api/auth/login",
            json={"username": f"u{i}", "password": "x"},
            headers={"X-Forwarded-For": "203.0.113.9"},
        )
    other = client.post(
        "/api/auth/login",
        json={"username": "sita", "password": PASSWORD},
        headers={"X-Forwarded-For": "203.0.113.10"},
    )
    assert other.status_code == 200


def test_ip_limit_is_shared_when_trust_is_off_despite_varying_headers(client, user_factory):
    from app.api import auth

    user_factory()
    for i in range(auth.ip_limiter.limit):
        client.post(
            "/api/auth/login",
            json={"username": f"u{i}", "password": "x"},
            headers={"X-Forwarded-For": f"198.51.100.{i}"},
        )
    r = client.post(
        "/api/auth/login",
        json={"username": "sita", "password": PASSWORD},
        headers={"X-Forwarded-For": "198.51.100.250"},
    )
    assert r.status_code == 429


def test_refresh_token_lifetime_follows_the_setting(client, user_factory, db):
    from app.core.config import get_settings
    from app.main import app

    user_factory()
    app.dependency_overrides[get_settings] = lambda: _settings(refresh_token_days=7)
    assert login(client).status_code == 200
    row = db.scalars(select(RefreshToken)).one()
    assert row.expires_at - row.issued_at == timedelta(days=7)
