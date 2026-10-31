"""CSV export (Task 13), built from the real AMB fixture form.

Assertions that are about encoding are made on BYTES; a test that decodes first cannot
see a missing BOM.
"""

import csv
import io
import zipfile
from pathlib import Path

import pytest

from app.core.config import get_settings
from app.core.crypto import encrypt_bytes
from app.db.models import Form, FormVersion, MediaFile, RepeatRow, Submission, User
from app.export.csv_export import build_csvs
from app.export.media import build_media_zip
from app.forms.compile import compile_spec
from app.forms.xlsform import to_xform

FIX = Path(__file__).parent / "fixtures"
MAIN = "amb_asha_visit.csv"
CHILDREN = "amb_asha_visit_children.csv"
DOSES = "amb_asha_visit_children_ifa_doses.csv"
JPEG = b"\xff\xd8\xff\xe0" + b"jpeg-bytes" * 5
U1 = "11111111-1111-4111-8111-111111111111"
U2 = "22222222-2222-4222-8222-222222222222"


@pytest.fixture(scope="module")
def spec():
    return compile_spec(to_xform((FIX / "amb_asha_visit.xlsx").read_bytes()))


@pytest.fixture
def media_root(tmp_path, monkeypatch):
    root = tmp_path / "media"
    root.mkdir()
    monkeypatch.setattr(get_settings(), "media_root", root)
    return root


@pytest.fixture
def fv(db):
    u = User(username="asha1", password_hash="x", role="enumerator", full_name="T")
    db.add(u)
    db.commit()
    f = Form(form_id="amb_asha_visit", title="AMB", created_by=u.id)
    db.add(f)
    db.commit()
    v = FormVersion(form_id=f.id, version="1", xlsform_blob=b"x", xform_xml="<x/>",
                    json_spec={}, published_by=u.id, is_current=True)
    db.add(v)
    db.commit()
    return v


@pytest.fixture
def make(db, fv):
    def _make(uid, data=None, rows=(), status="received", failures=None):
        s = Submission(uuid=uid, form_version_id=fv.id, submitted_by=1, data_json=data or {},
                       status=status, failures_json=failures)
        db.add(s)
        db.flush()
        for i, row in enumerate(rows, start=1):
            db.add(RepeatRow(submission_id=s.id, repeat_name="children", row_index=i, data_json=row))
        db.commit()
        return s

    return _make


def parse(blob: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(blob.decode("utf-8-sig"), newline="")))


def dicts(blob: bytes) -> list[dict]:
    head, *rows = parse(blob)
    return [dict(zip(head, r)) for r in rows]


# ---- encoding (Review Focus 1) -------------------------------------------------------


def test_every_file_starts_with_a_utf8_bom(spec, make):
    files = build_csvs(spec, [make(U1)])
    assert files
    for name, blob in files.items():
        assert blob.startswith(b"\xef\xbb\xbf"), name


def test_lines_end_with_crlf_in_the_raw_bytes(spec, make):
    blob = build_csvs(spec, [make(U1)])[MAIN]
    assert b"\r\n" in blob and b"\n" not in blob.replace(b"\r\n", b"")


def test_devanagari_decodes_correctly_from_the_bytes(spec, make):
    s = make(U1, {"district": "muzaffarpur", "asha_name": "मुजफ्फरपुर की सुनीता"})
    blob = build_csvs(spec, [s])[MAIN]
    assert "मुजफ्फरपुर की सुनीता" in blob.decode("utf-8-sig")
    assert "मुजफ्फरपुर".encode() in blob  # stored as real UTF-8, not escaped or replaced
    assert b"?" not in blob.split(b"\r\n")[1]


# ---- main file ------------------------------------------------------------------------


def test_main_file_is_first_and_columns_follow_the_form_after_metadata(spec, make):
    files = build_csvs(spec, [make(U1)])
    assert next(iter(files)) == MAIN
    head = parse(files[MAIN])[0]
    assert head[:5] == ["uuid", "submitted_by", "received_at", "status", "failures"]
    assert head[5:] == [
        "district", "block", "asha_name",
        "visit_location_lat", "visit_location_lon", "visit_location_accuracy",
        "household_photo", "household_children", "children_count",
    ]  # repeats and the note are not columns here


