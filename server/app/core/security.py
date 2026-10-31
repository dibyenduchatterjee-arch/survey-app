"""Credential and token primitives: password hashing, access JWTs, refresh tokens.

Pure functions only: no database access and no HTTP concerns. Time enters as a
parameter (`now`), never ambient: the clock is read only as the default for an
omitted `now`, and PyJWT's own wall-clock checks (exp, iat, nbf) are all off, so
every time decision is made here against that one value.

Nothing here puts a password, token or secret into an exception message or log.
"""

import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import get_settings

ALGORITHM = "HS256"
ACCESS_TOKEN_LIFETIME = timedelta(minutes=15)

_hasher = PasswordHasher()  # argon2id, library defaults
# Hash of a throwaway random password, for dummy_verify(). Built once at import.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))
# Canonical decimal only: no sign, whitespace, underscores, leading zeros or
# non-ASCII digits, which int() would otherwise accept.
_USER_ID_RE = re.compile(r"0|[1-9][0-9]*")


class TokenInvalid(Exception):
    """The token is malformed, wrongly signed, or has bad claims."""


class TokenExpired(TokenInvalid):
    """The token is genuine but past its expiry.

    Deliberately a subclass of TokenInvalid: an expired token is an invalid one,
    so a caller catching the base class rejects it. Do not make these siblings.
    """


@dataclass(frozen=True)
class TokenClaims:
    user_id: int
    role: str  # informational only: authorisation must re-read the role from the DB
    exp: datetime


def hash_password(plain: str) -> str:
    return _hasher.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, plain)
    except (VerificationError, InvalidHashError):
        return False


def dummy_verify(plain: str) -> bool:
    """Spend the same time as a real password check, and always return False.

    Call unconditionally on the unknown-user path of login so response timing
    does not reveal which usernames exist.
    """
    verify_password(plain, _DUMMY_HASH)
    return False


def _secret() -> str:
    return get_settings().jwt_secret.get_secret_value()


def _resolve_now(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(UTC)
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be a timezone-aware datetime")
    return now


def create_access_token(user_id: int, role: str, *, now: datetime | None = None) -> str:
    now = _resolve_now(now)
    payload = {
        "sub": str(user_id),
        "role": role,
        "iat": int(now.timestamp()),  # informational; not verified on decode
        "exp": int((now + ACCESS_TOKEN_LIFETIME).timestamp()),
    }
    return jwt.encode(payload, _secret(), algorithm=ALGORITHM)


def decode_access_token(token: str, *, now: datetime | None = None) -> TokenClaims:
    """Return the claims or raise TokenExpired / TokenInvalid. Never returns None."""
    now = _resolve_now(now)
    try:
        # Signature and algorithm are checked by PyJWT (algorithm pinned, so
        # "none" and other HMAC variants are refused). All time checks are off
        # in PyJWT and exp is checked below against the injected clock. iat is
        # not verified at all: it is informational, and checking it would only
        # add clock-skew failures between servers with no security gain, since
        # exp is the control.
        payload = jwt.decode(
            token,
            _secret(),
            algorithms=[ALGORITHM],
            options={
                "verify_exp": False,
                "verify_iat": False,
                "verify_nbf": False,
                "require": ["exp", "sub", "role"],
            },
        )
        sub = payload["sub"]
        role = payload["role"]
        exp_ts = payload["exp"]
        if (
            not isinstance(sub, str)
            or not _USER_ID_RE.fullmatch(sub)
            or not isinstance(role, str)
            or isinstance(exp_ts, bool)
        ):
            raise TokenInvalid("invalid token")
        exp = datetime.fromtimestamp(exp_ts, UTC)
    except TokenInvalid:
        raise
    except (jwt.PyJWTError, ValueError, TypeError, OverflowError, OSError):
        raise TokenInvalid("invalid token") from None
    if exp <= now:
        raise TokenExpired("token expired")
    return TokenClaims(user_id=int(sub), role=role, exp=exp)


def new_refresh_token() -> tuple[str, str]:
    """Return (plaintext, sha256 hex digest). Store only the digest."""
    plain = secrets.token_urlsafe(32)  # 43 chars, 256 bits
    return plain, hashlib.sha256(plain.encode()).hexdigest()
