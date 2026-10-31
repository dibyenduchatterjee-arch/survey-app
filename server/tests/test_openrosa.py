"""OpenRosa endpoints (ODK Collect fallback). Wire translation only: the intake rules are
Task 11's and are exercised here only to prove this route reaches them."""

import uuid as uuidlib
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.api import openrosa
from app.core.config import get_settings
from app.core.security import create_access_token
from app.db.models import Assignment, FormVersion, MediaFile, RepeatRow, Submission

FIX = Path(__file__).parent / "fixtures"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x01" * 200
PW = "correct-horse-battery"
RESP_NS = "{http://openrosa.org/http/response}"


def _count(db, model):
    return db.scalar(select(func.count()).select_from(model))


@pytest.fixture
def media_root(tmp_path, monkeypatch):
    root = tmp_path / "media"
    root.mkdir()
    monkeypatch.setattr(get_settings(), "media_root", root)
    return root


@pytest.fixture
def form(client, db, user_factory, media_root, join_project):
    sup = user_factory(username="sup", role="supervisor", password=PW)
    join_project(db, sup)
    hdr = {"Authorization": f"Bearer {create_access_token(sup.id, sup.role)}"}
    data = (FIX / "amb_asha_visit.xlsx").read_bytes()
    r = client.post("/api/forms", files={"file": ("f.xlsx", data, XLSX)}, headers=hdr)
    assert r.status_code == 201, r.text
    body = r.json()
    r = client.post(f"/api/forms/{body['form_id']}/publish", json={"version": body["version"]}, headers=hdr)
    assert r.status_code == 200
    return {"form_id": body["form_id"], "version": body["version"], "fv": db.scalars(select(FormVersion)).one()}


@pytest.fixture
def enum(db, user_factory, form):
    u = user_factory(username="enum1", role="enumerator", password=PW)
    db.add(Assignment(user_id=u.id, form_id=form["fv"].form_id))
    db.commit()
    return u


SUP = ("sup", PW)
ENUM = ("enum1", PW)


def instance(form, uid=None, *, children=2, kids=None, prefix="uuid:", photo="p.jpg", extra="", location="25.6 85.1 0 5"):
    uid = uid or str(uuidlib.uuid4())
    kids = kids if kids is not None else (
        "<children><child_name>Ravi</child_name><child_age_months>48</child_age_months>"
        "<ifa_form>pink</ifa_form><symptoms>fatigue pallor</symptoms><referral_note>pale</referral_note></children>"
        "<children><child_name>Mina</child_name><child_age_months>20</child_age_months>"
        "<ifa_form>syrup</ifa_form><syrup_given>yes</syrup_given>"
        "<ifa_doses><dose_date>2026-10-01</dose_date><dose_ml>5</dose_ml></ifa_doses>"
        "<ifa_doses><dose_date>2026-10-08</dose_date><dose_ml>5</dose_ml></ifa_doses></children>"
    )
    xml = (
        f'<?xml version="1.0"?><data id="{form["form_id"]}" version="{form["version"]}" '
        'xmlns:jr="http://openrosa.org/javarosa" xmlns:orx="http://openrosa.org/xforms">'
        "<start>2026-10-31T10:00:00.000+05:30</start><end>2026-10-31T10:20:00.000+05:30</end>"
        "<district>patna</district><block>danapur</block><asha_name>Sunita</asha_name>"
        f"<visit_location>{location}</visit_location><household_photo>{photo}</household_photo>"
        f"<household_children>{children}</household_children>{kids}<children_count>2</children_count>"
        f"{extra}<meta><instanceID>{prefix}{uid}</instanceID></meta></data>"
    )
    return uid, xml.encode()


def post(client, xml, auth=ENUM, media=None, xml_name="xml_submission_file"):
    files = {xml_name: ("submission.xml", xml, "text/xml")}
    for name, content in (media if media is not None else {"p.jpg": JPEG}).items():
        files[name] = (name, content, "image/jpeg")
    return client.post("/openrosa/submission", files=files, auth=auth)


def msg(r):
    root = ET.fromstring(r.text)
    assert root.tag == RESP_NS + "OpenRosaResponse"
    return root.find(RESP_NS + "message")


