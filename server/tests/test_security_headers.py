"""Browser security headers on every response (review finding I-6).

The console keeps an admin's refresh token in IndexedDB, so the page must not be framed and
must not run script it did not ship. The console's pages carry one inline module script each;
they are allowed by hash, never by `unsafe-inline`.
"""

import base64
import hashlib
import re

import pytest

from app import main as main_mod

WEBAPP = main_mod.WEBAPP_DIR
INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.S | re.I)


def _csp(response) -> dict[str, list[str]]:
    out = {}
    for part in response.headers["content-security-policy"].split(";"):
        words = part.split()
        if words:
            out[words[0]] = words[1:]
    return out


def _hash(script: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(script.encode()).digest()).decode() + "'"


PAGES = ["/", "/console/", "/console/users.html", "/health", "/api/forms", "/openrosa/formList", "/nothing/here.js",
         "/sw.js", "/manifest.webmanifest"]


@pytest.mark.parametrize("path", PAGES)
def test_every_response_carries_the_security_headers(client, path):
    r = client.get(path)
    h = r.headers
    assert h["x-content-type-options"] == "nosniff"
    assert h["referrer-policy"] == "no-referrer"
    assert h["strict-transport-security"].startswith("max-age=") and int(
        re.search(r"max-age=(\d+)", h["strict-transport-security"]).group(1)) >= 15552000
    assert h["x-frame-options"] == "DENY"
    csp = _csp(r)
    assert csp["frame-ancestors"] == ["'none'"]
    assert csp["base-uri"] == ["'none'"]
    assert csp["object-src"] == ["'none'"]
    assert csp["default-src"] == ["'self'"]
    assert csp["connect-src"] == ["'self'"]
    assert set(csp["img-src"]) == {"'self'", "blob:", "data:"}
    assert set(csp["media-src"]) == {"'self'", "blob:"}
    assert "'unsafe-eval'" not in r.headers["content-security-policy"]
    # Nothing is allowed inline at all. The console's inline module scripts are permitted
    # by hash, and the last inline style attribute was removed from console/js/forms.js,
    # so no directive needs 'unsafe-inline'. Keep it that way: this assertion is what
    # stops a future convenience edit reopening the hole.
    assert [d for d, v in csp.items() if "'unsafe-inline'" in v] == []


def test_no_directive_that_runs_code_or_styles_allows_unsafe_inline(client):
    for path in ("/", "/console/"):
        csp = _csp(client.get(path))
        assert csp["script-src"][0] == "'self'"
        assert csp["style-src"] == ["'self'"]
        assert all(s != "'unsafe-inline'" for s in csp["script-src"] + csp["style-src"] + csp["default-src"])


def test_the_enumerator_app_has_no_inline_script_so_nothing_is_hashed(client):
    html = (WEBAPP / "index.html").read_text(encoding="utf-8")
    assert not [s for s in INLINE_SCRIPT.findall(html) if s.strip()]
    assert _csp(client.get("/"))["script-src"] == ["'self'"]


@pytest.mark.parametrize("page", sorted(p.name for p in (WEBAPP / "console").glob("*.html")))
def test_each_console_pages_inline_script_is_allowed_by_its_hash_alone(client, page):
    html = (WEBAPP / "console" / page).read_text(encoding="utf-8")
    scripts = [s for s in INLINE_SCRIPT.findall(html) if s.strip()]
    r = client.get(f"/console/{page}")
    allowed = _csp(r)["script-src"]
    assert allowed[0] == "'self'" and sorted(allowed[1:]) == sorted(_hash(s) for s in scripts)
    assert r.content == (WEBAPP / "console" / page).read_bytes()  # served byte for byte


def test_a_page_never_borrows_another_pages_script_hash(client):
    assert _csp(client.get("/"))["script-src"] == ["'self'"]
    assert len(_csp(client.get("/console/users.html"))["script-src"]) == 2


def test_no_served_page_uses_an_inline_event_handler_which_the_policy_would_block():
    for html in [*WEBAPP.glob("*.html"), *(WEBAPP / "console").glob("*.html")]:
        assert not re.search(r"\son[a-z]+\s*=", html.read_text(encoding="utf-8")), html.name


def test_media_keeps_its_own_nosniff_exactly_once(client):
    r = client.get("/api/forms")  # any handler-built response: a header is never duplicated
    assert r.headers.get_list("x-content-type-options") == ["nosniff"]
    assert len(r.headers.get_list("content-security-policy")) == 1


def test_a_file_saved_with_windows_line_endings_hashes_as_the_browser_will_see_it():
    lf = b"<script type='module'>\nimport x from './x.js';\nx();\n</script>"
    crlf = lf.replace(b"\n", b"\r\n")
    assert main_mod.inline_script_hashes(lf) == main_mod.inline_script_hashes(crlf)
    assert main_mod.inline_script_hashes(lf) == (_hash("\nimport x from './x.js';\nx();\n")[1:-1],)


def test_external_and_empty_scripts_add_no_hash():
    assert main_mod.inline_script_hashes(b'<script type="module" src="js/app.js"></script><script> </script>') == ()
