import base64
import hashlib
import logging
import mimetypes
import re
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractContextManager, asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy import update
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api import admin, auth, exports, forms, openrosa, submissions
from app.core.config import PROJECT_ROOT
from app.db.models import ExportJob
from app.db.session import SessionLocal

log = logging.getLogger(__name__)

# The ONLY directory the server will serve files from: <repo>/webapp. Not the repository root
# (.env, .git, the database), not server/, not shared/.
WEBAPP_DIR = PROJECT_ROOT / "webapp"
_API_PREFIXES = ("api", "openrosa", "health")


def fail_orphaned_export_jobs(session_factory: Callable[[], AbstractContextManager[Session]] = SessionLocal) -> int:
    """A job still `running` when the server starts belongs to a process that no longer exists.

    Mark it failed, with a reason, so nobody waits on it forever. Returns how many were changed.
    Jobs that are `pending` are left alone: they never started, and nothing says they are dead.
    """
    try:
        with session_factory() as db:
            result = db.execute(
                update(ExportJob)
                .where(ExportJob.status == "running")
                .values(status="failed", error="The server restarted while this export was running. Please start it again.")
            )
            db.commit()
            changed = result.rowcount or 0
    except (OperationalError, ProgrammingError):  # no tables yet: migrations have not been run
        log.warning("could not check for interrupted export jobs; has `alembic upgrade head` been run?")
        return 0
    if changed:
        log.warning("marked %d export job(s) interrupted by a restart as failed", changed)
    return changed


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    fail_orphaned_export_jobs()
    yield


# ---- browser security headers ----------------------------------------------------------------
#
# The console holds an admin's refresh token in IndexedDB, readable by any script on the origin,
# and its buttons (deactivate a user, start an export) must not be clickjackable. So every
# response says: never framed, never sniffed, no referrer, HTTPS only, and run only script this
# server shipped. The console pages each carry one inline module script; it is allowed by
# its hash (computed from the file being served), never by 'unsafe-inline'. Nothing else is
# allowed inline either: the last inline style attribute (console/js/forms.js indenting
# nested questions) now goes through el.style, so no directive carries 'unsafe-inline'.

_INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>", re.S | re.I)
_NO_CSP_PATHS = ("/docs", "/redoc")  # FastAPI's own pages load a CDN and inline script


def content_security_policy(script_hashes: tuple[str, ...] = ()) -> str:
    return "; ".join(
        [
            "default-src 'self'",
            "script-src 'self'" + "".join(f" '{h}'" for h in script_hashes),
            "style-src 'self'",
            "img-src 'self' blob: data:",  # data: is the manifest icon
            "media-src 'self' blob:",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )


_STATIC_HEADERS = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
}


def inline_script_hashes(html: bytes) -> tuple[str, ...]:
    """CSP source hashes ('sha256-...') of the page's inline scripts, in document order."""
    found = []
    for body in _INLINE_SCRIPT.findall(html.decode("utf-8", "replace")):
        if body.strip():
            # A browser's HTML parser turns CRLF and CR into LF before it hashes the script text.
            body = body.replace(chr(13) + chr(10), chr(10)).replace(chr(13), chr(10))
            digest = hashlib.sha256(body.encode("utf-8")).digest()
            found.append("sha256-" + base64.b64encode(digest).decode("ascii"))
    return tuple(dict.fromkeys(found))


class SecurityHeadersMiddleware:
    """Adds the headers above to every HTTP response unless the handler already set that header."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in _STATIC_HEADERS.items():
                    if name not in headers:
                        headers[name] = value
                if "content-security-policy" not in headers and not path.startswith(_NO_CSP_PATHS):
                    headers["content-security-policy"] = content_security_policy()
            await send(message)

        await self.app(scope, receive, send_with_headers)


app = FastAPI(title="Evidence Action survey platform", lifespan=lifespan)
app.add_middleware(SecurityHeadersMiddleware)
app.include_router(auth.router)
app.include_router(forms.router)
app.include_router(submissions.router)
app.include_router(openrosa.router)
app.include_router(exports.router)
app.include_router(admin.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _safe_file(root: Path, segments: list[str]) -> Path | None:
    """The file under `root` for these URL segments, or None. Never anything outside `root`."""
    if any(s in ("..", ".") or s.startswith(".") or "\\" in s or "\0" in s or ":" in s for s in segments):
        return None
    if segments[0] == "tests":  # the browser test harness lives in webapp/ but is not part of the app
        return None
    candidate = root.joinpath(*segments)
    try:
        real = candidate.resolve(strict=True)  # follows symlinks: a link out of webapp/ ends up outside
    except (OSError, ValueError):
        return None
    if not real.is_relative_to(root) or not real.is_file():
        return None
    return real


def mount_webapp(target: FastAPI, webapp_dir: Path = WEBAPP_DIR) -> None:
    """Serve the browser app: the enumerator app at `/`, the console at `/console/`.

    Registered last, so every real route (`/api/`, `/openrosa/`, `/health`) wins. A path that is
    not a file and has no extension is a client-side route (a deep link) and gets the `index.html`
    of the app it is under; a missing file with an extension is a plain 404.
    """
    root = webapp_dir.resolve()

    @target.get("/{path:path}", include_in_schema=False)
    def static_app(path: str, request: Request) -> FileResponse:
        segments = [s for s in path.split("/") if s]
        if segments and segments[0] in _API_PREFIXES:
            raise HTTPException(status_code=404, detail="Not Found")
        hit = _safe_file(root, segments) if segments else None
        if hit is None:
            last = segments[-1] if segments else ""
            if "." in last or any(s.startswith(".") or s in ("..", ".") or "\\" in s or "\0" in s for s in segments):
                raise HTTPException(status_code=404, detail="Not Found")
            hit = _safe_file(root, ["console", "index.html"] if segments[:1] == ["console"] else ["index.html"])
            if hit is None:
                raise HTTPException(status_code=404, detail="Not Found")
        media_type = mimetypes.guess_type(hit.name)[0]
        if hit.suffix == ".webmanifest":
            media_type = "application/manifest+json"
        # `no-cache` = revalidate every time: a new release (and a new service worker) is seen at once.
        headers = {"Cache-Control": "no-cache"}
        if hit.suffix == ".html":  # its own inline scripts, by hash, and no one else's
            headers["Content-Security-Policy"] = content_security_policy(inline_script_hashes(hit.read_bytes()))
        return FileResponse(hit, media_type=media_type, headers=headers)


mount_webapp(app)
