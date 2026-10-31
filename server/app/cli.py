"""Command line for the one thing that cannot be done through the API: the first administrator.

    python -m app.cli create-admin --username NAME [--full-name "Full Name"]

Run from the `server` folder, or from anywhere with `python tools/create_admin.py create-admin ...`.
The password is asked for twice at a hidden prompt and is never an argument, so it cannot end
up in shell history or in a process listing. It must pass the same policy as the console.
"""

import argparse
import getpass
import sys
from collections.abc import Callable
from contextlib import AbstractContextManager
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.api.admin import check_password_policy
from app.core.security import hash_password
from app.db.models import AuditLog, User
from app.db.session import SessionLocal

SessionFactory = Callable[[], AbstractContextManager[Session]]


def _fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def create_admin(username: str, full_name: str, prompt: Callable[[str], str], session_factory: SessionFactory) -> int:
    username = username.strip()
    if not username or len(username) > 150 or any(c.isspace() for c in username):
        return _fail("The username must be 1 to 150 characters with no spaces. Nothing was created.")
    full_name = (full_name or username).strip()[:255]
    try:
        with session_factory() as db:
            if db.scalar(select(User.id).where(User.username == username)) is not None:
                return _fail(f"The username '{username}' already exists. Nothing was created.")
            password = prompt("Password (at least 10 characters; typing is hidden): ")
            if password != prompt("Type the password again: "):
                return _fail("The two passwords differ. Nothing was created.")
            try:
                check_password_policy(password)
            except HTTPException as e:
                return _fail(f"{e.detail} Nothing was created.")
            user = User(
                username=username, password_hash=hash_password(password), role="admin",
                full_name=full_name, phone=None, is_active=True,
            )
            db.add(user)
            db.flush()
            db.add(
                AuditLog(
                    at=datetime.now(UTC), actor_user_id=None, action="user.create", object_type="user",
                    object_id=str(user.id), ip=None, user_agent="cli",
                    detail_json={"username": username, "role": "admin", "via": "app.cli create-admin"},
                )
            )
            db.commit()
    except (OperationalError, ProgrammingError):
        return _fail("The database has no tables yet. Run `python -m alembic upgrade head` in the server folder first.")
    print(f"Admin '{username}' created. You can now sign in to the console.")
    return 0


def main(
    argv: list[str] | None = None,
    *,
    prompt: Callable[[str], str] = getpass.getpass,
    session_factory: SessionFactory = SessionLocal,
) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description="Evidence Action survey platform: administration")
    sub = parser.add_subparsers(dest="command", required=True)
    ca = sub.add_parser("create-admin", help="create an administrator; the password is asked for, never passed")
    ca.add_argument("--username", required=True)
    ca.add_argument("--full-name", default="", help="defaults to the username")
    args = parser.parse_args(argv)
    return create_admin(args.username, args.full_name, prompt, session_factory)


if __name__ == "__main__":
    sys.exit(main())
