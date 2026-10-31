"""Administration: users, form assignments and a read-only view of the audit trail.

Every route here is admin-only, decided in the route layer from the role in the
database (see app.core.rbac). Each change and its audit row are written in one commit.

Two rules protect the system from its own administrators:

* Deactivating a user (or resetting their password) revokes all of their refresh tokens
  in the same transaction. Without that, a deactivated enumerator could keep refreshing
  and the access-token check would be the only thing standing in the way.
* The last active admin can be neither deactivated nor demoted. Locking every
  administrator out cannot be undone without direct database access.

Password hashes never leave the server: no response model has a password field.
The audit router has GET routes only; audit rows are never updated or deleted.
"""

from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import audit
from app.core.rbac import require_role
from app.core.security import hash_password
from app.db.models import Assignment, AuditLog, Form, RefreshToken, User
from app.db.session import get_session

router = APIRouter(prefix="/api", tags=["admin"])

_admin = require_role("admin")

Role = Literal["admin", "supervisor", "enumerator"]

MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 1024  # argon2 cost grows with input; nobody needs more

# Obvious choices, compared in lower case. A password is also refused when it is one of
# these with only digits or punctuation added ("password123", "Qwerty!!").
_COMMON_PASSWORDS = frozenset(
    {
        "password", "passw0rd", "p@ssword", "p@ssw0rd", "passwords", "letmein", "welcome",
        "qwerty", "qwertyuiop", "qwertyuiop123", "asdfghjkl", "zxcvbnm", "iloveyou",
        "admin", "administrator", "changeme", "default", "secret", "abc123", "monkey",
        "dragon", "football", "baseball", "master", "login", "welcome1", "bihar", "patna",
        "india", "india123", "evidenceaction", "evac", "survey", "namaste", "12345678",
        "123456789", "1234567890", "0123456789", "0987654321", "11111111", "00000000",
        "1q2w3e4r", "1qaz2wsx",
    }
)


def check_password_policy(password: str) -> None:
    """Raise a 422 that says what is wrong, without echoing the password back."""
    problems: list[str] = []
    if len(password) < MIN_PASSWORD_LENGTH:
        problems.append(f"Password must be at least {MIN_PASSWORD_LENGTH} characters long.")
    if len(password) > MAX_PASSWORD_LENGTH:
        problems.append(f"Password must be at most {MAX_PASSWORD_LENGTH} characters long.")
    lowered = password.lower()
    core = "".join(c for c in lowered if c.isalpha())
    if (
        lowered in _COMMON_PASSWORDS
        or core in _COMMON_PASSWORDS
        or len(set(password)) == 1
    ):
        problems.append(
            "Password is too common to be safe; choose something less predictable, "
            "such as three or four unrelated words."
        )
    if problems:
        raise HTTPException(status_code=422, detail=" ".join(problems))


# ---- schemas ---------------------------------------------------------------


class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role: str
    phone: str | None
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None


def _user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        full_name=user.full_name,
        role=user.role,
        phone=user.phone,
        is_active=user.is_active,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
    )


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=150, pattern=r"^\S+$")
    # Plain str on purpose: a pydantic length/validator error would echo the submitted
    # value back in the 422 body. check_password_policy() judges it instead.
    password: str
    role: Role
    full_name: str = Field(min_length=1, max_length=255)
    phone: str | None = Field(default=None, max_length=30)


class UserPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    is_active: bool | None = None
    role: Role | None = None
    password: str | None = None
    full_name: str | None = Field(default=None, min_length=1, max_length=255)
    phone: str | None = Field(default=None, max_length=30)


class AssignmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: int
    form_id: str = Field(min_length=1, max_length=150)  # the form's public id


class AssignmentOut(BaseModel):
    id: int
    user_id: int
    form_id: str


class AuditEntry(BaseModel):
    id: int
    at: datetime
    actor_user_id: int | None
    action: str
    object_type: str | None
    object_id: str | None
    ip: str | None
    user_agent: str | None
    detail: dict[str, Any] | None


class AuditPage(BaseModel):
    items: list[AuditEntry]
    total: int
    limit: int
    offset: int


# ---- users -----------------------------------------------------------------


def _revoke_all_refresh_tokens(db: Session, user_id: int) -> int:
    result = db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    return result.rowcount or 0


