"""Google Drive upload, and the one place the service-account key is read.

DESIGN   `DriveUploader(client)` takes an already-built client and never constructs one, so a
         test injects a fake and no test reaches Google. `build_google_client(settings)` is
         the only function that touches the key file.

RETRY    429 and 5xx (and a dropped connection) are retried three times with exponential
         backoff (1 s, 2 s, 4 s); every other 4xx is permanent and raised at once.

SECRECY  The key never reaches a log or an error. Nothing here logs anything; every
         exception message passes through `redact()`, which removes PEM blocks and
         `private_key` fields; and errors raised while loading the key are re-raised
         without their cause, so the library's own text cannot ride along.
"""

import io
import json
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseUpload

T = TypeVar("T")

RETRIES = 3
BACKOFF_SECONDS = 1.0

DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"

_PEM = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(-----END [A-Z ]*PRIVATE KEY-----|$)", re.DOTALL)
_FIELD = re.compile(r"""(["']?private_key(?:_id)?["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2).)*\2?""", re.DOTALL)


class GoogleError(Exception):
    """A Drive or Sheets call failed for good. The message is safe to store and to show."""


class ExportConfigError(Exception):
    """The Google credentials or export settings are missing or unusable."""


def redact(text: str) -> str:
    """`text` with any private-key material removed."""
    text = _PEM.sub("[private key removed]", text)
    return _FIELD.sub(r"\1\2[removed]\2", text)


def _reason(e: HttpError) -> str:
    try:
        message = json.loads(e.content.decode("utf-8", "replace"))["error"]["message"]
    except (ValueError, KeyError, TypeError, AttributeError):
        message = getattr(e, "reason", None) or "no detail"
    return redact(str(message))[:500]


def call_with_retry(fn: Callable[[], T], what: str, sleep: Callable[[float], None] = time.sleep) -> T:
    """Run `fn`, retrying transient failures; raise GoogleError(`what` + reason) otherwise."""
    for attempt in range(RETRIES + 1):
        try:
            return fn()
        except HttpError as e:
            status = int(e.resp.status)
            if status != 429 and status < 500:
                raise GoogleError(f"{what} failed (HTTP {status}): {_reason(e)}") from None
            failure = f"HTTP {status}: {_reason(e)}"
        except (ConnectionError, TimeoutError) as e:
            failure = f"connection problem ({type(e).__name__})"
        if attempt == RETRIES:
            raise GoogleError(f"{what} failed after {RETRIES + 1} attempts ({failure})")
        sleep(BACKOFF_SECONDS * 2**attempt)
    raise AssertionError("unreachable")  # pragma: no cover


class DriveUploader:
    def __init__(self, client: Any, sleep: Callable[[float], None] = time.sleep):
        self._client = client
        self._sleep = sleep

    def upload(self, folder_id: str, filename: str, data: bytes, mime: str) -> str:
        """Put `data` in the folder as `filename`, byte for byte; returns the new file's id."""

        def create() -> dict:
            media = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime, resumable=False)
            return self._client.files().create(
                body={"name": filename, "parents": [folder_id]},
                media_body=media,
                fields="id",
                supportsAllDrives=True,
            ).execute()

        return call_with_retry(create, f"Drive upload of {filename}", self._sleep)["id"]


def build_google_client(settings: Any, api: str = "drive") -> Any:
    """A googleapiclient service ("drive" or "sheets") authenticated as the service account.

    Reads the key from the file named by `settings.google_service_account_file`.
    """
    path = settings.google_service_account_file
    if not path:
        raise ExportConfigError(
            "GOOGLE_SERVICE_ACCOUNT_FILE is not set: exports need the path to the service-account key file"
        )
    path = Path(path)
    scope, name, version = (SHEETS_SCOPE, "sheets", "v4") if api == "sheets" else (DRIVE_SCOPE, "drive", "v3")
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build

        creds = service_account.Credentials.from_service_account_file(str(path), scopes=[scope])
        return build(name, version, credentials=creds, cache_discovery=False)
    except FileNotFoundError:
        raise ExportConfigError(f"The service-account key file was not found: {path}") from None
    except Exception:
        # No cause and no library text: either could quote the key file.
        raise ExportConfigError(f"The service-account key file could not be used: {path}") from None
