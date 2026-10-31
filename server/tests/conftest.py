import os
import sys
from pathlib import Path

import pytest

# Make `app` importable when pytest is run from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Test-only secrets, set unconditionally so a real secret in the developer's
# shell can never leak into a test run; set before the app is imported so Settings validates.
os.environ["JWT_SECRET"] = "test-jwt-secret-not-for-production-use-0123456789-abcdefghijklmnop"
os.environ["MEDIA_KEY"] = "test-media-key-not-for-production"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture
def db():
    """An empty in-memory SQLite database with every table created."""
    from app.db.models import Base
    from app.db.session import SessionLocal, make_engine

    engine = make_engine("sqlite://")
    Base.metadata.create_all(engine)
    with SessionLocal(bind=engine) as session:
        yield session
    engine.dispose()


@pytest.fixture
def client(db):
    """A test client whose requests use the same in-memory database as `db`."""
    from app.api import auth
    from app.db.session import get_session

    app.dependency_overrides[get_session] = lambda: db
    # The limiters are module-level; start every test with empty counters.
    auth.username_limiter.clear()
    auth.ip_limiter.clear()
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def user_factory(db):
    """Create a user directly in the database; returns the User."""
    from app.core.security import hash_password
    from app.db.models import User

    def make(
        username="sita",
        password="correct-horse-battery",
        role="enumerator",
        full_name="Sita Devi",
        is_active=True,
    ):
        user = User(
            username=username,
            password_hash=hash_password(password),
            role=role,
            full_name=full_name,
            is_active=is_active,
        )
        db.add(user)
        db.commit()
        return user

    return make


@pytest.fixture
def join_project():
    """Put a user in a project (made on first use), as the admin API would. Returns the project."""
    from sqlalchemy import select

    from app.db.models import Project, ProjectMember

    def join(db, user, name="Programme"):
        p = db.scalar(select(Project).where(Project.name == name))
        if p is None:
            p = Project(name=name)
            db.add(p)
            db.flush()
        db.add(ProjectMember(project_id=p.id, user_id=user.id))
        db.commit()
        return p

    return join
