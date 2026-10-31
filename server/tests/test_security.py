from datetime import UTC, datetime, timedelta

import jwt
import pytest

from app.core import security
from app.core.config import get_settings
from app.core.security import (
    TokenExpired,
    TokenInvalid,
    create_access_token,
    dummy_verify,
    decode_access_token,
    hash_password,
    new_refresh_token,
    verify_password,
)

OTHER_SECRET = "a-different-secret-of-sufficient-length-0123456789"


def _secret() -> str:
    return get_settings().jwt_secret.get_secret_value()


def _payload(now: datetime, **over) -> dict:
    p = {
        "sub": "7",
        "role": "enumerator",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=15)).timestamp()),
    }
    p.update(over)
    return p


def test_hash_is_argon2id_and_not_the_plaintext():
    h = hash_password("sita@2026")
    assert h.startswith("$argon2id$") and "sita@2026" not in h


def test_verify_accepts_right_and_rejects_wrong():
    h = hash_password("sita@2026")
    assert verify_password("sita@2026", h) and not verify_password("sita@2025", h)


def test_verify_returns_false_for_malformed_hash():
    assert verify_password("sita@2026", "not-a-hash") is False


def test_same_password_hashes_differently():
    assert hash_password("x") != hash_password("x")


def test_access_token_round_trips_and_carries_role():
    c = decode_access_token(create_access_token(7, "enumerator"))
    assert (c.user_id, c.role) == (7, "enumerator")
    assert c.exp.tzinfo is not None


def test_access_token_lives_fifteen_minutes():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    c = decode_access_token(create_access_token(7, "admin", now=now), now=now)
    assert c.exp == now + timedelta(minutes=15)


def test_token_valid_just_before_expiry():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    tok = create_access_token(7, "admin", now=now)
    decode_access_token(tok, now=now + timedelta(minutes=14, seconds=59))


def test_expired_token_is_rejected_when_decoded_later():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    tok = create_access_token(7, "admin", now=now)
    with pytest.raises(TokenExpired):
        decode_access_token(tok, now=now + timedelta(days=1))


def test_expired_token_is_rejected_when_issued_in_the_past():
    tok = create_access_token(7, "admin", now=datetime.now(UTC) - timedelta(days=1))
    with pytest.raises(TokenExpired):
        decode_access_token(tok)


def _assert_invalid_not_expired(token: str, **kw) -> TokenInvalid:
    """The token must be refused as invalid, not misclassified as merely expired."""
    with pytest.raises(TokenInvalid) as e:
        decode_access_token(token, **kw)
    assert not isinstance(e.value, TokenExpired)
    return e.value


def test_token_signed_with_another_secret_is_rejected():
    now = datetime.now(UTC)
    payload = _payload(now)
    # Control: identical claims signed with the real secret are accepted, so the
    # failure below can only come from signature verification.
    assert decode_access_token(jwt.encode(payload, _secret(), algorithm="HS256")).user_id == 7
    _assert_invalid_not_expired(jwt.encode(payload, OTHER_SECRET, algorithm="HS256"))


def test_unsigned_alg_none_token_is_rejected():
    _assert_invalid_not_expired(jwt.encode(_payload(datetime.now(UTC)), None, algorithm="none"))


def test_other_hmac_algorithm_is_rejected():
    tok = jwt.encode(_payload(datetime.now(UTC)), _secret(), algorithm="HS384")
    _assert_invalid_not_expired(tok)


@pytest.mark.parametrize("bad", ["", "garbage", "a.b.c"])
def test_malformed_token_is_rejected(bad):
    _assert_invalid_not_expired(bad)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.pop("exp"),
        lambda p: p.pop("sub"),
        lambda p: p.pop("role"),
        lambda p: p.update(sub="abc"),
        lambda p: p.update(sub=7),
        lambda p: p.update(sub="+7"),
        lambda p: p.update(sub=" 7 "),
        lambda p: p.update(sub="1_0"),
        lambda p: p.update(sub="-7"),
        lambda p: p.update(sub="07"),
        lambda p: p.update(sub="٧"),  # Arabic-Indic digit seven
        lambda p: p.update(role=5),
    ],
)
def test_validly_signed_token_with_bad_claims_is_rejected(mutate):
    p = _payload(datetime.now(UTC))
    mutate(p)
    _assert_invalid_not_expired(jwt.encode(p, _secret(), algorithm="HS256"))


def test_decodes_with_now_beyond_the_real_clock_for_a_future_issued_token():
    # Both sides are driven by the injected clock; PyJWT's wall-clock iat/nbf
    # checks must not interfere.
    future = datetime.now(UTC) + timedelta(days=30)
    tok = create_access_token(7, "admin", now=future)
    assert decode_access_token(tok, now=future + timedelta(minutes=1)).user_id == 7


def test_token_issued_slightly_in_the_future_is_not_rejected_for_skew():
    now = datetime.now(UTC)
    tok = jwt.encode(_payload(now, iat=int((now + timedelta(seconds=30)).timestamp())), _secret(), algorithm="HS256")
    assert decode_access_token(tok, now=now).user_id == 7


def test_expiry_is_inclusive_at_the_exact_boundary():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    tok = create_access_token(7, "admin", now=now)
    exp = now + timedelta(minutes=15)
    with pytest.raises(TokenExpired):
        decode_access_token(tok, now=exp)
    decode_access_token(tok, now=exp - timedelta(seconds=1))


def test_naive_now_is_refused_with_a_clear_error():
    naive = datetime(2026, 1, 1, 12, 0)
    with pytest.raises(ValueError, match="timezone-aware"):
        create_access_token(7, "admin", now=naive)
    tok = create_access_token(7, "admin")
    with pytest.raises(ValueError, match="timezone-aware"):
        decode_access_token(tok, now=naive)


def test_errors_do_not_leak_the_token():
    tok = jwt.encode(_payload(datetime.now(UTC)), OTHER_SECRET, algorithm="HS256")
    for bad in (tok, "garbage"):
        err = _assert_invalid_not_expired(bad)
        assert str(err) == "invalid token"
        assert err.__cause__ is None
        assert bad not in str(err) and OTHER_SECRET not in str(err)


def test_dummy_verify_always_false_and_runs_a_real_argon2_check(monkeypatch):
    calls = []
    real = security.verify_password
    monkeypatch.setattr(
        security, "verify_password", lambda p, h: calls.append(h) or real(p, h)
    )
    assert dummy_verify("whatever") is False
    assert calls == [security._DUMMY_HASH]
    assert security._DUMMY_HASH.startswith("$argon2id$")


def test_refresh_token_is_stored_only_as_a_hash():
    plain, hashed = new_refresh_token()
    assert plain != hashed and len(plain) >= 43
    assert len(hashed) == 64


def test_refresh_tokens_are_unique():
    assert new_refresh_token()[0] != new_refresh_token()[0]


def test_hash_refresh_token_is_the_stored_digest():
    from app.core.security import hash_refresh_token, new_refresh_token

    plain, digest = new_refresh_token()
    assert hash_refresh_token(plain) == digest
    assert hash_refresh_token("a") != hash_refresh_token("b")
