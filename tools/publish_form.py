"""Compile an XLSForm on this laptop and publish it to a project's Google Drive folder.

    .\\.venv\\Scripts\\python.exe tools\\publish_form.py --xlsx "path\\to\\form.xlsx" --project-folder <drive_folder_id>

There is no server: the phone app reads forms straight from Drive. XLSForm compilation is Python
(pyxform), so it happens here, once, and the finished spec is what goes to Drive.

What it does, in this order
    1. Compile with the same, already-tested pipeline the server used
       (app.forms.xlsform.to_xform, then app.forms.compile.compile_spec). A form the evaluator cannot
       run, or that repeats a field name, is refused here, naming the question.
    2. Add the automatic metadata (app.forms.autometa).
    3. Work out the version (YYYYMMDDNN) from the spec already in the folder, if any.
    4. Only now touch Drive: <form_id>.xlsx first, then <form_id>.spec.json. A form that fails any
       earlier step never reaches Drive, because devices download whatever is there.
    A second publish of the same form updates the same two Drive files (a new Drive version of each),
    so their ids and any links to them stay the same.

Credentials: a Google service-account key file, named by GOOGLE_SERVICE_ACCOUNT_FILE or --credentials.
Its contents are never printed.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from googleapiclient.errors import HttpError  # noqa: E402

from app.export.drive import redact  # noqa: E402
from app.forms.autometa import inject_auto_metadata  # noqa: E402
from app.forms.compile import FormCompileError, compile_spec  # noqa: E402
from app.forms.expr import UnsupportedExpression  # noqa: E402
from app.forms.xlsform import XLSFormError, to_xform  # noqa: E402

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
JSON_MIME = "application/json"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
MAX_VERSIONS_PER_DAY = 99

SHARED_DRIVE_MESSAGE = """\
Drive refused the upload: storageQuotaExceeded.

A service account has no storage of its own, so it cannot put files in a folder in a personal
My Drive. Fix:
  1. Create (or choose) a Shared Drive and move the project folder into it.
  2. Add the service account's email address to that Shared Drive as a Content manager.
  3. Run this command again, with the id of the folder inside the Shared Drive.