def nothing_stored(db, root):
    assert _count(db, Submission) == 0 and _count(db, MediaFile) == 0 and _count(db, RepeatRow) == 0
    assert list(root.iterdir()) == []


# ---- form list and download ------------------------------------------------------


def test_formlist_lists_published_forms_with_the_openrosa_header(client, form, enum):
    r = client.get("/openrosa/formList", auth=ENUM)
    assert r.status_code == 200
    assert r.headers["X-OpenRosa-Version"] == "1.0" and "<xforms" in r.text
    assert r.headers["content-type"].startswith("text/xml")
    root = ET.fromstring(r.text)
    ns = "{http://openrosa.org/xforms/xformsList}"
    (x,) = root.findall(ns + "xform")
    assert x.find(ns + "formID").text == form["form_id"]
    assert x.find(ns + "version").text == form["version"]
    assert x.find(ns + "hash").text.startswith("md5:")
    url = x.find(ns + "downloadUrl").text
    assert url.endswith(f"/openrosa/forms/{form['form_id']}/{form['version']}.xml")


def test_formlist_requires_authentication(client, form):
    r = client.get("/openrosa/formList")
    assert r.status_code == 401
    assert r.headers["WWW-Authenticate"].startswith("Basic")
    assert r.headers["X-OpenRosa-Version"] == "1.0"


@pytest.mark.parametrize("creds", [("enum1", "wrong"), ("nobody", PW), ("enum1", ""), ("", "")])
def test_bad_credentials_are_401_not_500(client, form, enum, creds):
    assert client.get("/openrosa/formList", auth=creds).status_code == 401


def test_malformed_authorization_headers_are_401(client, form, enum):
    for h in ("Basic", "Basic !!!notbase64", "Basic bm9jb2xvbg==", "Bearer abc", "Basic /w=="):
        assert client.get("/openrosa/formList", headers={"Authorization": h}).status_code == 401


def test_a_deactivated_account_is_401(client, db, form, enum):
    enum.is_active = False
    db.commit()
    assert client.get("/openrosa/formList", auth=ENUM).status_code == 401


def test_a_bearer_token_is_not_accepted_here(client, form, enum):
    h = {"Authorization": f"Bearer {create_access_token(enum.id, enum.role)}"}
    assert client.get("/openrosa/formList", headers=h).status_code == 401


def test_repeated_wrong_passwords_are_rate_limited(client, form, enum):
    codes = [client.get("/openrosa/formList", auth=("enum1", "bad")).status_code for _ in range(7)]
    assert codes[:5] == [401] * 5 and codes[-1] == 429
    assert client.get("/openrosa/formList", auth=ENUM).status_code == 429


def test_an_enumerator_does_not_see_unassigned_forms(client, form, user_factory):
    user_factory(username="other", role="enumerator", password=PW)
    r = client.get("/openrosa/formList", auth=("other", PW))
    assert r.status_code == 200 and "<xform>" not in r.text
    assert client.get(f"/openrosa/forms/{form['form_id']}/{form['version']}.xml", auth=("other", PW)).status_code == 403
    # an unknown form is refused exactly like an unassigned one: forms cannot be probed
    unknown = client.get(f"/openrosa/forms/nope/{form['version']}.xml", auth=("other", PW))
    assert unknown.status_code == 403
    assert unknown.text == client.get(
        f"/openrosa/forms/{form['form_id']}/{form['version']}.xml", auth=("other", PW)
    ).text


def test_the_xform_is_served_as_stored(client, form, enum):
    r = client.get(f"/openrosa/forms/{form['form_id']}/{form['version']}.xml", auth=ENUM)
    assert r.status_code == 200 and r.headers["X-OpenRosa-Version"] == "1.0"
    assert r.text == form["fv"].xform_xml
    assert client.get(f"/openrosa/forms/{form['form_id']}/nope.xml", auth=SUP).status_code == 404
    assert client.get("/openrosa/forms/nope/1.xml", auth=SUP).status_code == 404


def test_an_unpublished_version_is_not_served(client, db, form, enum):
    form["fv"].published_at = None
    form["fv"].is_current = False
    db.commit()
    assert client.get(f"/openrosa/forms/{form['form_id']}/{form['version']}.xml", auth=SUP).status_code == 404
    assert "<xform>" not in client.get("/openrosa/formList", auth=SUP).text


