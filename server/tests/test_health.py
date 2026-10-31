import pytest
from pydantic import ValidationError

from app.core.config import get_settings


def test_health_reports_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_settings_refuse_missing_secret(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    get_settings.cache_clear()
    with pytest.raises(ValidationError):
        get_settings()
