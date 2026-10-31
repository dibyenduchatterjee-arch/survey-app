import json
import uuid as uuidlib
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import func, select
from starlette.requests import Request

from app.api import submissions
from app.api.submissions import (
    IntakeRefused,
    MediaPart,
    likely_duplicates,
    store_submission,
)
from app.core.config import get_settings
from app.core.crypto import decrypt_bytes
from app.core.security import create_access_token
from app.db.models import Assignment, AuditLog, Form, FormVersion, MediaFile, RepeatRow, Submission

FIX = Path(__file__).parent / "fixtures"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x01" * 200
PNG = b"\x89PNG\r\n\x1a\n" + b"\x02" * 100
GOOD = {"district": "patna", "block": "danapur", "asha_name": "Sunita", "household_children": 2}
CHILD = {"child_name": "Ravi", "child_age_months": 48, "ifa_form": "tablet"}


def _count(db, model):
    return db.scalar(select(func.count()).select_from(model))


def _creates(db):
    return db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "submission.create"))


def _hdr(user):
    return {"Authorization": f"Bearer {create_access_token(user.id, user.role)}"}


@pytest.fixture
def media_root(tmp_path, monkeypatch):
    root = tmp_path / "media"
    root.mkdir()
    monkeypatch.setattr(get_settings(), "media_root", root)
    return root


@pytest.fixture
def form(client, db, user_factory, media_root):
    """The real AMB fixture, uploaded and published; plus its supervisor."""
    sup = user_factory(username="sup", role="supervisor")
    data = (FIX / "amb_asha_visit.xlsx").read_bytes()
    r = client.post("/api/forms", files={"file": ("f.xlsx", data, XLSX)}, headers=_hdr(sup))
    assert r.status_code == 201, r.text
    body = r.json()
    r = client.post(
        f"/api/forms/{body['form_id']}/publish", json={"version": body["version"]}, headers=_hdr(sup)
    )
    assert r.status_code == 200
    fv = db.scalars(select(FormVersion)).one()
    return {"form_id": body["form_id"], "version": body["version"], "fv": fv, "sup": sup}


@pytest.fixture
def enum(db, user_factory, form):
    u = user_factory(username="enum1", role="enumerator")
    db.add(Assignment(user_id=u.id, form_id=form["fv"].form_id))
    db.commit()
    return u


def payload(form, uuid=None, data=None, repeats=None, media=None, **extra):
    sub = {
        "uuid": uuid if uuid is not None else str(uuidlib.uuid4()),
        "form_id": form["form_id"],
        "version": form["version"],
        "data": GOOD if data is None else data,
        "repeats": {"children": [CHILD]} if repeats is None else repeats,
        **extra,
    }
    files = {"submission": (None, json.dumps(sub), "application/json")}
    parts = media if media is not None else {"household_photo": ("p.jpg", JPEG)}
    for name, (fname, content) in parts.items():
        files[name] = (fname, content, "image/jpeg")
    return sub["uuid"], files


def post(client, user, files):
    return client.post("/api/submissions", files=files, headers=_hdr(user))


def disk(root):
    return sorted(p for p in root.rglob("*") if p.is_file())


