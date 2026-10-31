import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, read from environment variables (and a local .env).

    jwt_secret and media_key deliberately have no default: a missing value must
    fail loudly at startup rather than fall back to something guessable.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./server/survey.db"
    jwt_secret: SecretStr
    media_key: SecretStr
    media_root: Path = Path("server/media")
    # Accepts empty (no extra origins), "a,b,c", or a JSON list.
    cors_origins: Annotated[list[str], NoDecode] = []
    # The single media size cap for the whole system: uploads above it are
    # rejected (Task 11) and photos are downscaled to fit below it (Task 19).
    max_media_bytes: int = 5 * 1024 * 1024

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