# ---- submission: HEAD ------------------------------------------------------------------


def test_head_on_submission_returns_204_with_max_size(client, enum):
    r = client.head("/openrosa/submission", auth=ENUM)
    assert r.status_code == 204
    assert r.headers["X-OpenRosa-Version"] == "1.0"
    assert int(r.headers["X-OpenRosa-Accept-Content-Length"]) > get_settings().max_media_bytes


def test_head_requires_authentication(client):
    assert client.head("/openrosa/submission").status_code == 401


# ---- submission: POST -----------------------------------------------------------------


def test_a_posted_xml_instance_is_stored_as_a_submission(client, db, form, enum, media_root):
    uid, xml = instance(form)
    r = post(client, xml)
    assert r.status_code == 201, r.text
    assert r.headers["X-OpenRosa-Version"] == "1.0"
    assert msg(r).get("nature") == "submit_success"
    s = db.scalars(select(Submission)).one()
    assert s.uuid == uid and s.submitted_by == enum.id and s.status == "received", s.failures_json
    assert s.data_json["district"] == "patna" and s.data_json["household_children"] == 2
    assert s.data_json["household_photo"] == "p.jpg"
    assert "children" not in s.data_json and "meta" not in s.data_json
    rows = db.scalars(select(RepeatRow).order_by(RepeatRow.row_index)).all()
    assert [r_.repeat_name for r_ in rows] == ["children", "children"]
    assert rows[0].data_json["child_name"] == "Ravi" and rows[0].data_json["child_age_months"] == 48
    assert rows[0].data_json["symptoms"] == "fatigue pallor"
    assert [d["dose_ml"] for d in rows[1].data_json["ifa_doses"]] == [5, 5]
    assert s.started_at is not None and s.finished_at is not None
    (m,) = db.scalars(select(MediaFile)).all()
    assert m.question_name == "household_photo"  # mapped from the file NAME, not the part name
    assert [p for p in media_root.rglob("*") if p.is_file()]


def test_replaying_the_same_instance_id_does_not_duplicate(client, db, form, enum, media_root):
    uid, xml = instance(form)
    first = post(client, xml)
    second = post(client, xml)
    assert first.status_code == 201 and second.status_code == 201  # Collect treats only 201/202 as success
    assert _count(db, Submission) == 1 and _count(db, MediaFile) == 1 and _count(db, RepeatRow) == 2
    a, b = ET.fromstring(first.text), ET.fromstring(second.text)
    meta_a, meta_b = a.find(RESP_NS + "submissionMetadata"), b.find(RESP_NS + "submissionMetadata")
    assert meta_a.get("instanceID") == meta_b.get("instanceID") == f"uuid:{uid}"
    assert meta_a.get("submissionDate") == meta_b.get("submissionDate")  # the ORIGINAL receipt


def test_a_replay_still_succeeds_after_the_assignment_is_removed(client, db, form, enum):
    uid, xml = instance(form)
    assert post(client, xml).status_code == 201
    db.query(Assignment).delete()
    db.commit()
    assert post(client, xml).status_code == 201
    assert _count(db, Submission) == 1


def test_the_uuid_prefix_is_optional_and_case_is_normalised(client, db, form, enum):
    uid, xml = instance(form, prefix="uuid:")
    post(client, xml)
    _, bare = instance(form, uid=uid.upper(), prefix="")
    assert post(client, bare).status_code == 201
    assert _count(db, Submission) == 1


def test_another_users_instance_id_is_refused_without_revealing_it(client, db, form, enum, user_factory):
    other = user_factory(username="e2", role="enumerator", password=PW)
    db.add(Assignment(user_id=other.id, form_id=form["fv"].form_id))
    db.commit()
    uid, xml = instance(form)
    assert post(client, xml).status_code == 201
    r = post(client, xml, auth=("e2", PW))
    assert r.status_code == 409 and msg(r).get("nature") == "error" and "uuid_in_use" in msg(r).text
    assert _count(db, Submission) == 1


def test_a_failing_validation_is_stored_flagged_not_refused(client, db, form, enum):
    _, xml = instance(form, children=99)
    r = post(client, xml)
    assert r.status_code == 201
    s = db.scalars(select(Submission)).one()
    assert s.status == "flagged" and s.failures_json
    assert "flagged" in msg(r).text


