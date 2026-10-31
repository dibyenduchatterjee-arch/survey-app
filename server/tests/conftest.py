import os
import sys
from pathlib import Path

import pytest

# Make `app` importable when pytest is run from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Test-only secrets; set before the app is imported so Settings validates.
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-not-for-production")
os.environ.setdefault("MEDIA_KEY", "test-media-key-not-for-production")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture
def client():
    return TestClient(app)
