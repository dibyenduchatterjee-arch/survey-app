"""Drive upload, Sheet refresh and the Google client builder (Task 14).

No test here reaches Google: the wrappers take an injected fake client that mimics the
googleapiclient call chain (`client.files().create(...).execute()`).
"""

import json
import logging

import httplib2
import pytest
from googleapiclient.errors import HttpError

from app.export.drive import DriveUploader, ExportConfigError, GoogleError, build_google_client, redact
from app.export.sheets import SheetWriter

FAKE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n"


def http_error(status: int, message: str = "boom") -> HttpError:
    body = json.dumps({"error": {"code": status, "message": message}}).encode()
    return HttpError(httplib2.Response({"status": status}), body, uri="https://example.invalid/upload")


class _Exec:
    def __init__(self, fn):
        self.fn = fn

    def execute(self):
        return self.fn()


class FakeDrive:
    """`failures` is consumed one per create() call; an item is raised, None means succeed."""

    def __init__(self, failures=()):
        self.failures = list(failures)
        self.created = []
        self.attempts = 0
        self.failures_on_get = []

    def files(self):
        return self

    def create(self, body, media_body, fields, supportsAllDrives):
        def run():
            self.attempts += 1
            if self.failures:
                f = self.failures.pop(0)
                if f is not None:
                    raise f
            self.created.append((body, media_body.getbytes(0, media_body.size()), media_body.mimetype()))
            return {"id": f"file-{len(self.created)}"}

        return _Exec(run)

    def get_media(self, fileId, supportsAllDrives):
        def run():
            if self.failures_on_get:
                raise self.failures_on_get.pop(0)
            return self.created[int(fileId.split("-")[1]) - 1][1]

        return _Exec(run)


class FakeSheets:
    def __init__(self, fail_update=None):
        self.calls = []
        self.fail_update = fail_update

    def spreadsheets(self):
        return self

    def values(self):
        return self

    def clear(self, spreadsheetId, range, body):
        return _Exec(lambda: self.calls.append(("clear", spreadsheetId, range, body)) or {})

    def update(self, spreadsheetId, range, valueInputOption, body):
        def run():
            if self.fail_update:
                raise self.fail_update
            self.calls.append(("update", spreadsheetId, range, valueInputOption, body))
            return {}

        return _Exec(run)


@pytest.fixture
def sleeps():
    return []


@pytest.fixture
def fake_drive():
    return FakeDrive()


def uploader(client, sleeps):
    return DriveUploader(client, sleep=sleeps.append)


# ---- Drive ----------------------------------------------------------------------------


def test_uploader_sends_every_file_and_returns_their_ids(fake_drive, sleeps):
    up = uploader(fake_drive, sleeps)
    a = up.upload("FOLDER", "a.csv", b"\xef\xbb\xbfx,y\r\n", "text/csv")
    b = up.upload("FOLDER", "b.zip", b"PK", "application/zip")
    assert (a, b) == ("file-1", "file-2")
    (body, data, mime), second = fake_drive.created
    assert body == {"name": "a.csv", "parents": ["FOLDER"]}
    assert data == b"\xef\xbb\xbfx,y\r\n"  # bytes reach Drive untouched, BOM included
    assert mime == "text/csv" and second[2] == "application/zip"


def test_a_transient_503_is_retried_then_succeeds(sleeps):
    drive = FakeDrive([http_error(503), http_error(429), None])
    assert uploader(drive, sleeps).upload("F", "a.csv", b"x", "text/csv") == "file-1"
    assert drive.attempts == 3
    assert sleeps == [1, 2]  # exponential backoff


def test_retries_stop_after_three_and_the_error_says_so(sleeps):
    drive = FakeDrive([http_error(500)] * 10)
    with pytest.raises(GoogleError) as e:
        uploader(drive, sleeps).upload("F", "a.csv", b"x", "text/csv")
    assert drive.attempts == 4  # one try plus three retries
    assert sleeps == [1, 2, 4]
    assert "500" in str(e.value)


def test_a_permanent_403_is_not_retried_and_keeps_the_reason(sleeps):
    drive = FakeDrive([http_error(403, "The user does not have permission")])
    with pytest.raises(GoogleError) as e:
        uploader(drive, sleeps).upload("F", "a.csv", b"x", "text/csv")
    assert drive.attempts == 1 and sleeps == []
    assert "403" in str(e.value) and "does not have permission" in str(e.value)