@router.get("/users", response_model=list[UserOut])
def list_users(
    _: User = Depends(_admin), db: Session = Depends(get_session)
) -> list[UserOut]:
    return [_user_out(u) for u in db.scalars(select(User).order_by(User.id))]


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(
    body: UserCreate,
    request: Request,
    admin_user: User = Depends(_admin),
    db: Session = Depends(get_session),
) -> UserOut:
    check_password_policy(body.password)
    if db.scalar(select(User.id).where(User.username == body.username)) is not None:
        raise HTTPException(status_code=409, detail="That username is already taken")
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role=body.role,
        full_name=body.full_name,
        phone=body.phone,
        is_active=True,
    )
    db.add(user)
    try:
        db.flush()
        audit.record(
            db, admin_user.id, "user.create", "user", user.id, request,
            {"username": user.username, "role": user.role},
        )
        db.commit()
    except IntegrityError:  # a concurrent create with the same username
        db.rollback()
        raise HTTPException(status_code=409, detail="That username is already taken") from None
    return _user_out(user)


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    body: UserPatch,
    request: Request,
    admin_user: User = Depends(_admin),
    db: Session = Depends(get_session),
) -> UserOut:
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(status_code=422, detail="Nothing to change: send at least one field")
    if "password" in changes:
        check_password_policy(changes["password"])
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    new_role = changes.get("role", user.role)
    new_active = changes.get("is_active", user.is_active)
    loses_admin = user.role == "admin" and user.is_active and not (new_role == "admin" and new_active)
    if loses_admin:
        # Lock the active admin rows (a no-op on SQLite) so two admins cannot each
        # remove the other at the same moment and leave none.
        admins = db.scalars(
            select(User.id).where(User.role == "admin", User.is_active.is_(True)).with_for_update()
        ).all()
        if not any(a != user.id for a in admins):
            raise HTTPException(
                status_code=409,
                detail="This is the last active admin; make another user an active admin first",
            )

    detail: dict[str, Any] = {}
    for field in ("role", "is_active", "full_name", "phone"):
        if field in changes and changes[field] != getattr(user, field):
            detail[field] = {"from": getattr(user, field), "to": changes[field]}
            setattr(user, field, changes[field])
    revoke = False
    if "password" in changes:
        user.password_hash = hash_password(changes["password"])
        detail["credential_reset"] = True  # the value itself is never recorded
        revoke = True
    if "is_active" in detail and not user.is_active:
        revoke = True
    if revoke:
        revoked = _revoke_all_refresh_tokens(db, user.id)
        if revoked:
            detail["sessions_revoked"] = revoked
    audit.record(db, admin_user.id, "user.update", "user", user.id, request, detail)
    db.commit()
    return _user_out(user)


# ---- assignments -----------------------------------------------------------


@router.post("/assignments", response_model=AssignmentOut, status_code=201)
def create_assignment(
    body: AssignmentCreate,
    request: Request,
    admin_user: User = Depends(_admin),
    db: Session = Depends(get_session),
) -> AssignmentOut:
    if db.get(User, body.user_id) is None:
        raise HTTPException(status_code=404, detail="User not found")
    form = db.scalar(select(Form).where(Form.form_id == body.form_id))
    if form is None:
        raise HTTPException(status_code=404, detail="Form not found")
    exists = db.scalar(
        select(Assignment.id).where(Assignment.user_id == body.user_id, Assignment.form_id == form.id)
    )
    if exists is not None:
        raise HTTPException(status_code=409, detail="That user is already assigned to this form")
    row = Assignment(user_id=body.user_id, form_id=form.id)
    db.add(row)
    try:
        db.flush()
        audit.record(
            db, admin_user.id, "assignment.create", "assignment", row.id, request,
            {"user_id": body.user_id, "form_id": form.form_id},
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="That user is already assigned to this form"
        ) from None
    return AssignmentOut(id=row.id, user_id=row.user_id, form_id=form.form_id)


@router.delete("/assignments/{assignment_id}", status_code=204)
def delete_assignment(
    assignment_id: int,
    request: Request,
    admin_user: User = Depends(_admin),
    db: Session = Depends(get_session),
) -> Response:
    row = db.get(Assignment, assignment_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    form_key = db.scalar(select(Form.form_id).where(Form.id == row.form_id))
    detail = {"user_id": row.user_id, "form_id": form_key}
    db.delete(row)
    audit.record(db, admin_user.id, "assignment.delete", "assignment", assignment_id, request, detail)
    db.commit()
    return Response(status_code=204)


# ---- audit (read-only: GET routes only) ------------------------------------

audit_router = APIRouter(prefix="/audit", tags=["audit"])


@audit_router.get("", response_model=AuditPage)
def list_audit(
    actor_id: int | None = None,
    action: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _: User = Depends(_admin),
    db: Session = Depends(get_session),
) -> AuditPage:
    conditions = []
    if actor_id is not None:
        conditions.append(AuditLog.actor_user_id == actor_id)
    if action is not None:
        conditions.append(AuditLog.action == action)
    total = db.scalar(select(func.count()).select_from(AuditLog).where(*conditions)) or 0
    rows = db.scalars(
        select(AuditLog).where(*conditions).order_by(AuditLog.id.desc()).limit(limit).offset(offset)
    ).all()
    return AuditPage(
        items=[
            AuditEntry(
                id=r.id,
                at=r.at,
                actor_user_id=r.actor_user_id,
                action=r.action,
                object_type=r.object_type,
                object_id=r.object_id,
                ip=r.ip,
                user_agent=r.user_agent,
                detail=r.detail_json,
            )
            for r in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


router.include_router(audit_router)
