import csv
import io
import json
import uuid as uuidlib
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import select

from app.core.security import create_access_token
from app.db.models import Assignment, FormVersion, Submission
from app.export.csv_export import build_csvs
from app.forms.autometa import AUTO_FIELDS, inject_auto_metadata
from app.forms.validate import validate_submission

FIX = Path(__file__).parent / "fixtures"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
NAMES = ["_gps", "_started_at", "_finished_at", "_device_id", "_submitted_by"]


def _spec(nodes=()):
    return {"form_id": "f", "nodes": list(nodes), "choices": {}, "languages": ["default"]}


def test_all_five_are_injected_flagged_auto_and_never_required():
    spec = inject_auto_metadata(_spec([{"type": "text", "name": "q"}]))
    by = {n["name"]: n for n in spec["nodes"]}
    assert [n["name"] for n in spec["nodes"]] == ["q"] + NAMES
    assert by["_gps"]["type"] == "geopoint"
    assert by["_started_at"]["type"] == by["_finished_at"]["type"] == "dateTime"
    assert by["_device_id"]["type"] == by["_submitted_by"]["type"] == "text"
    for n in NAMES:
        assert by[n]["auto"] is True and not by[n].get("required") and "relevant" not in by[n]
    assert list(AUTO_FIELDS) == NAMES


def test_a_user_declared_field_of_the_same_name_is_kept_untouched():
    mine = {"type": "text", "name": "_device_id", "required": True}
    spec = inject_auto_metadata(_spec([{"type": "group", "name": "g", "children": [mine]}]))
    assert [n["name"] for n in spec["nodes"]] == ["g"] + [n for n in NAMES if n != "_device_id"]
    assert mine == {"type": "text", "name": "_device_id", "required": True}


def test_a_user_geopoint_stays_separate_and_additional():
    spec = inject_auto_metadata(_spec([{"type": "geopoint", "name": "home_gps"}]))
    names = [n["name"] for n in spec["nodes"]]
    assert "home_gps" in names and "_gps" in names
    assert not next(n for n in spec["nodes"] if n["name"] == "home_gps").get("auto")


def test_injection_is_idempotent():
    once = inject_auto_metadata(_spec())
    assert inject_auto_metadata(json.loads(json.dumps(once))) == once


def test_blank_auto_fields_are_not_validation_failures():
    spec = inject_auto_metadata(_spec([{"type": "text", "name": "q"}]))
    assert validate_submission(spec, {"q": "x"}, {}, datetime.now(UTC)) == []


# ---- through the API ------------------------------------------------------------------


def _hdr(u):
    return {"Authorization": f"Bearer {create_access_token(u.id, u.role)}"}


@pytest.fixture
def published(client, db, user_factory, tmp_path, monkeypatch, join_project):
    from app.core.config import get_settings

    root = tmp_path / "m"
    root.mkdir()
    monkeypatch.setattr(get_settings(), "media_root", root)
    sup = user_factory(username="sup", role="supervisor")
    join_project(db, sup)
    data = (FIX / "amb_asha_visit.xlsx").read_bytes()
    r = client.post("/api/forms", files={"file": ("f.xlsx", data, XLSX)}, headers=_hdr(sup))
    body = r.json()
    client.post(f"/api/forms/{body['form_id']}/publish", json={"version": body["version"]}, headers=_hdr(sup))
    fv = db.scalars(select(FormVersion)).one()
    e = user_factory(username="enum1", role="enumerator")
    db.add(Assignment(user_id=e.id, form_id=fv.form_id))
    db.commit()
    return body, fv, e


def test_upload_injects_the_metadata_into_the_stored_spec(client, published):
    body, fv, e = published
    spec = client.get(f"/api/forms/{body['form_id']}/versions/{body['version']}/spec", headers=_hdr(e)).json()
    assert [n["name"] for n in spec["nodes"] if n.get("auto")] == NAMES


GOOD = {"district": "patna", "block": "danapur", "asha_name": "Sunita", "household_children": 2}
CHILD = {"child_name": "Ravi", "child_age_months": 48, "ifa_form": "tablet"}


def _submit(client, body, e, data):
    sub = {"uuid": str(uuidlib.uuid4()), "form_id": body["form_id"], "version": body["version"],
           "data": data, "repeats": {"children": [CHILD]}}
    files = {"submission": (None, json.dumps(sub), "application/json"),
             "household_photo": ("p.jpg", b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x01" * 200, "image/jpeg")}
    return client.post("/api/submissions", files=files, headers=_hdr(e))


def test_submitted_by_is_server_filled_never_the_payload_and_nothing_is_flagged(client, db, published):
    body, fv, e = published
    data = {**GOOD, "_submitted_by": "someone_else", "_device_id": "phone-7",
            "_gps": "25.6 85.1 50 8", "_started_at": "2026-10-31T09:00:00+00:00"}
    r = _submit(client, body, e, data)
    assert r.status_code == 201, r.text
    s = db.scalars(select(Submission)).one()
    assert s.data_json["_submitted_by"] == "enum1"
    assert s.data_json["_device_id"] == "phone-7"
    assert s.status == "received" and s.failures_json is None


def test_a_submission_without_the_auto_fields_is_not_flagged(client, db, published):
    body, fv, e = published
    assert _submit(client, body, e, GOOD).status_code == 201
    s = db.scalars(select(Submission)).one()
    assert s.status == "received"
    assert s.data_json["_submitted_by"] == "enum1"


def test_csv_has_the_auto_columns(client, db, published):
    body, fv, e = published
    _submit(client, body, e, {**GOOD, "_gps": "25.6 85.1 50 8", "_device_id": "phone-7",
                              "_started_at": "2026-10-31T09:00:00+00:00"})
    db.refresh(fv)
    blob = build_csvs(fv.json_spec, db.scalars(select(Submission)).all())[f"{body['form_id']}.csv"]
    rows = list(csv.reader(io.StringIO(blob.decode("utf-8-sig"), newline="")))
    row = dict(zip(rows[0], rows[1]))
    for col in ("_gps_lat", "_gps_lon", "_gps_accuracy", "_started_at", "_finished_at",
                "_device_id", "_submitted_by"):
        assert col in row, col
    assert (row["_gps_lat"], row["_gps_lon"], row["_gps_accuracy"]) == ("25.6", "85.1", "8")
    assert row["_device_id"] == "phone-7" and row["_submitted_by"] == "enum1"