def test_select_multiple_is_written_space_separated(spec, make):
    child = {"child_name": "Mina", "symptoms": "fatigue pallor"}
    s = make(U1, rows=[child])
    assert dicts(build_csvs(spec, [s])[CHILDREN])[0]["symptoms"] == "fatigue pallor"


def test_geopoint_is_split_into_lat_lon_and_accuracy_columns(spec, make):
    s = make(U1, {"visit_location": "25.6127 85.1589 52.0 7.5"})
    row = dicts(build_csvs(spec, [s])[MAIN])[0]
    assert (row["visit_location_lat"], row["visit_location_lon"], row["visit_location_accuracy"]) == (
        "25.6127", "85.1589", "7.5")
    assert "visit_location" not in row


def test_a_missing_geopoint_leaves_the_three_cells_blank(spec, make):
    row = dicts(build_csvs(spec, [make(U1)])[MAIN])[0]
    assert (row["visit_location_lat"], row["visit_location_lon"], row["visit_location_accuracy"]) == ("", "", "")


def test_metadata_cells(spec, make):
    row = dicts(build_csvs(spec, [make(U1, {"household_children": 2})])[MAIN])[0]
    assert row["uuid"] == U1 and row["submitted_by"] == "asha1" and row["status"] == "received"
    assert row["received_at"].startswith("20") and row["household_children"] == "2"
    assert row["failures"] == ""


# ---- flagged ----------------------------------------------------------------------------


def test_a_flagged_submission_shows_status_and_its_failures(spec, make):
    s = make(U1, status="flagged", failures=[
        {"question": "household_children", "rule": "constraint", "message": "Too many"},
        {"question": "", "rule": "error", "message": "Version not published"},
    ])
    row = dicts(build_csvs(spec, [make(U2), s])[MAIN])[1]
    assert row["status"] == "flagged"
    assert row["failures"] == "household_children: Too many | Version not published"


# ---- repeats ------------------------------------------------------------------------------


def test_a_repeat_gets_its_own_file_joined_by_parent_uuid(spec, make):
    s = make(U1, rows=[{"child_name": "Mina"}, {"child_name": "Ravi"}])
    files = build_csvs(spec, [s])
    assert CHILDREN in files
    head = parse(files[CHILDREN])[0]
    assert head[:2] == ["parent_uuid", "row_index"]
    assert head[2:] == ["child_name", "child_sex", "child_age_months", "child_age_years",
                        "ifa_form", "symptoms", "referral_note", "tablet_taken", "syrup_given"]
    rows = dicts(files[CHILDREN])
    assert [(r["parent_uuid"], r["row_index"], r["child_name"]) for r in rows] == [
        (U1, "1", "Mina"), (U1, "2", "Ravi")]


def test_a_repeat_with_zero_rows_still_emits_a_header_only_file(spec, make):
    files = build_csvs(spec, [make(U1)])
    blob = files[CHILDREN]
    assert blob.startswith(b"\xef\xbb\xbf")
    assert blob.decode("utf-8-sig").strip().count("\n") == 0
    assert parse(blob)[0][:2] == ["parent_uuid", "row_index"]
    assert DOSES in files and len(parse(files[DOSES])) == 1


def test_no_submissions_at_all_still_yields_every_header(spec):
    files = build_csvs(spec, [])
    assert list(files) == [MAIN, CHILDREN, DOSES]
    assert all(len(parse(b)) == 1 for b in files.values())


def test_a_nested_repeat_gets_its_own_file_naming_both_levels(spec, make):
    rows = [
        {"child_name": "Mina", "ifa_doses": [{"dose_date": "2026-10-01", "dose_ml": 1},
                                             {"dose_date": "2026-10-02", "dose_ml": 1}]},
        {"child_name": "Ravi", "ifa_doses": [{"dose_date": "2026-10-03", "dose_ml": 2}]},
    ]
    files = build_csvs(spec, [make(U1, rows=rows)])
    assert DOSES in files
    assert "ifa_doses" not in parse(files[CHILDREN])[0]  # not flattened into the parent
    head = parse(files[DOSES])[0]
    assert head == ["parent_uuid", "children_row_index", "row_index", "dose_date", "dose_ml"]
    got = [(r["parent_uuid"], r["children_row_index"], r["row_index"], r["dose_ml"])
           for r in dicts(files[DOSES])]
    assert got == [(U1, "1", "1", "1"), (U1, "1", "2", "1"), (U1, "2", "1", "2")]