def test_a_dropped_connection_is_retried(sleeps):
    drive = FakeDrive([ConnectionResetError("reset"), None])
    assert uploader(drive, sleeps).upload("F", "a.csv", b"x", "text/csv") == "file-1"


# ---- Sheets ---------------------------------------------------------------------------


def test_sheet_replace_clears_before_writing():
    fake = FakeSheets()
    SheetWriter(fake, sleep=lambda s: None).replace("SHEET", "visits", [["a", "b"], ["1", "2"]])
    assert [c[0] for c in fake.calls] == ["clear", "update"]
    clear, update = fake.calls
    assert clear[1:3] == ("SHEET", "'visits'")
    assert update[1:3] == ("SHEET", "'visits'!A1")
    assert update[3] == "RAW"  # never USER_ENTERED: a cell starting "=" must not run as a formula
    assert update[4] == {"values": [["a", "b"], ["1", "2"]]}


def test_a_tab_name_with_a_quote_is_escaped():
    fake = FakeSheets()
    SheetWriter(fake, sleep=lambda s: None).replace("S", "Bihar's", [["a"]])
    assert fake.calls[0][2] == "'Bihar''s'"


def test_sheet_failure_after_clear_surfaces_as_an_error(sleeps):
    fake = FakeSheets(fail_update=http_error(403, "no access"))
    with pytest.raises(GoogleError):
        SheetWriter(fake, sleep=sleeps.append).replace("S", "t", [["a"]])
    assert fake.calls[0][0] == "clear" and sleeps == []


def test_sheet_retries_a_503(sleeps):
    class Flaky(FakeSheets):
        n = 0

        def clear(self, spreadsheetId, range, body):
            def run():
                Flaky.n += 1
                if Flaky.n == 1:
                    raise http_error(503)
                return {}

            return _Exec(run)

    SheetWriter(Flaky(), sleep=sleeps.append).replace("S", "t", [["a"]])
    assert sleeps == [1]


# ---- client builder and secrecy -------------------------------------------------------


def test_build_client_without_a_key_file_fails_loudly():
    class S:
        google_service_account_file = None

    with pytest.raises(ExportConfigError, match="GOOGLE_SERVICE_ACCOUNT_FILE"):
        build_google_client(S())


def test_a_bad_key_file_error_never_contains_the_key(tmp_path, caplog):
    path = tmp_path / "sa.json"
    path.write_text(
        json.dumps({"type": "service_account", "private_key": FAKE_KEY, "client_email": "x@y.iam.gserviceaccount.com"})
    )

    class S:
        google_service_account_file = path

    with caplog.at_level(logging.DEBUG), pytest.raises(ExportConfigError) as e:
        build_google_client(S())
    assert "MIIEvQ" not in str(e.value) and "MIIEvQ" not in repr(e.value.__cause__)
    assert "private_key" not in caplog.text and "MIIEvQ" not in caplog.text


def test_build_client_missing_file_names_the_path_only(tmp_path):
    class S:
        google_service_account_file = tmp_path / "nope.json"

    with pytest.raises(ExportConfigError, match="nope.json"):
        build_google_client(S())


def test_redact_removes_a_pem_block_and_a_private_key_field():
    text = f'bad: {{"private_key": "{FAKE_KEY!r}"}} and {FAKE_KEY}'
    out = redact(text)
    assert "MIIEvQ" not in out and "BEGIN PRIVATE KEY" not in out


def test_the_service_account_key_is_never_logged(caplog, sleeps):
    drive = FakeDrive([http_error(503, f"echo {FAKE_KEY}"), None])
    with caplog.at_level(logging.DEBUG):
        uploader(drive, sleeps).upload("F", "a.csv", b"x", "text/csv")
        with pytest.raises(GoogleError) as e:
            uploader(FakeDrive([http_error(403, f"echo {FAKE_KEY}")]), sleeps).upload("F", "a", b"x", "text/csv")
    assert "private_key" not in caplog.text
    assert "MIIEvQ" not in caplog.text and "MIIEvQ" not in str(e.value)
