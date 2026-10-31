"""Login, refresh-token rotation and logout.

Token and password primitives live in app.core.security; this module only wires
them to HTTP and the database.
"""

import hashlib
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.ratelimit import RateLimited, RateLimiter
from app.core.security import (
    create_access_token,
    dummy_verify,
    new_refresh_token,
    verify_password,
)
from app.db.models import RefreshToken, User
from app.db.session import get_session

router = APIRouter(prefix="/api/auth", tags=["auth"])

REFRESH_TOKEN_LIFETIME = timedelta(days=30)

# In-process counters (see app.core.ratelimit: not shared between worker processes).
# Failed and successful attempts both count; a success clears the username's counter.
username_limiter = RateLimiter(limit=5, window_seconds=15 * 60)
ip_limiter = RateLimiter(limit=20, window_seconds=15 * 60)

_INVALID_CREDENTIALS = "Invalid username or password"
_INVALID_REFRESH = "Invalid refresh token"


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=150)
    password: str = Field(min_length=1, max_length=1024)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1, max_length=512)


class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role: str


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str


class LoginResponse(TokenPair):
    user: UserOut


def _hash_token(plain: str) -> str:
    # Same digest new_refresh_token() stores; recomputed here to look a token up.
    return hashlib.sha256(plain.encode()).hexdigest()


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status_code=401, detail=detail)


def _issue_refresh_token(db: Session, user_id: int, now: datetime) -> tuple[str, RefreshToken]:
    plain, digest = new_refresh_token()
    row = RefreshToken(
        user_id=user_id,
        token_hash=digest,
        issued_at=now,
        expires_at=now + REFRESH_TOKEN_LIFETIME,
    )
    db.add(row)
    db.flush()
    return plain, row


def _revoke_chain(db: Session, token: RefreshToken, now: datetime) -> None:
    """Revoke every token in `token`'s rotation chain, older and newer."""
    ids = {token.id}
    cur = token
    while cur.replaced_by is not None and cur.replaced_by not in ids:  # towards the newest
        ids.add(cur.replaced_by)
        cur = db.get(RefreshToken, cur.replaced_by)
        if cur is None:
            break
    cur_id = token.id
    while True:  # towards the oldest
        prev = db.scalar(select(RefreshToken.id).where(RefreshToken.replaced_by == cur_id))
        if prev is None or prev in ids:
            break
        ids.add(prev)
        cur_id = prev
    db.execute(
        update(RefreshToken)
        .where(RefreshToken.id.in_(ids), RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    db.commit()


@router.post("/login", response_model=LoginResponse)
def login(
    body: LoginRequest,
    request: Request,
    db: Session = Depends(get_session),
) -> LoginResponse:
    ip = request.client.host if request.client else "unknown"
    try:
        ip_limiter.check(f"login:ip:{ip}")
        username_limiter.check(f"login:{body.username}")
    except RateLimited as exc:
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts; try again later",
            headers={"Retry-After": str(exc.retry_after)},
        ) from None

    user = db.scalar(select(User).where(User.username == body.username))
    if user is not None and user.is_active:
        ok = verify_password(body.password, user.password_hash)
    else:
        # Unknown or deactivated: do the same amount of work, then fail the same way.
        ok = dummy_verify(body.password)
    if not ok or user is None:
        raise _unauthorized(_INVALID_CREDENTIALS)

    now = datetime.now(UTC)
    user.last_login_at = now
    refresh_plain, _ = _issue_refresh_token(db, user.id, now)
    db.commit()
    username_limiter.reset(f"login:{body.username}")
    return LoginResponse(
        access_token=create_access_token(user.id, user.role, now=now),
        refresh_token=refresh_plain,
        user=UserOut(id=user.id, username=user.username, full_name=user.full_name, role=user.role),
    )


@router.post("/refresh", response_model=TokenPair)
def refresh(body: RefreshRequest, db: Session = Depends(get_session)) -> TokenPair:
    now = datetime.now(UTC)
    row = db.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == _hash_token(body.refresh_token))
    )
    if row is None:
        raise _unauthorized(_INVALID_REFRESH)
    if row.replaced_by is not None:
        # Already rotated: this token was replayed, so treat the whole chain as stolen.
        _revoke_chain(db, row, now)
        raise _unauthorized(_INVALID_REFRESH)
    if row.revoked_at is not None or row.expires_at <= now:
        raise _unauthorized(_INVALID_REFRESH)
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        raise _unauthorized(_INVALID_REFRESH)

    new_plain, new_row = _issue_refresh_token(db, user.id, now)
    # Atomic claim: only one request can rotate a given token, so two concurrent
    # presentations cannot both succeed.
    claimed = db.execute(
        update(RefreshToken)
        .where(RefreshToken.id == row.id, RefreshToken.replaced_by.is_(None))
        .values(replaced_by=new_row.id, revoked_at=now)
    )
    if claimed.rowcount != 1:
        db.rollback()
        db.expire_all()
        row = db.get(RefreshToken, row.id)
        if row is not None:
            _revoke_chain(db, row, now)
        raise _unauthorized(_INVALID_REFRESH)
    db.commit()
    return TokenPair(
        access_token=create_access_token(user.id, user.role, now=now),
        refresh_token=new_plain,
    )


@router.post("/logout", status_code=204)
def logout(body: RefreshRequest, db: Session = Depends(get_session)) -> Response:
    """Revoke the presented refresh token. Always 204, so it reveals nothing."""
    db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.token_hash == _hash_token(body.refresh_token),
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )
    db.commit()
    return Response(status_code=204)
