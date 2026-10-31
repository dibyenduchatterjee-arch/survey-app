"""One test that walks the whole Phase 1 path, server side, and fails if any seam breaks.

admin creates people -> supervisor uploads + publishes a real XLSForm -> the form is assigned ->
enumerator fetches the spec and submits (photo + repeat rows, one submission replayed) ->
supervisor exports -> the CSVs and the media zip arrive in a FAKE Drive.

Nothing here reaches the network: Google is the fake client from test_drive.py, injected through
the same dependency overrides the export tests use. Every request is a real HTTP call through the
app (login included), so a break in routing, auth, intake, storage or export shows up here.
"""

import csv
import io
import json
import uuid as uuidlib
import zipfile
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import func, select

from app.api import exports
from app.core.config import get_settings
from app.core.crypto import decrypt_bytes
from app.core.security import hash_password
from app.db.models import Submission, User
from app.export.drive import DriveUploader
from app.main import app
from test_drive import FakeDrive

FIX = Path(__file__).parent / "fixtures"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x07" * 300
PASSWORD = "Correct-Horse-Battery-9"
MUZAFFARPUR = "मुजफ्फरपुर"  # as typed by a person, no nuqta: free text must come back exactly


def login(client, username, password=PASSWORD):
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def submission_files(form_id, version, uid, asha, children):
    body = {
        "uuid": uid,
        "form_id": form_id,
        "version": version,
        "data": {"district": "muzaffarpur", "block": "motipur", "asha_name": asha,
                 "household_children": len(children)},
        "repeats": {"children": children},
    }
    return {
        "submission": (None, json.dumps(body, ensure_ascii=False), "application/json"),
        "household_photo": ("p.jpg", JPEG, "image/jpeg"),
    }