def test_an_unassigned_enumerator_is_refused_in_openrosa_shape_and_nothing_is_stored(
    client, db, form, user_factory, media_root
):
    user_factory(username="other", role="enumerator", password=PW)
    _, xml = instance(form)
    r = post(client, xml, auth=("other", PW))
    assert r.status_code == 403 and r.headers["X-OpenRosa-Version"] == "1.0"
    assert msg(r).get("nature") == "error" and "not_assigned" in msg(r).text
    nothing_stored(db, media_root)


def test_unauthenticated_post_is_401_and_stores_nothing(client, db, form, media_root):
    _, xml = instance(form)
    files = {"xml_submission_file": ("s.xml", xml, "text/xml")}
    r = client.post("/openrosa/submission", files=files)
    assert r.status_code == 401 and r.headers["WWW-Authenticate"].startswith("Basic")
    nothing_stored(db, media_root)


def test_a_file_that_is_not_an_image_is_refused_by_intake_and_leaves_nothing(client, db, form, enum, media_root):
    _, xml = instance(form)
    r = post(client, xml, media={"p.jpg": b"MZ\x90\x00 not a picture"})
    assert r.status_code == 415 and "file_type_mismatch" in msg(r).text
    nothing_stored(db, media_root)


def test_a_file_the_instance_never_references_is_refused(client, db, form, enum, media_root):
    _, xml = instance(form)
    r = post(client, xml, media={"p.jpg": JPEG, "stray.jpg": JPEG})
    assert r.status_code == 422 and "media_slot_unknown" in msg(r).text
    nothing_stored(db, media_root)


def test_a_missing_instance_id_is_a_400(client, db, form, enum, media_root):
    _, xml = instance(form)
    xml = xml.replace(b"<meta>", b"<nometa>").replace(b"</meta>", b"</nometa>")
    r = post(client, xml)
    assert r.status_code == 400 and msg(r).get("nature") == "error"
    nothing_stored(db, media_root)


@pytest.mark.parametrize(
    "bad",
    [
        b"not xml at all",
        b"",
        b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><data id="x" version="1"><a>&a;</a></data>',
        b"<data/>",
    ],
)
def test_malformed_xml_is_a_400(client, db, form, enum, media_root, bad):
    r = post(client, bad)
    assert r.status_code == 400 and msg(r).get("nature") == "error"
    nothing_stored(db, media_root)


def test_the_instance_file_part_is_required(client, db, form, enum):
    _, xml = instance(form)
    r = post(client, xml, xml_name="something_else")
    assert r.status_code == 400 and msg(r).get("nature") == "error"
    assert _count(db, Submission) == 0


def test_an_unknown_form_is_masked_like_an_unassigned_one(client, db, form, enum, media_root):
    _, xml = instance(form)
    r = post(client, xml.replace(form["form_id"].encode(), b"ghost_form"))
    assert r.status_code == 403 and "not_assigned" in msg(r).text
    nothing_stored(db, media_root)


def test_a_submission_split_across_posts_keeps_every_file(client, db, form, enum, media_root):
    """Collect sends the same instance again with the attachments it did not fit in the first POST."""
    uid, xml = instance(form)
    first = post(client, xml, media={})
    assert first.status_code == 202 and _count(db, MediaFile) == 0  # the photo is named but not here yet
    again = post(client, xml, media={})  # still outstanding: still 202, still one submission
    assert again.status_code == 202 and _count(db, Submission) == 1
    second = post(client, xml, media={"p.jpg": JPEG})
    assert second.status_code == 201  # everything the instance names is now stored
    assert _count(db, Submission) == 1 and _count(db, MediaFile) == 1
    third = post(client, xml, media={"p.jpg": JPEG})  # the same again changes nothing
    assert third.status_code == 201 and _count(db, MediaFile) == 1
    (m,) = db.scalars(select(MediaFile)).all()
    assert m.question_name == "household_photo" and len([p for p in media_root.rglob("*") if p.is_file()]) == 1
    meta = [ET.fromstring(r.text).find(RESP_NS + "submissionMetadata").get("submissionDate") for r in (first, second, third)]
    assert len(set(meta)) == 1


