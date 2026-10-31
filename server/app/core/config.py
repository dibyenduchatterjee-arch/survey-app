import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, read from environment variables (and a local .env).

    jwt_secret and media_key deliberately have no default: a missing value must
    fail loudly at startup rather than fall back to something guessable.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    database_url: str = "sqlite:///./server/survey.db"
    jwt_secret: SecretStr
    media_key: SecretStr
    media_root: Path = Path("server/media")
    # Accepts empty (no extra origins), "a,b,c", or a JSON list.
    cors_origins: Annotated[list[str], NoDecode] = []
    # The single media size cap for the whole system: uploads above it are
    # rejected (Task 11) and photos are downscaled to fit below it (Task 19).
    max_media_bytes: int = 5 * 1024 * 1024
    # Reverse proxy (Caddy / nginx). Off by default: X-Forwarded-For is client-controlled
    # and is honoured only when the deployer says a trusted proxy sits in front.
    trust_proxy_headers: bool = False
    # How many trusted proxies append to X-Forwarded-For; the client IP is the
    # entry that many places from the right-hand end.
    trusted_proxy_hops: int = Field(default=1, ge=1)
    refresh_token_days: int = Field(default=30, ge=1)
    login_rate_limit_per_username: int = Field(default=5, ge=1)
    login_rate_limit_per_ip: int = Field(default=60, ge=1)
    login_rate_limit_window_seconds: int = Field(default=900, ge=1)

    @field_validator("jwt_secret")
    @classmethod
    def _jwt_secret_long_enough(cls, v: SecretStr) -> SecretStr:
        # A guessable HS256 secret lets anyone mint a token for any user and role.
        if len(v.get_secret_value()) < 32:
            raise ValueError(
                "JWT_SECRET must be at least 32 characters; generate one with "
                '`python -c "import secrets; print(secrets.token_urlsafe(48))"`'
            )
        return v

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _parse_cors_origins(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if not v:
                return []
            if v.startswith("["):
                return json.loads(v)
            return [o.strip() for o in v.split(",") if o.strip()]
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()