def fake_request():
    return Request(
        {"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("10.0.0.1", 1)}
    )


def nothing_left(db, root):
    assert _count(db, Submission) == 0 and _count(db, MediaFile) == 0 and _count(db, RepeatRow) == 0
    assert list(root.iterdir()) == []
    assert _creates(db) == 0


# ---- the happy path -------------------------------------------------------------


def test_a_valid_submission_is_stored_with_its_repeat_rows_and_media(client, db, form, enum, media_root):
    uid, files = payload(form, repeats={"children": [CHILD, {**CHILD, "child_name": "Mina"}]})
    r = post(client, enum, files)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["uuid"] == uid and body["status"] == "received" and body["failures"] == []
    s = db.scalars(select(Submission)).one()
    assert s.submitted_by == enum.id and s.form_version_id == form["fv"].id
    assert s.data_json["asha_name"] == "Sunita" and s.failures_json is None
    rows = db.scalars(select(RepeatRow).order_by(RepeatRow.row_index)).all()
    assert [(x.repeat_name, x.row_index, x.data_json["child_name"]) for x in rows] == [
        ("children", 1, "Ravi"),
        ("children", 2, "Mina"),
    ]
    m = db.scalars(select(MediaFile)).one()
    assert (m.question_name, m.content_type, m.size) == ("household_photo", "image/jpeg", len(JPEG))
    assert m.storage_path == f"{uid}/household_photo.jpg"
    stored = (media_root / m.storage_path).read_bytes()
    assert stored != JPEG and JPEG[:8] not in stored  # encrypted at rest
    assert decrypt_bytes(stored) == JPEG
    assert len(m.sha256) == 64
    assert db.scalars(select(AuditLog).where(AuditLog.action == "submission.create")).one().object_id == uid


def test_select_multiple_lists_are_stored_in_the_space_separated_form(client, db, form, enum):
    _, files = payload(form, repeats={"children": [{**CHILD, "symptoms": ["pallor", "fever"]}]}, media={})
    assert post(client, enum, files).status_code == 201
    assert db.scalars(select(RepeatRow)).one().data_json["symptoms"] == "pallor fever"


# ---- idempotency ----------------------------------------------------------------


def test_the_same_uuid_twice_returns_the_first_receipt(client, db, form, enum, media_root):
    _, files = payload(form)
    first = post(client, enum, files)
    before = disk(media_root)
    second = post(client, enum, files)
    assert (first.status_code, second.status_code) == (201, 200)
    assert second.json() == first.json()
    assert _count(db, Submission) == 1 and _count(db, MediaFile) == 1 and _count(db, RepeatRow) == 1
    assert disk(media_root) == before
    assert _creates(db) == 1


def test_a_replay_is_answered_even_if_the_second_copy_differs(client, db, form, enum):
    uid, files = payload(form)
    first = post(client, enum, files)
    _, again = payload(
        form, uuid=uid, data={"district": "other"}, media={"household_photo": ("p.jpg", b"not an image")}
    )
    second = post(client, enum, again)
    assert second.status_code == 200 and second.json() == first.json()
    assert db.scalars(select(Submission)).one().data_json["district"] == "patna"


def test_a_lost_race_on_the_unique_constraint_returns_the_winner_and_writes_nothing(
    db, form, enum, media_root, monkeypatch
):
    """Two retries pass the cheap lookup at once; the database constraint decides."""
    uid = str(uuidlib.uuid4())
    args = dict(
        db=db,
        form_version=form["fv"],
        user=enum,
        data=GOOD,
        repeats={"children": [CHILD]},
        media={"household_photo": MediaPart("a.jpg", JPEG)},
        uuid=uid,
        request=fake_request(),
    )
    first, created = store_submission(**args)
    assert created is True
    before = disk(media_root)
    real, calls = submissions._existing, []

    def blind_once(db, uuid):  # the racing copy's cheap lookup saw nothing; the re-check after the conflict does
        calls.append(1)
        return None if len(calls) == 1 else real(db, uuid)

    monkeypatch.setattr(submissions, "_existing", blind_once)
    second, created = store_submission(**args)
    assert created is False and second.id == first.id
    assert _count(db, Submission) == 1 and _count(db, RepeatRow) == 1 and _count(db, MediaFile) == 1
    assert disk(media_root) == before  # the winner's file is untouched, none added


def test_a_uuid_already_used_by_someone_else_is_a_conflict_that_reveals_nothing(
    client, db, form, enum, user_factory
):
    other = user_factory(username="enum2", role="enumerator")
    db.add(Assignment(user_id=other.id, form_id=form["fv"].form_id))
    db.commit()
    uid, files = payload(form)
    assert post(client, enum, files).status_code == 201
    r = post(client, other, files)
    assert r.status_code == 409 and uid not in r.text and "Sunita" not in r.text
    assert _count(db, Submission) == 1


# ---- never lost -----------------------------------------------------------------


def test_an_invalid_submission_is_stored_as_flagged_not_rejected(client, db, form, enum):
    bad = {"district": "patna", "block": "danapur", "household_children": 99}  # no asha_name; 99 > 10
    r = post(client, enum, payload(form, data=bad)[1])
    assert r.status_code == 201 and r.json()["status"] == "flagged"
    assert {(f["question"], f["rule"]) for f in r.json()["failures"]} == {
        ("asha_name", "required"),
        ("household_children", "constraint"),
    }
    s = db.scalars(select(Submission)).one()  # never dropped
    assert s.status == "flagged" and s.data_json["household_children"] == 99  # and never corrected
    assert {f["question"] for f in s.failures_json} == {"asha_name", "household_children"}


def test_a_failing_repeat_row_is_flagged_with_its_path(client, db, form, enum):
    r = post(client, enum, payload(form, repeats={"children": [CHILD, {**CHILD, "child_age_months": 90}]})[1])
    assert r.status_code == 201
    assert [(f["question"], f["rule"]) for f in r.json()["failures"]] == [
        ("children[2]/child_age_months", "constraint")
    ]


def test_a_repeat_the_form_does_not_have_is_kept_and_flagged(client, db, form, enum):
    r = post(client, enum, payload(form, repeats={"ghosts": [{"x": 1}]})[1])
    assert r.status_code == 201 and r.json()["status"] == "flagged"
    assert db.scalars(select(RepeatRow)).one().repeat_name == "ghosts"


def test_a_validator_crash_still_stores_the_submission_flagged(client, db, form, enum, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("secret internals")

    monkeypatch.setattr(submissions, "validate_submission", boom)
    r = post(client, enum, payload(form)[1])
    assert r.status_code == 201 and r.json()["status"] == "flagged"
    assert r.json()["failures"][0]["rule"] == "error" and "secret internals" not in r.text
    assert _count(db, Submission) == 1


def test_received_at_is_the_server_clock_not_the_device_clock(client, db, form, enum):
    _, files = payload(form, started_at="2001-01-01T00:00:00Z", finished_at="2001-01-01T00:05:00Z")
    r = post(client, enum, files)
    assert r.status_code == 201 and r.json()["received_at"][:4] == str(datetime.now(UTC).year)
    s = db.scalars(select(Submission)).one()
    assert s.finished_at.year == 2001 and s.received_at.year != 2001  # device value kept, not trusted


@pytest.mark.parametrize("stamp", ["2026-10-31T10:00:00", "garbage", "0001-01-01T00:00:00+14:00", 12345])
def test_an_odd_device_timestamp_never_costs_the_submission(client, db, form, enum, stamp):
    r = post(client, enum, payload(form, finished_at=stamp)[1])
    assert r.status_code == 201 and _count(db, Submission) == 1


def test_a_nonsense_gps_value_never_costs_the_submission(client, db, form, enum):
    r = post(client, enum, payload(form, gps_lat="north", gps_lon=77.5, gps_accuracy=4.2)[1])
    assert r.status_code == 201
    s = db.scalars(select(Submission)).one()
    assert (s.gps_lat, s.gps_lon, s.gps_accuracy) == (None, 77.5, 4.2)


# ---- refusals leave nothing -----------------------------------------------------


def test_a_photo_over_settings_max_media_bytes_is_refused_with_no_orphan(
    client, db, form, enum, media_root, monkeypatch
):
    monkeypatch.setattr(get_settings(), "max_media_bytes", 1000)
    r = post(client, enum, payload(form, media={"household_photo": ("p.jpg", JPEG[:12] + b"\x00" * 1000)})[1])
    assert r.status_code == 413
    nothing_left(db, media_root)


def test_a_photo_exactly_at_the_cap_is_accepted(client, db, form, enum, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_media_bytes", len(JPEG))
    assert post(client, enum, payload(form)[1]).status_code == 201


def test_a_file_whose_magic_bytes_are_not_an_image_is_refused(client, db, form, enum, media_root):
    bad = ("holiday.jpg", b"<?php system($_GET[1]); ?>")
    r = post(client, enum, payload(form, media={"household_photo": bad})[1])
    assert r.status_code == 415
    nothing_left(db, media_root)


def test_one_bad_file_among_good_ones_leaves_nothing(db, form, enum, media_root, monkeypatch):
    monkeypatch.setattr(submissions, "_media_questions", lambda spec: {"household_photo", "child_photo"})
    media = {"household_photo": MediaPart("a.jpg", JPEG), "child_photo": MediaPart("b.jpg", b"x")}
    with pytest.raises(IntakeRefused) as e:
        store_submission(db, form["fv"], enum, GOOD, {}, media, str(uuidlib.uuid4()), fake_request())
    assert e.value.status_code == 415
    nothing_left(db, media_root)


def test_media_is_not_written_under_a_client_supplied_name(client, db, form, enum, media_root):
    _, files = payload(form, media={"household_photo": ("../../evil.php", PNG)})
    assert post(client, enum, files).status_code == 201
    m = db.scalars(select(MediaFile)).one()
    stored = media_root / m.storage_path
    assert ".." not in m.storage_path
    assert stored.name == "household_photo.png"  # extension from the sniffed type
    assert m.content_type == "image/png" and "evil" not in m.filename
    assert [p.name for p in disk(media_root)] == ["household_photo.png"]
    assert stored.resolve().is_relative_to(media_root.resolve())


@pytest.mark.parametrize(
    "part", ["../../evil", "..\\evil", "household_photo/../x", "evil.php", "not_a_question", "asha_name"]
)
def test_a_media_part_that_is_not_an_image_question_of_the_form_is_refused(
    client, db, form, enum, media_root, part
):
    r = post(client, enum, payload(form, media={part: ("p.jpg", JPEG)})[1])
    assert r.status_code == 422
    nothing_left(db, media_root)


@pytest.mark.parametrize("bad", ["../../etc/passwd", "not-a-uuid", "x" * 200, "1234"])
def test_a_uuid_that_is_not_a_uuid_is_refused_and_never_reaches_a_path(client, db, form, enum, media_root, bad):
    r = post(client, enum, payload(form, uuid=bad)[1])
    assert r.status_code == 422
    nothing_left(db, media_root)


def test_a_uuid_is_normalised_so_a_differently_cased_replay_is_still_a_replay(client, db, form, enum):
    uid = str(uuidlib.uuid4())
    assert post(client, enum, payload(form, uuid=uid)[1]).status_code == 201
    assert post(client, enum, payload(form, uuid=uid.upper())[1]).status_code == 200
    assert _count(db, Submission) == 1


def test_a_failure_inside_the_transaction_rolls_back_rows_and_media(db, form, enum, media_root, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(submissions.audit, "record", boom)  # the last step before commit
    with pytest.raises(RuntimeError):
        store_submission(
            db, form["fv"], enum, GOOD, {"children": [CHILD]},
            {"household_photo": MediaPart("a.jpg", JPEG)}, str(uuidlib.uuid4()), fake_request(),
        )
    nothing_left(db, media_root)


def test_a_media_write_failure_rolls_back_rows_and_earlier_files(db, form, enum, media_root, monkeypatch):
    real = submissions.encrypt_bytes
    calls = []

    def flaky(data):
        calls.append(1)
        if len(calls) == 2:
            raise OSError("no space")
        return real(data)

    monkeypatch.setattr(submissions, "encrypt_bytes", flaky)
    monkeypatch.setattr(submissions, "_media_questions", lambda spec: {"household_photo", "child_photo"})
    media = {"household_photo": MediaPart("a.jpg", JPEG), "child_photo": MediaPart("b.jpg", JPEG)}
    with pytest.raises(OSError):
        store_submission(db, form["fv"], enum, GOOD, {}, media, str(uuidlib.uuid4()), fake_request())
    assert len(calls) == 2  # the first file really was written before the second failed
    nothing_left(db, media_root)


def test_an_unpublished_version_is_not_accepted(client, db, form, enum, media_root):
    form["fv"].published_at = None
    db.commit()
    assert post(client, enum, payload(form)[1]).status_code == 404
    nothing_left(db, media_root)


def test_an_unknown_form_is_404_for_staff_and_looks_like_unassigned_to_enumerators(client, db, form, enum):
    _, files = payload(form)
    sub = json.loads(files["submission"][1])
    files["submission"] = (None, json.dumps({**sub, "form_id": "nope"}), "application/json")
    assert post(client, form["sup"], files).status_code == 404
    assert post(client, enum, files).status_code == 403


def test_malformed_bodies_are_refused_cleanly(client, db, form, enum, media_root):
    h = _hdr(enum)
    assert client.post("/api/submissions", files={"x": (None, "y")}, headers=h).status_code == 422
    assert client.post("/api/submissions", files={"submission": (None, "{not json")}, headers=h).status_code == 422
    bare = {"submission": (None, json.dumps({"uuid": "a"}))}
    assert client.post("/api/submissions", files=bare, headers=h).status_code == 422
    assert client.post("/api/submissions", json={"a": 1}, headers=h).status_code in (400, 415, 422)
    nothing_left(db, media_root)


def test_unauthenticated_is_401(client, form):
    assert client.post("/api/submissions", files=payload(form)[1]).status_code == 401


# ---- authorisation --------------------------------------------------------------


def test_an_enumerator_cannot_submit_to_an_unassigned_form(client, db, form, user_factory, media_root):
    stranger = user_factory(username="stranger", role="enumerator")
    assert post(client, stranger, payload(form)[1]).status_code == 403
    nothing_left(db, media_root)


def test_a_deactivated_enumerator_cannot_submit(client, db, form, enum):
    enum.is_active = False
    db.commit()
    assert post(client, enum, payload(form)[1]).status_code == 401


def test_staff_may_submit_without_an_assignment(client, db, form):
    assert post(client, form["sup"], payload(form)[1]).status_code == 201


# ---- listing ----------------------------------------------------------------------


def test_an_enumerator_listing_submissions_sees_only_their_own(client, db, form, enum, user_factory):
    other = user_factory(username="enum2", role="enumerator")
    db.add(Assignment(user_id=other.id, form_id=form["fv"].form_id))
    db.commit()
    mine, theirs = payload(form)[0], payload(form)[0]
    post(client, enum, payload(form, uuid=mine)[1])
    post(client, other, payload(form, uuid=theirs)[1])
    own = client.get("/api/submissions", headers=_hdr(enum)).json()
    assert [i["uuid"] for i in own["items"]] == [mine] and own["total"] == 1
    everyone = client.get("/api/submissions", headers=_hdr(form["sup"])).json()
    assert {i["uuid"] for i in everyone["items"]} == {mine, theirs}
    # asking for the other's by id does not reveal that it exists
    assert client.get(f"/api/submissions/{theirs}", headers=_hdr(enum)).status_code == 404
    assert client.get(f"/api/submissions/{mine}", headers=_hdr(enum)).status_code == 200


def test_listing_filters_by_form_and_status_and_pages(client, db, form, enum):
    for _ in range(3):
        post(client, enum, payload(form)[1])
    post(client, enum, payload(form, data={})[1])  # flagged
    h = _hdr(form["sup"])
    assert client.get("/api/submissions?status=flagged", headers=h).json()["total"] == 1
    assert client.get("/api/submissions?status=received", headers=h).json()["total"] == 3
    assert client.get(f"/api/submissions?form_id={form['form_id']}", headers=h).json()["total"] == 4
    assert client.get("/api/submissions?form_id=other", headers=h).json()["total"] == 0
    p1 = client.get("/api/submissions?page_size=3", headers=h).json()
    p2 = client.get("/api/submissions?page_size=3&page=2", headers=h).json()
    assert (len(p1["items"]), len(p2["items"]), p1["total"]) == (3, 1, 4)
    assert not {i["uuid"] for i in p1["items"]} & {i["uuid"] for i in p2["items"]}
    assert client.get("/api/submissions?status=bogus", headers=h).status_code == 422
    assert client.get("/api/submissions?page=0", headers=h).status_code == 422


def test_the_detail_shows_answers_failures_media_but_no_storage_path(client, db, form, enum):
    uid, files = payload(form, data={**GOOD, "household_children": 99})
    post(client, enum, files)
    d = client.get(f"/api/submissions/{uid}", headers=_hdr(form["sup"])).json()
    assert d["uuid"] == uid and d["data"]["asha_name"] == "Sunita" and d["status"] == "flagged"
    assert d["repeats"]["children"][0]["child_name"] == "Ravi"
    assert d["media"] == [
        {
            "question_name": "household_photo",
            "content_type": "image/jpeg",
            "size": len(JPEG),
            "sha256": d["media"][0]["sha256"],
        }
    ]
    assert d["failures"][0]["rule"] == "constraint" and d["likely_duplicates"] == []
    assert "storage_path" not in json.dumps(d)
    assert client.get(f"/api/submissions/{uuidlib.uuid4()}", headers=_hdr(form["sup"])).status_code == 404


# ---- duplicates ---------------------------------------------------------------------


def _store(db, form, enum, data=GOOD, repeats=None):
    sub, created = store_submission(
        db, form["fv"], enum, data, {"children": [CHILD]} if repeats is None else repeats,
        {}, str(uuidlib.uuid4()), fake_request(),
    )
    assert created
    return sub


def test_a_matching_duplicate_key_is_listed_but_both_rows_are_kept(db, form, enum):
    first, second = _store(db, form, enum), _store(db, form, enum)
    assert [s.id for s in likely_duplicates(db, second)] == [first.id]
    assert [s.id for s in likely_duplicates(db, first)] == [second.id]
    assert _count(db, Submission) == 2
    assert all(s.status == "received" for s in db.scalars(select(Submission)))


def test_the_default_key_tells_two_households_of_the_same_asha_apart(db, form, enum):
    a = _store(db, form, enum)
    b = _store(db, form, enum, repeats={"children": [{**CHILD, "child_name": "Mina"}]})
    c = _store(db, form, enum, data={**GOOD, "household_children": 3})
    assert likely_duplicates(db, a) == [] and likely_duplicates(db, b) == [] and likely_duplicates(db, c) == []


def test_the_default_key_ignores_case_and_surrounding_spaces(db, form, enum):
    a = _store(db, form, enum)
    b = _store(db, form, enum, data={**GOOD, "asha_name": "  SUNITA "})
    assert [s.id for s in likely_duplicates(db, b)] == [a.id]


def test_a_form_can_configure_its_own_duplicate_key(db, form, enum, monkeypatch):
    monkeypatch.setattr(get_settings(), "duplicate_keys", {form["form_id"]: ["asha_name", "block"]})
    a = _store(db, form, enum)
    b = _store(db, form, enum, data={**GOOD, "household_children": 7}, repeats={})
    assert [s.id for s in likely_duplicates(db, b)] == [a.id]


def test_an_all_blank_configured_key_matches_nothing(db, form, enum, monkeypatch):
    monkeypatch.setattr(get_settings(), "duplicate_keys", {form["form_id"]: ["asha_name"]})
    a = _store(db, form, enum, data={"district": "patna"}, repeats={})
    b = _store(db, form, enum, data={"district": "gaya"}, repeats={})
    assert likely_duplicates(db, b) == [] and likely_duplicates(db, a) == []


def test_duplicates_are_only_looked_for_within_the_same_form(db, form, enum):
    a = _store(db, form, enum)
    other = Form(form_id="other", title="o", created_by=enum.id)
    other_fv = FormVersion(
        form=other, version="2026103101", xlsform_blob=b"", xform_xml="",
        json_spec=form["fv"].json_spec, published_by=enum.id, published_at=datetime.now(UTC),
    )
    db.add(other_fv)
    db.commit()
    b, _ = store_submission(
        db, other_fv, form["sup"], GOOD, {"children": [CHILD]}, {}, str(uuidlib.uuid4()), fake_request()
    )
    assert likely_duplicates(db, b) == [] and likely_duplicates(db, a) == []


def test_the_detail_lists_likely_duplicates_for_staff_only(client, db, form, enum):
    u1, u2 = payload(form)[0], payload(form)[0]
    post(client, enum, payload(form, uuid=u1)[1])
    post(client, enum, payload(form, uuid=u2)[1])
    d = client.get(f"/api/submissions/{u2}", headers=_hdr(form["sup"])).json()
    assert d["likely_duplicates"] == [u1]
    assert client.get(f"/api/submissions/{u2}", headers=_hdr(enum)).json()["likely_duplicates"] == []
