"""`python -m app.cli create-admin`: the only way to make the first administrator."""

import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import select

from app import cli
from app.core.security import verify_password
from app.db.models import AuditLog, User

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def run(db):
    """Call the CLI against the test database, answering the two password prompts."""

    def go(argv, *passwords):
        answers = iter(passwords)

        @contextmanager
        def session():
            yield db

        return cli.main(argv, prompt=lambda _text: next(answers), session_factory=session)

    return go


def test_creates_an_admin_with_a_hashed_password(run, db, capsys):
    code = run(["create-admin", "--username", "boss", "--full-name", "The Boss"], "a long unusual passphrase", "a long unusual passphrase")
    assert code == 0
    u = db.scalar(select(User).where(User.username == "boss"))
    assert u.role == "admin" and u.is_active and u.full_name == "The Boss"
    assert verify_password("a long unusual passphrase", u.password_hash)
    out = capsys.readouterr()
    assert "a long unusual passphrase" not in out.out + out.err
    assert db.scalar(select(AuditLog.id).where(AuditLog.action == "user.create")) is not None


def test_the_password_is_never_accepted_as_an_argument(run, capsys):
    with pytest.raises(SystemExit) as e:
        run(["create-admin", "--username", "boss", "--password", "whatever-long-one"])
    assert e.value.code == 2


def test_the_password_policy_is_enforced_and_nothing_is_created(run, db, capsys):
    assert run(["create-admin", "--username", "boss"], "short", "short") == 1
    assert "at least 10" in capsys.readouterr().err
    assert run(["create-admin", "--username", "boss"], "password123", "password123") == 1
    assert db.scalar(select(User.id)) is None


def test_mismatched_passwords_create_nothing(run, db, capsys):
    assert run(["create-admin", "--username", "boss"], "a long unusual passphrase", "a different long phrase") == 1
    assert "differ" in capsys.readouterr().err
    assert db.scalar(select(User.id)) is None


def test_an_existing_username_is_refused_politely(run, db, user_factory, capsys):
    user_factory(username="boss", role="enumerator")
    assert run(["create-admin", "--username", "boss"], "a long unusual passphrase", "a long unusual passphrase") == 1
    err = capsys.readouterr().err
    assert "already exists" in err and "Traceback" not in err
    assert db.scalar(select(User).where(User.username == "boss")).role == "enumerator"


def test_a_username_with_spaces_is_refused(run, db, capsys):
    assert run(["create-admin", "--username", "two words"], "a long unusual passphrase", "a long unusual passphrase") == 1
    assert db.scalar(select(User.id)) is None


def test_a_missing_schema_says_to_run_the_migrations(capsys):
    from sqlalchemy.orm import Session

    from app.db.session import make_engine

    engine = make_engine("sqlite://")  # no tables at all
    with Session(engine) as empty:

        @contextmanager
        def session():
            yield empty

        code = cli.main(["create-admin", "--username", "boss"], prompt=lambda _t: "x", session_factory=session)
    engine.dispose()
    assert code == 1
    assert "alembic upgrade head" in capsys.readouterr().err


def test_the_wrapper_runs_from_any_working_directory(tmp_path):
    env = {**os.environ, "JWT_SECRET": "x" * 40, "MEDIA_KEY": "y" * 40}
    r = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "create_admin.py"), "create-admin", "--help"],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0 and "--username" in r.stdout and "--password" not in r.stdout