def test_repeat_rows_of_two_submissions_join_to_the_right_parent(spec, make):
    a = make(U1, rows=[{"child_name": "A1"}])
    b = make(U2, rows=[{"child_name": "B1"}, {"child_name": "B2"}])
    rows = dicts(build_csvs(spec, [a, b])[CHILDREN])
    assert [(r["parent_uuid"], r["child_name"]) for r in rows] == [(U1, "A1"), (U2, "B1"), (U2, "B2")]


# ---- CSV injection --------------------------------------------------------------------------


@pytest.mark.parametrize("bad", ["=cmd|' /C calc'!A0", "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"])
def test_a_text_value_starting_with_a_formula_character_is_prefixed(spec, make, bad):
    s = make(U1, {"asha_name": bad}, rows=[{"child_name": bad}])
    files = build_csvs(spec, [s])
    assert dicts(files[MAIN])[0]["asha_name"] == "'" + bad
    assert dicts(files[CHILDREN])[0]["child_name"] == "'" + bad


def test_the_equals_prefix_is_visible_in_the_raw_bytes(spec, make):
    blob = build_csvs(spec, [make(U1, {"asha_name": "=cmd|x"})])[MAIN]
    assert b"'=cmd|x" in blob


def test_real_negative_numbers_are_not_mangled(spec, make):
    s = make(U1, {"household_children": -1, "visit_location": "-25.5 -85.5 0 3"})
    row = dicts(build_csvs(spec, [s])[MAIN])[0]
    assert row["household_children"] == "-1"
    assert row["visit_location_lat"] == "-25.5" and row["visit_location_lon"] == "-85.5"


def test_a_failure_message_starting_with_equals_is_defused_too(spec, make):
    s = make(U1, status="flagged", failures=[{"question": "", "rule": "x", "message": "=HYPERLINK()"}])
    assert dicts(build_csvs(spec, [s])[MAIN])[0]["failures"] == "'=HYPERLINK()"


# ---- media ------------------------------------------------------------------------------------


@pytest.fixture
def with_photo(db, make, media_root):
    s = make(U1)
    (media_root / U1).mkdir()
    (media_root / U1 / "1.jpg").write_bytes(encrypt_bytes(JPEG))
    db.add(MediaFile(submission_id=s.id, question_name="household_photo", filename="1.jpg",
                     content_type="image/jpeg", size=len(JPEG), storage_path=f"{U1}/1.jpg", sha256="0" * 64))
    db.commit()
    return s


def test_the_media_column_matches_a_name_inside_the_zip(spec, with_photo):
    name = dicts(build_csvs(spec, [with_photo])[MAIN])[0]["household_photo"]
    assert name == f"{U1}_household_photo.jpg"
    z = zipfile.ZipFile(io.BytesIO(build_media_zip([with_photo])))
    assert name in z.namelist()


def test_the_zip_holds_decrypted_bytes(with_photo):
    z = zipfile.ZipFile(io.BytesIO(build_media_zip([with_photo])))
    assert z.read(f"{U1}_household_photo.jpg") == JPEG


def test_every_media_cell_has_a_zip_entry_and_vice_versa(db, spec, make, media_root, with_photo):
    s2 = make(U2)
    (media_root / U2).mkdir()
    (media_root / U2 / "1.png").write_bytes(encrypt_bytes(b"\x89PNG\r\n\x1a\nxx"))
    db.add(MediaFile(submission_id=s2.id, question_name="household_photo", filename="1.png",
                     content_type="image/png", size=10, storage_path=f"{U2}/1.png", sha256="0" * 64))
    db.commit()
    subs = [with_photo, s2]
    cells = {r["household_photo"] for r in dicts(build_csvs(spec, subs)[MAIN])}
    assert cells == set(zipfile.ZipFile(io.BytesIO(build_media_zip(subs))).namelist())


