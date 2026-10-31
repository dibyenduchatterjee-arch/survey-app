"""Credential and token primitives: password hashing, access JWTs, refresh tokens.

Pure functions only: no database access and no HTTP concerns. Time enters as a
parameter (`now`), never ambient, so expiry is testable without a clock mock.

Nothing here puts a password, token or secret into an exception message or log.
"""

import hashlib
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


class TokenInvalid(Exception):
    """The token is malformed, wrongly signed, or has bad claims."""


class TokenExpired(TokenInvalid):
    """The token is genuine but past its expiry."""


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


def _secret() -> str:
    return get_settings().jwt_secret.get_secret_value()


def create_access_token(user_id: int, role: str, *, now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + ACCESS_TOKEN_LIFETIME).timestamp()),
    }
    return jwt.encode(payload, _secret(), algorithm=ALGORITHM)


def decode_access_token(token: str, *, now: datetime | None = None) -> TokenClaims:
    """Return the claims or raise TokenExpired / TokenInvalid. Never returns None."""
    now = now or datetime.now(UTC)
    try:
        # Signature and algorithm are checked by PyJWT (algorithm pinned, so
        # "none" and other HMAC variants are refused). Expiry is checked below
        # against the injected clock, so PyJWT's own wall-clock check is off.
        payload = jwt.decode(
            token,
            _secret(),
            algorithms=[ALGORITHM],
            options={"verify_exp": False, "require": ["exp", "sub", "role"]},
        )
        user_id = int(payload["sub"])
        role = payload["role"]
        exp_ts = payload["exp"]
        if not isinstance(role, str) or isinstance(exp_ts, bool):
            raise TokenInvalid("invalid token")
        exp = datetime.fromtimestamp(exp_ts, UTC)
    except TokenInvalid:
        raise
    except (jwt.PyJWTError, ValueError, TypeError, OverflowError, OSError):
        raise TokenInvalid("invalid token") from None
    if exp <= now:
        raise TokenExpired("token expired")
    return TokenClaims(user_id=user_id, role=role, exp=exp)


def new_refresh_token() -> tuple[str, str]:
    """Return (plaintext, sha256 hex digest). Store only the digest."""
    plain = secrets.token_urlsafe(32)  # 43 chars, 256 bits
    return plain, hashlib.sha256(plain.encode()).hexdigest()
