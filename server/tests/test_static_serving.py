"""The server serves webapp/ itself: enumerator app at /, console at /console/."""

import pytest

from app import main as main_mod


def test_the_enumerator_app_loads_at_the_root(client):
    r = client.get("/")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert (main_mod.WEBAPP_DIR / "index.html").read_bytes() == r.content


def test_the_console_loads(client):
    for path in ("/console/", "/console"):
        r = client.get(path)
        assert r.status_code == 200 and "text/html" in r.headers["content-type"]
        assert (main_mod.WEBAPP_DIR / "console" / "index.html").read_bytes() == r.content


def test_assets_are_served_with_the_right_type(client):
    assert client.get("/manifest.webmanifest").status_code == 200
    r = client.get("/console/console.css")
    assert r.status_code == 200 and "text/css" in r.headers["content-type"]
    assert client.get("/sw.js").status_code == 200


def test_a_deep_link_serves_the_index_not_a_404(client):
    r = client.get("/forms/amb_asha_visit/fill")
    assert r.status_code == 200 and r.content == (main_mod.WEBAPP_DIR / "index.html").read_bytes()
    r = client.get("/console/projects/7")
    assert r.status_code == 200 and r.content == (main_mod.WEBAPP_DIR / "console" / "index.html").read_bytes()


def test_a_missing_file_with_an_extension_is_a_404(client):
    assert client.get("/js/nothing-here.js").status_code == 404
    assert client.get("/console/js/nothing-here.js").status_code == 404


def test_api_and_openrosa_keep_precedence(client):
    assert client.get("/health").json() == {"status": "ok"}
    r = client.get("/api/forms")
    assert r.status_code == 401 and r.headers["content-type"].startswith("application/json")
    r = client.get("/api/no-such-route")
    assert r.status_code == 404 and r.headers["content-type"].startswith("application/json")
    r = client.get("/openrosa/no-such-route")
    assert r.status_code == 404 and "text/html" not in r.headers["content-type"]
    assert client.get("/openrosa/formList").status_code in (401, 403, 404)


@pytest.mark.parametrize(
    "path",
    [
        "/../server/app/main.py", "/%2e%2e/server/app/main.py", "/%2e%2e%2f%2e%2e%2fserver/app/main.py",
        "/console/../../server/app/main.py", "/console/%2e%2e/%2e%2e/.env", "/..%5c..%5cserver%5capp%5cmain.py",
        "/.env", "/console/.env", "/.git/config", "/%00", "/server/app/main.py", "/README.md",
        "/package.json", "/tests/browser_console.js",
    ],
)
def test_nothing_outside_webapp_is_served(client, path):
    r = client.get(path)
    body = r.content
    assert b"FastAPI(" not in body and b"JWT_SECRET" not in body
    if r.status_code == 200:  # only ever the SPA fallback, never a repository file
        assert body == (main_mod.WEBAPP_DIR / "index.html").read_bytes()


def test_a_symlink_inside_webapp_cannot_lead_out(client, tmp_path, monkeypatch):
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP-SECRET")
    root = tmp_path / "webapp"
    root.mkdir()
    (root / "index.html").write_text("<html>home</html>")
    try:
        (root / "leak.txt").symlink_to(secret)
    except OSError:
        pytest.skip("symlinks need privileges on this machine")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app2 = FastAPI()
    main_mod.mount_webapp(app2, root)
    r = TestClient(app2).get("/leak.txt")
    assert b"TOP-SECRET" not in r.content and r.status_code in (403, 404)
