"""Authentication and role enforcement for protected routes.

The role that decides access is always the one in the database. The token's `role`
claim is for UI convenience only and is never compared here: a forged, stale or
demoted claim must not grant anything. The user row is also loaded fresh on every
request so a deactivated account loses access at once, instead of keeping it until
its access token expires.

No token, a bad token, an expired token, an unknown user and a deactivated user are
all 401 (the caller is not authenticated). A real, active user without the needed
role is 403.
"""

from collections.abc import Callable

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.security import TokenInvalid, decode_access_token
from app.db.models import User
from app.db.session import get_session

ROLES = frozenset({"admin", "supervisor", "enumerator"})

# auto_error=False so a missing header is our 401, not the library's default.
_bearer = HTTPBearer(auto_error=False)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_session),
) -> User:
    if creds is None or not creds.credentials:
        raise _unauthorized()
    try:
        claims = decode_access_token(creds.credentials)  # TokenExpired is a TokenInvalid
    except TokenInvalid:
        raise _unauthorized() from None
    user = db.get(User, claims.user_id)
    if user is None or not user.is_active:
        raise _unauthorized()
    return user


def require_role(*roles: str) -> Callable[..., User]:
    allowed = frozenset(roles)
    if not allowed or not allowed <= ROLES:
        raise ValueError("require_role needs one or more of: admin, supervisor, enumerator")

    def dependency(user: User = Depends(current_user)) -> User:
        if user.role not in allowed:  # the database value, never the token claim
            raise HTTPException(status_code=403, detail="Forbidden")
        return user

    return dependency
