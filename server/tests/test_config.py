"""Settings must not depend on the directory the server is started from.

The bug this guards: DATABASE_URL defaulted to `sqlite:///./server/survey.db`, relative to the
working directory, so running from `server/` looked for `server/server/survey.db` and died with
"unable to open database file".
"""

import json
import os
import subprocess
import sys
from pathlib import Path

from app.core.config import PROJECT_ROOT, Settings

SERVER_DIR = Path(__file__).resolve().parents[1]
SECRETS = {"jwt_secret": "j" * 40, "media_key": "m" * 40}


def make(**kw):
    return Settings(_env_file=None, **SECRETS, **kw)


def test_the_project_root_is_the_folder_holding_server():
    assert (PROJECT_ROOT / "server" / "app" / "core" / "config.py").is_file()


def test_the_default_database_and_media_folder_sit_in_the_project_root():
    s = make()
    assert s.database_url == f"sqlite:///{(PROJECT_ROOT / 'server' / 'survey.db').as_posix()}"
    assert s.media_root == PROJECT_ROOT / "server" / "media"


def test_a_relative_sqlite_path_is_anchored_to_the_project_root():
    s = make(database_url="sqlite:///./data/x.db")
    assert s.database_url == f"sqlite:///{(PROJECT_ROOT / 'data' / 'x.db').as_posix()}"


def test_absolute_memory_and_server_databases_are_left_alone(tmp_path):
    absolute = f"sqlite:///{(tmp_path / 'a.db').as_posix()}"
    assert make(database_url=absolute).database_url == absolute
    assert make(database_url="sqlite://").database_url == "sqlite://"
    assert make(database_url="sqlite:///:memory:").database_url == "sqlite:///:memory:"
    pg = "postgresql+psycopg://survey:pw%40x@db.internal:5432/survey"
    assert make(database_url=pg).database_url == pg


def test_the_env_file_is_read_from_the_project_root_not_the_working_directory():
    assert Settings.model_config["env_file"] == PROJECT_ROOT / ".env"


def test_blank_lines_in_the_env_file_mean_use_the_default(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("MEDIA_ROOT", "")
    s = Settings(_env_file=None, **SECRETS)
    assert s.database_url.endswith("/server/survey.db")
    assert s.media_root == PROJECT_ROOT / "server" / "media"


def test_the_same_paths_come_out_whichever_folder_the_process_starts_in(tmp_path):
    """The real thing: a fresh interpreter started from three different folders."""
    code = (
        "import json; from app.core.config import get_settings; s = get_settings(); "
        "print(json.dumps([s.database_url, str(s.media_root)]))"
    )
    env = {**os.environ, "JWT_SECRET": "j" * 40, "MEDIA_KEY": "m" * 40,
           "PYTHONPATH": str(SERVER_DIR)}
    env.pop("DATABASE_URL", None)
    env.pop("MEDIA_ROOT", None)
    seen = set()
    for cwd in (PROJECT_ROOT, SERVER_DIR, tmp_path):
        out = subprocess.run([sys.executable, "-c", code], cwd=cwd, env=env, capture_output=True,
                             text=True, check=True)
        seen.add(tuple(json.loads(out.stdout)))
    assert len(seen) == 1
    url, media = next(iter(seen))
    assert url == f"sqlite:///{(PROJECT_ROOT / 'server' / 'survey.db').as_posix()}"
    assert "server/server" not in url.replace("\\", "/")
    assert Path(media) == PROJECT_ROOT / "server" / "media"
    assert (PROJECT_ROOT / "server").is_dir()  # the folder the database file goes in exists