def test_a_submission_without_media_has_a_blank_cell_and_an_empty_zip(spec, make):
    s = make(U1)
    assert dicts(build_csvs(spec, [s])[MAIN])[0]["household_photo"] == ""
    assert zipfile.ZipFile(io.BytesIO(build_media_zip([s]))).namelist() == []


def test_a_tampered_media_file_is_skipped_and_listed_but_the_rest_still_arrives(
        db, make, media_root, with_photo):
    s2 = make(U2)
    (media_root / U2).mkdir()
    (media_root / U2 / "1.jpg").write_bytes(encrypt_bytes(JPEG))
    db.add(MediaFile(submission_id=s2.id, question_name="household_photo", filename="1.jpg",
                     content_type="image/jpeg", size=len(JPEG), storage_path=f"{U2}/1.jpg", sha256="0" * 64))
    db.commit()
    p = media_root / U1 / "1.jpg"
    b = bytearray(p.read_bytes())
    b[-1] ^= 1
    p.write_bytes(bytes(b))
    z = zipfile.ZipFile(io.BytesIO(build_media_zip([with_photo, s2])))
    assert z.read(f"{U2}_household_photo.jpg") == JPEG
    assert f"{U1}_household_photo.jpg" not in z.namelist()
    report = z.read("export_errors.txt").decode()
    assert U1 in report and "household_photo" in report and U2 not in report


def test_a_missing_media_file_is_skipped_and_listed(with_photo, media_root):
    (media_root / U1 / "1.jpg").unlink()
    z = zipfile.ZipFile(io.BytesIO(build_media_zip([with_photo])))
    assert z.namelist() == ["export_errors.txt"]
    assert U1 in z.read("export_errors.txt").decode()


def test_a_clean_bundle_has_no_error_manifest(with_photo):
    assert "export_errors.txt" not in zipfile.ZipFile(io.BytesIO(build_media_zip([with_photo]))).namelist()


def test_submitted_by_is_the_username(spec, make):
    assert dicts(build_csvs(spec, [make(U1)])[MAIN])[0]["submitted_by"] == "asha1"


@pytest.mark.parametrize("bad", ["somewhere", "25.6", "a b", "25 85 1 2 3", "95 85", "25 190", "25 85 1 -2", "25 85 abc 4"])
def test_a_malformed_geopoint_is_blank_and_listed_and_other_rows_survive(spec, make, bad):
    good = make(U2, {"visit_location": "25.6 85.1 0 4", "asha_name": "Sunita"})
    files = build_csvs(spec, [make(U1, {"visit_location": bad, "asha_name": "Rani"}), good])
    rows = dicts(files[MAIN])
    assert (rows[0]["visit_location_lat"], rows[0]["visit_location_lon"],
            rows[0]["visit_location_accuracy"]) == ("", "", "")
    assert rows[0]["asha_name"] == "Rani"  # the rest of the row is intact
    assert (rows[1]["visit_location_lat"], rows[1]["asha_name"]) == ("25.6", "Sunita")
    report = files["export_errors.txt"].decode("utf-8-sig")
    assert U1 in report and "visit_location" in report and U2 not in report


def test_no_error_file_when_every_geopoint_is_fine(spec, make):
    assert "export_errors.txt" not in build_csvs(spec, [make(U1, {"visit_location": "25.6 85.1"})])


def test_geopoint_without_altitude_or_accuracy_is_valid(spec, make):
    row = dicts(build_csvs(spec, [make(U1, {"visit_location": "25.6 85.1"})])[MAIN])[0]
    assert (row["visit_location_lat"], row["visit_location_accuracy"]) == ("25.6", "")


def test_the_media_zip_reads_media_rows_in_chunks_not_per_submission(db, make, media_root):
    from sqlalchemy import event

    subs = [make(f"00000000-0000-4000-8000-00000000000{i}") for i in range(4)]
    seen: list[str] = []
    engine = db.get_bind()
    listener = lambda conn, cur, stmt, *a: seen.append(stmt) if "FROM media_files" in stmt else None  # noqa: E731
    event.listen(engine, "before_cursor_execute", listener)
    try:
        build_media_zip(subs)
    finally:
        event.remove(engine, "before_cursor_execute", listener)
    assert len(seen) == 1
