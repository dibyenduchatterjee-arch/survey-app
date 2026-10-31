"""tools/publish_form.py: compile an XLSForm on the laptop and publish it to a Drive folder.

No test touches the network: the Drive client is a fake passed into `main`.
"""

import json
import sys
from pathlib import Path

import openpyxl
import pytest
from googleapiclient.errors import HttpError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

import publish_form  # noqa: E402

FIX = Path(__file__).parent / "fixtures"
GOOD = FIX / "amb_asha_visit.xlsx"
BAD_EXPR = FIX / "amb_unsupported_expr.xlsx"
FOLDER = "folder123"
TODAY = "20261031"


class FakeDrive:
    """In-memory Drive folder. Records every call so tests can see what was offered."""

    def __init__(self, fail_with=None):
        self.files = {}  # id -> {"folder", "name", "data", "mime", "revisions"}
        self.calls = []
        self.fail_with = fail_with
        self._n = 0

    def find(self, folder_id, name):
        self.calls.append(("find", folder_id, name))
        for fid, f in self.files.items():
            if f["folder"] == folder_id and f["name"] == name:
                return {"id": fid, "link": f"https://drive.example/{fid}"}
        return None

    def read(self, file_id):
        self.calls.append(("read", file_id))
        return self.files[file_id]["data"]

    def create(self, folder_id, name, data, mime):
        self.calls.append(("create", folder_id, name))
        if self.fail_with:
            raise self.fail_with
        self._n += 1
        fid = f"id{self._n}"
        self.files[fid] = {"folder": folder_id, "name": name, "data": data, "mime": mime, "revisions": 1}
        return {"id": fid, "link": f"https://drive.example/{fid}"}

    def update(self, file_id, data, mime):
        self.calls.append(("update", file_id))
        if self.fail_with:
            raise self.fail_with
        self.files[file_id]["data"] = data
        self.files[file_id]["revisions"] += 1
        return {"id": file_id, "link": f"https://drive.example/{file_id}"}

    def writes(self):
        return [c for c in self.calls if c[0] in ("create", "update")]

    def by_name(self, name):
        return [f for f in self.files.values() if f["name"] == name]


def run(xlsx, drive, *extra, capsys):
    argv = ["--xlsx", str(xlsx), "--project-folder", FOLDER, *extra]
    code = publish_form.main(argv, drive=drive, today=TODAY)
    return code, capsys.readouterr()


def http_error(status, message, reason=None):
    body = {"error": {"code": status, "message": message}}
    if reason:
        body["error"]["errors"] = [{"reason": reason}]
    return HttpError(type("R", (), {"status": status, "reason": "x"})(), json.dumps(body).encode())


def quota_error():
    return http_error(403, "Service Accounts do not have storage quota.", "storageQuotaExceeded")


def with_duplicate_row(tmp_path):
    wb = openpyxl.load_workbook(GOOD)
    ws = wb["survey"]
    rows = list(ws.iter_rows(values_only=True))
    first_text = next(r for r in rows[1:] if r[0] == "text")
    ws.append(list(first_text))
    path = tmp_path / "dup.xlsx"
    wb.save(path)
    return path, first_text[1]


def spec_in(drive):
    return json.loads(drive.by_name("amb_asha_visit.spec.json")[0]["data"].decode("utf-8"))


def test_good_form_offers_xlsx_and_spec_to_the_folder(capsys):
    drive = FakeDrive()
    code, _ = run(GOOD, drive, capsys=capsys)
    assert code == 0
    assert [c[:3] for c in drive.writes()] == [
        ("create", FOLDER, "amb_asha_visit.xlsx"),
        ("create", FOLDER, "amb_asha_visit.spec.json"),
    ]
    assert drive.by_name("amb_asha_visit.xlsx")[0]["data"] == GOOD.read_bytes()


def test_spec_carries_version_and_automatic_metadata(capsys):
    drive = FakeDrive()
    run(GOOD, drive, capsys=capsys)
    spec = spec_in(drive)
    assert spec["form_id"] == "amb_asha_visit"
    assert spec["version"] == TODAY + "01"
    tail = [n["name"] for n in spec["nodes"][-5:]]
    assert tail == ["_gps", "_started_at", "_finished_at", "_device_id", "_submitted_by"]
    assert all(n["auto"] for n in spec["nodes"][-5:])


def test_summary_names_form_version_count_and_link(capsys):
    _, out = run(GOOD, FakeDrive(), capsys=capsys)
    assert "amb_asha_visit" in out.out
    assert TODAY + "01" in out.out
    assert "questions" in out.out
    assert "https://drive.example/id2" in out.out
    assert out.err == ""