(Sharing a My Drive folder with the service account as Editor does not fix this.)"""


class PublishError(Exception):
    """Something the user must fix. The message is safe to print."""


# ---------------------------------------------------------------- compile (no Drive involved)

def question_count(nodes: list[dict]) -> int:
    n = 0
    for node in nodes:
        if node["type"] in ("group", "repeat"):
            n += question_count(node.get("children", []))
        elif node["type"] != "calculate" and not node.get("auto"):
            n += 1
    return n


def compile_xlsx(data: bytes) -> dict:
    """The compiled spec with automatic metadata, or PublishError naming what is wrong."""
    try:
        return inject_auto_metadata(compile_spec(to_xform(data)))
    except XLSFormError as e:
        raise PublishError("The spreadsheet is not a valid XLSForm:\n  " + "\n  ".join(e.messages)) from None
    except UnsupportedExpression as e:
        question = getattr(e, "question", None)
        where = f"question '{question}'" if question else "a question"
        raise PublishError(f"{where} uses an expression this system cannot run: {e}") from None
    except FormCompileError as e:
        raise PublishError(f"The form cannot be published: {e}") from None


def next_version(existing_spec: bytes | None, today: str) -> str:
    """YYYYMMDDNN: one more than the highest version already published today."""
    last = 0
    if existing_spec is not None:
        try:
            current = str(json.loads(existing_spec.decode("utf-8")).get("version", ""))
        except (ValueError, AttributeError):
            current = ""
        if re.fullmatch(r"\d{10}", current) and current.startswith(today):
            last = int(current[8:])
    if last >= MAX_VERSIONS_PER_DAY:
        raise PublishError(f"Already published {MAX_VERSIONS_PER_DAY} versions of this form today; try tomorrow.")
    return f"{today}{last + 1:02d}"


# ---------------------------------------------------------------- Drive

class DriveFolder:
    """The real Drive client. Tests pass a fake with the same four methods."""

    def __init__(self, service: Any):
        self._svc = service

    def find(self, folder_id: str, name: str) -> dict | None:
        safe = name.replace("\\", "\\\\").replace("'", "\\'")
        res = self._svc.files().list(
            q=f"'{folder_id}' in parents and name = '{safe}' and trashed = false",
            fields="files(id, webViewLink)",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
            pageSize=2,
        ).execute()
        files = res.get("files", [])
        return {"id": files[0]["id"], "link": files[0].get("webViewLink", "")} if files else None

    def read(self, file_id: str) -> bytes:
        return self._svc.files().get_media(fileId=file_id, supportsAllDrives=True).execute()

    def _media(self, data: bytes, mime: str) -> Any:
        from googleapiclient.http import MediaIoBaseUpload

        return MediaIoBaseUpload(io.BytesIO(data), mimetype=mime, resumable=False)

    def create(self, folder_id: str, name: str, data: bytes, mime: str) -> dict:
        r = self._svc.files().create(
            body={"name": name, "parents": [folder_id]},
            media_body=self._media(data, mime),
            fields="id, webViewLink",
            supportsAllDrives=True,
        ).execute()
        return {"id": r["id"], "link": r.get("webViewLink", "")}

    def update(self, file_id: str, data: bytes, mime: str) -> dict:
        r = self._svc.files().update(
            fileId=file_id,
            media_body=self._media(data, mime),
            fields="id, webViewLink",
            supportsAllDrives=True,
        ).execute()
        return {"id": r["id"], "link": r.get("webViewLink", "")}


def build_drive(credentials: str | None) -> DriveFolder:
    path = credentials or os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE")
    if not path:
        raise PublishError(
            "No Google credentials. Set the GOOGLE_SERVICE_ACCOUNT_FILE environment variable to the path of "
            "the service-account key file, or pass --credentials <path>."
        )
    if not Path(path).is_file():
        raise PublishError(f"The service-account key file was not found: {path}")
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build

        creds = service_account.Credentials.from_service_account_file(path, scopes=[DRIVE_SCOPE])
        return DriveFolder(build("drive", "v3", credentials=creds, cache_discovery=False))
    except Exception:
        # No cause and no library text: either could quote the key file.
        raise PublishError(f"The service-account key file could not be used: {path}") from None


def _drive_failure(e: HttpError) -> PublishError:
    raw = ""
    try:
        raw = e.content.decode("utf-8", "replace")
    except AttributeError:
        pass
    if "storageQuotaExceeded" in raw or "do not have storage quota" in raw:
        return PublishError(SHARED_DRIVE_MESSAGE)
    try:
        detail = json.loads(raw)["error"]["message"]
    except (ValueError, KeyError, TypeError):
        detail = "no detail"
    status = getattr(e.resp, "status", "?")
    return PublishError(f"Drive refused the request (HTTP {status}): {redact(str(detail))[:500]}")


def _put(drive: Any, folder_id: str, name: str, data: bytes, mime: str, existing: dict | None) -> dict:
    return drive.update(existing["id"], data, mime) if existing else drive.create(folder_id, name, data, mime)


# ---------------------------------------------------------------- command line

def publish(xlsx: Path, folder_id: str, drive: Any, today: str) -> tuple[dict, dict]:
    """Compile, then upload. Returns (spec, {"xlsx": file, "spec": file})."""
    try:
        data = xlsx.read_bytes()
    except FileNotFoundError:
        raise PublishError(f"The spreadsheet was not found: {xlsx}") from None
    spec = compile_xlsx(data)
    form_id = spec.get("form_id", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", form_id):
        raise PublishError("The form needs a form_id (settings sheet) of letters, digits, _ . or - only.")
    xlsx_name, spec_name = f"{form_id}.xlsx", f"{form_id}.spec.json"

    try:
        old_spec = drive.find(folder_id, spec_name)
        old_xlsx = drive.find(folder_id, xlsx_name)
        spec["version"] = next_version(drive.read(old_spec["id"]) if old_spec else None, today)
        spec_bytes = json.dumps(spec, ensure_ascii=False, indent=1).encode("utf-8")
        # The spreadsheet first: it is only the source. The spec is what devices download, so it goes last.
        x = _put(drive, folder_id, xlsx_name, data, XLSX_MIME, old_xlsx)
        s = _put(drive, folder_id, spec_name, spec_bytes, JSON_MIME, old_spec)
    except HttpError as e:
        raise _drive_failure(e) from None
    return spec, {"xlsx": x, "spec": s}


def main(argv: list[str] | None = None, drive: Any = None, today: str | None = None) -> int:
    ap = argparse.ArgumentParser(description="Compile an XLSForm and publish it to a Drive project folder.")
    ap.add_argument("--xlsx", required=True, type=Path, help="the XLSForm spreadsheet")
    ap.add_argument("--project-folder", required=True, help="Drive id of the project's folder")
    ap.add_argument("--credentials", help="service-account key file (default: $GOOGLE_SERVICE_ACCOUNT_FILE)")
    ap.add_argument("--dry-run", action="store_true", help="check the form; upload nothing")
    args = ap.parse_args(argv)
    today = today or datetime.now(UTC).strftime("%Y%m%d")

    try:
        if args.dry_run:
            try:
                spec = compile_xlsx(args.xlsx.read_bytes())
            except FileNotFoundError:
                raise PublishError(f"The spreadsheet was not found: {args.xlsx}") from None
            print(f"DRY RUN: nothing was uploaded.\n"
                  f"  Form id:    {spec['form_id']}\n"
                  f"  Questions:  {question_count(spec['nodes'])} questions (plus the automatic fields)\n"
                  f"  The form compiles and is ready to publish.")
            return 0
        if not args.xlsx.is_file():
            raise PublishError(f"The spreadsheet was not found: {args.xlsx}")
        if drive is None:
            drive = build_drive(args.credentials)
        spec, files = publish(args.xlsx, args.project_folder, drive, today)
    except PublishError as e:
        print(f"NOT published.\n{e}", file=sys.stderr)
        return 1

    print(f"Published.\n"
          f"  Form id:    {spec['form_id']}\n"
          f"  Version:    {spec['version']}\n"
          f"  Questions:  {question_count(spec['nodes'])} questions (plus the automatic fields)\n"
          f"  Spec file:  {spec['form_id']}.spec.json\n"
          f"  Drive link: {files['spec']['link']}\n"
          f"  Spreadsheet: {files['xlsx']['link']}")
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
    sys.exit(main())
