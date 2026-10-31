"""GET /api/submissions/{uuid}/media/{question}: staff only, decrypted, masked 404."""

import json
import uuid as uuidlib
from pathlib import Path

import pytest
from sqlalchemy import select

from app.core.security import create_access_token
from app.db.models import Assignment, FormVersion, Submission

FIX = Path(__file__).parent / "fixtures"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x07" * 300
GOOD = {"district": "patna", "block": "danapur", "asha_name": "Sunita", "household_children": 2}
CHILD = {"child_name": "Ravi", "child_age_months": 48, "ifa_form": "tablet"}


def _hdr(u):
    return {"Authorization": f"Bearer {create_access_token(u.id, u.role)}"}


@pytest.fixture
def stored(client, db, user_factory, tmp_path, monkeypatch, join_project):
    from app.core.config import get_settings

    root = tmp_path / "m"
    root.mkdir()
    monkeypatch.setattr(get_settings(), "media_root", root)
    sup = user_factory(username="sup", role="supervisor")
    join_project(db, sup)
    data = (FIX / "amb_asha_visit.xlsx").read_bytes()
    body = client.post("/api/forms", files={"file": ("f.xlsx", data, XLSX)}, headers=_hdr(sup)).json()
    client.post(f"/api/forms/{body['form_id']}/publish", json={"version": body["version"]}, headers=_hdr(sup))
    fv = db.scalars(select(FormVersion)).one()
    e = user_factory(username="enum1", role="enumerator")
    db.add(Assignment(user_id=e.id, form_id=fv.form_id))
    db.commit()
    uid = str(uuidlib.uuid4())
    sub = {"uuid": uid, "form_id": body["form_id"], "version": body["version"], "data": GOOD,
           "repeats": {"children": [CHILD]}}
    files = {"submission": (None, json.dumps(sub), "application/json"),
             "household_photo": ("p.jpg", JPEG, "image/jpeg")}
    assert client.post("/api/submissions", files=files, headers=_hdr(e)).status_code == 201
    return uid, sup, e


def test_staff_get_the_decrypted_bytes_inline(client, stored):
    uid, sup, e = stored
    r = client.get(f"/api/submissions/{uid}/media/household_photo", headers=_hdr(sup))
    assert r.status_code == 200
    assert r.content == JPEG
    assert r.headers["content-type"] == "image/jpeg"
    assert r.headers["content-disposition"].startswith("inline")


def test_admin_too(client, stored, user_factory):
    uid, *_ = stored
    adm = user_factory(username="adm", role="admin")
    assert client.get(f"/api/submissions/{uid}/media/household_photo", headers=_hdr(adm)).status_code == 200


def test_an_enumerator_is_refused_even_for_their_own_submission(client, stored):
    uid, sup, e = stored
    r = client.get(f"/api/submissions/{uid}/media/household_photo", headers=_hdr(e))
    assert r.status_code == 403
    assert client.get(f"/api/submissions/{uid}/media/household_photo").status_code == 401


def test_missing_submission_or_media_is_404(client, stored):
    uid, sup, e = stored
    h = _hdr(sup)
    assert client.get(f"/api/submissions/{uuidlib.uuid4()}/media/household_photo", headers=h).status_code == 404
    assert client.get(f"/api/submissions/{uid}/media/nothing", headers=h).status_code == 404
    assert client.get("/api/submissions/not-a-uuid/media/household_photo", headers=h).status_code == 404


def test_a_staff_member_who_cannot_see_the_form_gets_the_same_404(client, stored, db, monkeypatch):
    from app.api import submissions as api

    uid, sup, e = stored
    monkeypatch.setattr(api, "staff_can_see_form", lambda db, user, form_pk: False)
    r = client.get(f"/api/submissions/{uid}/media/household_photo", headers=_hdr(sup))
    missing = client.get(f"/api/submissions/{uuidlib.uuid4()}/media/household_photo", headers=_hdr(sup))
    assert r.status_code == missing.status_code == 404
    assert r.json() == missing.json()


def test_a_missing_file_on_disk_is_a_404_not_a_crash(client, stored):
    from app.core.config import get_settings

    uid, sup, e = stored
    for p in Path(get_settings().media_root).rglob("*"):
        if p.is_file():
            p.unlink()
    assert client.get(f"/api/submissions/{uid}/media/household_photo", headers=_hdr(sup)).status_code == 404
