from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    cors_origins: list[str] = []
    # The single media size cap for the whole system: uploads above it are
    # rejected (Task 11) and photos are downscaled to fit below it (Task 19).
    max_media_bytes: int = 5 * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
