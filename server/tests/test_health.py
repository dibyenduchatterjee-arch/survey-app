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


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("", []),
        ("http://a.test,http://b.test", ["http://a.test", "http://b.test"]),
        (" http://a.test , http://b.test ", ["http://a.test", "http://b.test"]),
        ('["http://a.test"]', ["http://a.test"]),
    ],
)
def test_cors_origins_accepts_empty_comma_and_json(monkeypatch, raw, expected):
    monkeypatch.setenv("CORS_ORIGINS", raw)
    get_settings.cache_clear()
    try:
        assert get_settings().cors_origins == expected
    finally:
        get_settings.cache_clear()


def test_settings_refuse_short_jwt_secret(monkeypatch):
    short = "tooshort-secret-0123456789"  # 26 chars
    monkeypatch.setenv("JWT_SECRET", short)
    get_settings.cache_clear()
    with pytest.raises(ValidationError) as e:
        get_settings()
    assert "at least 32 characters" in str(e.value)
    assert short not in str(e.value)  # a rejected secret must not be echoed
    get_settings.cache_clear()


def test_settings_accept_32_char_jwt_secret(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "x" * 32)
    get_settings.cache_clear()
    assert get_settings().jwt_secret.get_secret_value() == "x" * 32
    get_settings.cache_clear()
