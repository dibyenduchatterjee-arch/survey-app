"""Login, refresh-token rotation and logout.

Token and password primitives live in app.core.security; this module only wires
them to HTTP and the database.
"""

import ipaddress
import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.ratelimit import RateLimited, RateLimiter
from app.core.security import (
    create_access_token,
    dummy_verify,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)
from app.db.models import RefreshToken, User
from app.db.session import get_session

logger = logging.getLogger(__name__)
_warned_unconfigured_proxy = False

router = APIRouter(prefix="/api/auth", tags=["auth"])

# In-process counters (see app.core.ratelimit: not shared between worker processes).
# Every attempt is counted on entry (so parallel guesses cannot slip past a check-then-
# count gap). A successful login clears the username counter and takes back its own one
# count on the IP counter, so only failures accumulate. The IP counter is the anti-spray
# control and is never reset: someone holding one valid account must not be able to wipe
# the failures they have piled up from that address.
_settings = get_settings()
username_limiter = RateLimiter(
    _settings.login_rate_limit_per_username, _settings.login_rate_limit_window_seconds
)
ip_limiter = RateLimiter(
    _settings.login_rate_limit_per_ip, _settings.login_rate_limit_window_seconds
)

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


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status_code=401, detail=detail)


def _warn_if_unconfigured_proxy(peer: str) -> None:
    """Once per process: a private or loopback peer with trust off usually means a proxy."""
    global _warned_unconfigured_proxy
    if _warned_unconfigured_proxy:
        return
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return
    if addr.is_private or addr.is_loopback:
        _warned_unconfigured_proxy = True
        logger.warning(
            "Requests are arriving from a private or loopback address while "
            "TRUST_PROXY_HEADERS is off. If a reverse proxy (Caddy, nginx) sits in front, "
            "every client is sharing one login rate-limit bucket. Set TRUST_PROXY_HEADERS=true "
            "(and TRUSTED_PROXY_HOPS if more than one proxy) in the environment."
        )


def client_ip(request: Request, settings: Settings) -> str:
    """The caller's address, for rate limiting.

    Behind a trusted proxy the peer address is the proxy, so with
    trust_proxy_headers on we read X-Forwarded-For from the right-hand end:
    `trusted_proxy_hops` entries in. The left-most entries are whatever the client
    chose to send and are never used. Anything unusable falls back to the peer.
    """
    peer = request.client.host if request.client else "unknown"
    if not settings.trust_proxy_headers:
        _warn_if_unconfigured_proxy(peer)
        return peer
    # A proxy may add its entry as a separate header line (HAProxy forwardfor), so
    # read every line, in order, as one list; get() would return only the first line.
    header = ",".join(request.headers.getlist("x-forwarded-for"))
    if not header:
        return peer
    parts = [p.strip() for p in header.split(",")]
    if len(parts) < settings.trusted_proxy_hops:
        return peer
    candidate = parts[-settings.trusted_proxy_hops]
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return peer


def _issue_refresh_token(
    db: Session, user_id: int, now: datetime, lifetime: timedelta
) -> tuple[str, RefreshToken]:
    plain, digest = new_refresh_token()
    row = RefreshToken(
        user_id=user_id,
        token_hash=digest,
        issued_at=now,
        expires_at=now + lifetime,
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
    settings: Settings = Depends(get_settings),
) -> LoginResponse:
    ip = client_ip(request, settings)
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
    if user is None or not user.is_active or not ok:
        raise _unauthorized(_INVALID_CREDENTIALS)

    now = datetime.now(UTC)
    user.last_login_at = now
    refresh_plain, _ = _issue_refresh_token(
        db, user.id, now, timedelta(days=settings.refresh_token_days)
    )
    db.commit()
    username_limiter.reset(f"login:{body.username}")
    ip_limiter.refund(f"login:ip:{ip}")
    return LoginResponse(
        access_token=create_access_token(user.id, user.role, now=now),
        refresh_token=refresh_plain,
        user=UserOut(id=user.id, username=user.username, full_name=user.full_name, role=user.role),
    )


@router.post("/refresh", response_model=TokenPair)
def refresh(
    body: RefreshRequest,
    db: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> TokenPair:
    now = datetime.now(UTC)
    digest = hash_refresh_token(body.refresh_token)
    row = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == digest))
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

    new_plain, new_row = _issue_refresh_token(
        db, user.id, now, timedelta(days=settings.refresh_token_days)
    )
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
            RefreshToken.token_hash == hash_refresh_token(body.refresh_token),
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )
    db.commit()
    return Response(status_code=204)
