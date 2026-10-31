from datetime import UTC, datetime, timedelta

import jwt
import pytest

from app.core.config import get_settings
from app.core.security import (
    TokenExpired,
    TokenInvalid,
    create_access_token,
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


def test_token_signed_with_another_secret_is_rejected():
    now = datetime.now(UTC)
    payload = _payload(now)
    # Control: identical claims signed with the real secret are accepted, so the
    # failure below can only come from signature verification.
    assert decode_access_token(jwt.encode(payload, _secret(), algorithm="HS256")).user_id == 7
    with pytest.raises(TokenInvalid):
        decode_access_token(jwt.encode(payload, OTHER_SECRET, algorithm="HS256"))


def test_unsigned_alg_none_token_is_rejected():
    forged = jwt.encode(_payload(datetime.now(UTC)), None, algorithm="none")
    with pytest.raises(TokenInvalid):
        decode_access_token(forged)


# The short test secret trips PyJWT's HS384 key-length warning when signing the
# fixture token; that concerns the test key, not the code under test.
@pytest.mark.filterwarnings("ignore::jwt.warnings.InsecureKeyLengthWarning")
def test_other_hmac_algorithm_is_rejected():
    tok = jwt.encode(_payload(datetime.now(UTC)), _secret(), algorithm="HS384")
    with pytest.raises(TokenInvalid):
        decode_access_token(tok)


@pytest.mark.parametrize("bad", ["", "garbage", "a.b.c"])
def test_malformed_token_is_rejected(bad):
    with pytest.raises(TokenInvalid):
        decode_access_token(bad)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.pop("exp"),
        lambda p: p.pop("sub"),
        lambda p: p.pop("role"),
        lambda p: p.update(sub="abc"),
        lambda p: p.update(role=5),
    ],
)
def test_validly_signed_token_with_bad_claims_is_rejected(mutate):
    p = _payload(datetime.now(UTC))
    mutate(p)
    with pytest.raises(TokenInvalid):
        decode_access_token(jwt.encode(p, _secret(), algorithm="HS256"))


def test_errors_do_not_leak_the_token():
    tok = jwt.encode(_payload(datetime.now(UTC)), OTHER_SECRET, algorithm="HS256")
    with pytest.raises(TokenInvalid) as e:
        decode_access_token(tok)
    assert tok not in str(e.value) and OTHER_SECRET not in str(e.value)


def test_refresh_token_is_stored_only_as_a_hash():
    plain, hashed = new_refresh_token()
    assert plain != hashed and len(plain) >= 43
    assert len(hashed) == 64


def test_refresh_tokens_are_unique():
    assert new_refresh_token()[0] != new_refresh_token()[0]