def test_202_names_how_many_attachments_are_outstanding_and_201_when_none_are_expected(client, db, form, enum):
    _, xml = instance(form)
    r = post(client, xml, media={})
    assert r.status_code == 202 and "1 attachment" in msg(r).text and msg(r).get("nature") == "submit_success"
    _, none_expected = instance(form, photo="")
    r = post(client, none_expected, media={})
    assert r.status_code == 201 and "attachment" not in msg(r).text


def test_a_complete_single_post_is_201(client, form, enum):
    _, xml = instance(form)
    assert post(client, xml).status_code == 201


def test_the_geopoint_string_fills_the_gps_columns(client, db, form, enum):
    _, xml = instance(form, location="25.6123 85.1456 52.5 4.5")
    assert post(client, xml).status_code == 201
    s = db.scalars(select(Submission)).one()
    assert (s.gps_lat, s.gps_lon, s.gps_accuracy) == (25.6123, 85.1456, 4.5)
    assert s.data_json["visit_location"] == "25.6123 85.1456 52.5 4.5"


def test_a_geopoint_without_accuracy_still_gives_coordinates(client, db, form, enum):
    _, xml = instance(form, location="25.6 85.1")
    assert post(client, xml).status_code == 201
    s = db.scalars(select(Submission)).one()
    assert (s.gps_lat, s.gps_lon, s.gps_accuracy) == (25.6, 85.1, None)


@pytest.mark.parametrize(
    "bad", ["north east", "25.6", "95 85 0 5", "25 200 0 5", "nan 85 0 1", "1 2 3 4 5", "25 85 1 -2", "25 85 abc 4"]
)
def test_an_unparseable_geopoint_is_an_error_not_blank_columns(client, db, form, enum, media_root, bad):
    _, xml = instance(form, location=bad)
    r = post(client, xml)
    assert r.status_code == 422 and "bad_geopoint" in msg(r).text
    nothing_stored(db, media_root)


def test_a_blank_geopoint_means_no_gps_was_captured(client, db, form, enum):
    _, xml = instance(form, location="")
    assert post(client, xml).status_code == 201
    assert db.scalars(select(Submission)).one().gps_lat is None


# ---- XML -> {data, repeats}, unit level -----------------------------------------------


SPEC = {
    "nodes": [
        {"type": "text", "name": "a"},
        {"type": "group", "name": "g", "children": [
            {"type": "integer", "name": "n"},
            {"type": "group", "name": "inner", "children": [{"type": "decimal", "name": "d"}]},
        ]},
        {"type": "repeat", "name": "rep", "children": [
            {"type": "text", "name": "x"},
            {"type": "group", "name": "rg", "children": [{"type": "text", "name": "y"}]},
            {"type": "repeat", "name": "sub", "children": [{"type": "image", "name": "pic"}]},
        ]},
    ]
}


def test_groups_flatten_and_repeats_nest_under_their_parent_row():
    root = ET.fromstring(
        "<data><a>hi</a><g><n>3</n><inner><d>1.5</d></inner></g>"
        "<rep><x>1</x><rg><y>why</y></rg><sub><pic>a.jpg</pic></sub><sub><pic>b.jpg</pic></sub></rep>"
        "<rep><x/></rep><meta><instanceID>uuid:z</instanceID></meta></data>"
    )
    data, repeats, leaves = openrosa.parse_instance(root, SPEC)
    assert data == {"a": "hi", "n": 3, "d": 1.5}
    assert repeats == {"rep": [
        {"x": "1", "y": "why", "sub": [{"pic": "a.jpg"}, {"pic": "b.jpg"}]},
        {},
    ]}
    assert ("pic", "a.jpg") in leaves


def test_a_non_numeric_integer_is_kept_as_text_for_validation_to_flag():
    root = ET.fromstring("<data><g><n>abc</n></g></data>")
    data, _, _ = openrosa.parse_instance(root, SPEC)
    assert data == {"n": "abc"}


def test_namespaced_elements_are_read_by_local_name():
    root = ET.fromstring('<data xmlns="http://www.w3.org/2002/xforms"><a>hi</a></data>')
    assert openrosa.parse_instance(root, SPEC)[0] == {"a": "hi"}