def test_the_whole_path_from_admin_to_drive(client, db, tmp_path, monkeypatch):
    # -- wiring: media on a temp disk, Google replaced by a fake -----------------------------
    settings = get_settings()
    monkeypatch.setattr(settings, "media_root", tmp_path / "media")
    monkeypatch.setattr(settings, "drive_folder_id", "FOLDER", raising=False)
    monkeypatch.setattr(settings, "google_sheet_id", None, raising=False)
    drive = FakeDrive()

    @contextmanager
    def same_session():
        yield db  # the background export uses the test's database, and must not close it

    app.dependency_overrides[exports.get_drive_uploader] = lambda: DriveUploader(drive, sleep=lambda s: None)
    app.dependency_overrides[exports.get_sheet_writer] = lambda: None  # the Sheet leg has its own tests
    app.dependency_overrides[exports.get_job_session] = lambda: same_session

    # -- 1. the one person who exists on day one is an admin ---------------------------------
    db.add(User(username="admin1", password_hash=hash_password(PASSWORD), role="admin", full_name="Admin"))
    db.commit()
    admin = login(client, "admin1")

    # -- 2. the admin creates a supervisor and an enumerator ---------------------------------
    for username, role, name in (("sup1", "supervisor", "Meena Kumari"), ("enum1", "enumerator", "Sunita Devi")):
        r = client.post("/api/users", headers=admin, json={
            "username": username, "password": PASSWORD, "role": role, "full_name": name})
        assert r.status_code == 201, r.text
    enumerator_id = next(u["id"] for u in client.get("/api/users", headers=admin).json()
                         if u["username"] == "enum1")
    sup, enum = login(client, "sup1"), login(client, "enum1")
    project_id = client.post("/api/projects", headers=admin, json={"name": "AMB"}).json()["id"]
    sup_id = next(u["id"] for u in client.get("/api/users", headers=admin).json() if u["username"] == "sup1")
    assert client.post(f"/api/projects/{project_id}/members", headers=admin, json={"user_id": sup_id}).status_code == 201

    # -- 3. the supervisor uploads and publishes the real XLSForm ----------------------------
    r = client.post("/api/forms", headers=sup,
                    files={"file": ("amb_asha_visit.xlsx", (FIX / "amb_asha_visit.xlsx").read_bytes(), XLSX)})
    assert r.status_code == 201, r.text
    form_id, version = r.json()["form_id"], r.json()["version"]
    assert form_id == "amb_asha_visit"
    assert client.post(f"/api/forms/{form_id}/publish", headers=sup, json={"version": version}).status_code == 200

    # -- 4. assignment. The design makes this admin-only (supervisors may only list). --------
    assert client.post("/api/assignments", headers=sup,
                       json={"user_id": enumerator_id, "form_id": form_id}).status_code == 403
    r = client.post("/api/assignments", headers=admin, json={"user_id": enumerator_id, "form_id": form_id})
    assert r.status_code == 201, r.text
    assert [a["username"] for a in client.get("/api/assignments", headers=sup).json()] == ["enum1"]

    # -- 5. the enumerator sees the form and fetches its spec --------------------------------
    listed = client.get("/api/forms", headers=enum).json()
    assert [(f["form_id"], f["current_version"]) for f in listed] == [(form_id, version)]
    spec = client.get(f"/api/forms/{form_id}/versions/{version}/spec", headers=enum)
    assert spec.status_code == 200 and spec.json()["form_id"] == "amb_asha_visit"

    # -- 6. two submissions, each with a photo and repeat rows ------------------------------
    u1, u2 = str(uuidlib.uuid4()), str(uuidlib.uuid4())
    kids1 = [
        {"child_name": "रवि", "child_age_months": 30, "ifa_form": "syrup", "syrup_given": "yes",
         "ifa_doses": [{"dose_date": "2026-10-01", "dose_ml": 1}]},
        {"child_name": "Mina", "child_age_months": 48, "ifa_form": "pink", "tablet_taken": "yes"},
    ]
    kids2 = [{"child_name": "Ravi", "child_age_months": 20, "ifa_form": "syrup", "syrup_given": "no"}]
    first = client.post("/api/submissions", headers=enum,
                        files=submission_files(form_id, version, u1, f"सुनीता, {MUZAFFARPUR}", kids1))
    assert first.status_code == 201, first.text
    second = client.post("/api/submissions", headers=enum,
                         files=submission_files(form_id, version, u2, "Rani Kumari", kids2))
    assert second.status_code == 201, second.text

    # -- 7. a replay of the first (a lost reply, a retry): same receipt, still two rows ------
    replay = client.post("/api/submissions", headers=enum,
                         files=submission_files(form_id, version, u1, f"सुनीता, {MUZAFFARPUR}", kids1))
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert db.scalar(select(func.count()).select_from(Submission)) == 2

    # the supervisor can read both, with their repeat rows and photo; the photo is encrypted on disk
    detail = client.get(f"/api/submissions/{u1}", headers=sup).json()
    assert len(detail["repeats"]["children"]) == 2 and detail["media"][0]["question_name"] == "household_photo"
    on_disk = [p for p in (tmp_path / "media").rglob("*") if p.is_file()]
    assert len(on_disk) == 2 and all(JPEG not in p.read_bytes() for p in on_disk)
    assert all(decrypt_bytes(p.read_bytes()) == JPEG for p in on_disk)

    # -- 8. the supervisor exports; the (fake) Drive receives everything ---------------------
    r = client.post("/api/exports", headers=sup, json={"form_id": form_id})
    assert r.status_code == 202, r.text
    job = client.get(f"/api/exports/{r.json()['job_id']}", headers=sup).json()
    assert job["status"] == "done", job["error"]
    assert job["row_count"] == 2 and job["drive_file_id"] == "file-1"

    uploaded = {body["name"]: (data, mime) for body, data, mime in drive.created}
    assert all(body["parents"] == ["FOLDER"] for body, _, _ in drive.created)
    main = next(n for n in uploaded if n.startswith("amb_asha_visit_20") and n.endswith(".csv"))
    child = next(n for n in uploaded if n.startswith("amb_asha_visit_children_20"))
    zips = [n for n in uploaded if n.startswith("amb_asha_visit_media_20") and n.endswith(".zip")]
    assert len(zips) == 1 and uploaded[zips[0]][1] == "application/zip"

    # main CSV: two rows (not three), Devanagari intact through the UTF-8 BOM
    main_bytes = uploaded[main][0]
    assert main_bytes.startswith(b"\xef\xbb\xbf")
    main_text = main_bytes.decode("utf-8-sig")
    assert MUZAFFARPUR in main_text
    main_rows = list(csv.DictReader(io.StringIO(main_text, newline="")))
    assert sorted(r["uuid"] for r in main_rows) == sorted([u1, u2])
    assert {r["submitted_by"] for r in main_rows} == {"enum1"}

    # child CSV: three children, each tied to its parent submission
    child_text = uploaded[child][0].decode("utf-8-sig")
    child_rows = list(csv.DictReader(io.StringIO(child_text, newline="")))
    assert len(child_rows) == 3
    assert sorted(r["parent_uuid"] for r in child_rows) == sorted([u1, u1, u2])
    assert "रवि" in child_text
    assert any(n.startswith("amb_asha_visit_children_ifa_doses_20") for n in uploaded)  # nested repeat

    # media zip: both photos, readable (decrypted) JPEGs
    with zipfile.ZipFile(io.BytesIO(uploaded[zips[0]][0])) as z:
        assert len(z.namelist()) == 2
        assert all(z.read(n) == JPEG for n in z.namelist())
        assert {r["household_photo"] for r in main_rows} == set(z.namelist())

    # and the supervisor downloads the same bytes through the app, not a Drive link
    dl = client.get(f"/api/exports/{job['job_id']}/download", headers=sup)
    assert dl.status_code == 200 and dl.content == main_bytes