def test_unsupported_expression_names_the_question_and_uploads_nothing(capsys):
    drive = FakeDrive()
    code, out = run(BAD_EXPR, drive, capsys=capsys)
    assert code != 0
    assert drive.calls == []
    assert "NOT published" in out.err
    assert "unsupported expression" in out.err
    assert "question '" in out.err


def test_duplicate_field_name_is_refused_and_uploads_nothing(tmp_path, capsys):
    path, name = with_duplicate_row(tmp_path)
    drive = FakeDrive()
    code, out = run(path, drive, capsys=capsys)
    assert code != 0
    assert drive.calls == []
    assert name in out.err and "NOT published" in out.err


def test_dry_run_compiles_reports_and_uploads_nothing(capsys):
    drive = FakeDrive()
    code, out = run(GOOD, drive, "--dry-run", capsys=capsys)
    assert code == 0
    assert drive.calls == []
    assert "dry run" in out.out.lower() and "amb_asha_visit" in out.out and "questions" in out.out


def test_dry_run_needs_no_credentials(capsys, monkeypatch):
    monkeypatch.delenv("GOOGLE_SERVICE_ACCOUNT_FILE", raising=False)
    code = publish_form.main(["--xlsx", str(GOOD), "--project-folder", FOLDER, "--dry-run"], today=TODAY)
    assert code == 0
    capsys.readouterr()


def test_storage_quota_gives_the_shared_drive_message(capsys):
    code, out = run(GOOD, FakeDrive(fail_with=quota_error()), capsys=capsys)
    assert code != 0
    assert "Shared Drive" in out.err and "Content manager" in out.err
    assert "storageQuotaExceeded" in out.err
    assert "Traceback" not in out.err


def test_other_drive_errors_are_reported_without_a_traceback(capsys):
    err = http_error(404, "File not found: folder123")
    code, out = run(GOOD, FakeDrive(fail_with=err), capsys=capsys)
    assert code != 0
    assert "File not found" in out.err and "Shared Drive" not in out.err
    assert "Traceback" not in out.err


def test_second_publish_uploads_a_new_version_not_a_duplicate(capsys):
    drive = FakeDrive()
    run(GOOD, drive, capsys=capsys)
    first_ids = {f["name"]: fid for fid, f in drive.files.items()}
    code, out = run(GOOD, drive, capsys=capsys)
    assert code == 0
    assert len(drive.files) == 2  # still one xlsx, one spec
    assert {f["name"]: fid for fid, f in drive.files.items()} == first_ids
    assert [c[0] for c in drive.writes()] == ["create", "create", "update", "update"]
    assert all(f["revisions"] == 2 for f in drive.files.values())
    assert spec_in(drive)["version"] == TODAY + "02"
    assert TODAY + "02" in out.out


def test_a_new_day_restarts_the_sequence(capsys):
    drive = FakeDrive()
    run(GOOD, drive, capsys=capsys)
    publish_form.main(["--xlsx", str(GOOD), "--project-folder", FOLDER], drive=drive, today="20261101")
    capsys.readouterr()
    assert spec_in(drive)["version"] == "2026110101"


def test_failed_compile_leaves_an_earlier_publish_untouched(capsys):
    drive = FakeDrive()
    run(GOOD, drive, capsys=capsys)
    before = {k: dict(v) for k, v in drive.files.items()}
    writes = list(drive.writes())
    code, _ = run(BAD_EXPR, drive, capsys=capsys)
    assert code != 0 and drive.files == before and drive.writes() == writes


def test_missing_file_and_missing_credentials_are_clear(tmp_path, capsys, monkeypatch):
    code, out = run(tmp_path / "nope.xlsx", FakeDrive(), capsys=capsys)
    assert code != 0 and "not found" in out.err.lower()
    monkeypatch.delenv("GOOGLE_SERVICE_ACCOUNT_FILE", raising=False)
    code = publish_form.main(["--xlsx", str(GOOD), "--project-folder", FOLDER], today=TODAY)
    err = capsys.readouterr().err
    assert code != 0 and "GOOGLE_SERVICE_ACCOUNT_FILE" in err and "--credentials" in err


def test_credentials_contents_are_never_printed(tmp_path, capsys, monkeypatch):
    key = tmp_path / "sa.json"
    key.write_text('{"private_key": "-----BEGIN PRIVATE KEY-----\\nSECRETSECRET\\n-----END PRIVATE KEY-----\\n"}')
    monkeypatch.setenv("GOOGLE_SERVICE_ACCOUNT_FILE", str(key))
    code = publish_form.main(["--xlsx", str(GOOD), "--project-folder", FOLDER], today=TODAY)
    out = capsys.readouterr()
    assert code != 0
    assert "SECRETSECRET" not in out.out + out.err
