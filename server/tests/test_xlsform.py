import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import openpyxl
import pytest

from app.forms.xlsform import XLSFormError, to_xform

FIX = Path(__file__).parent / "fixtures"
FIXTURE = FIX / "amb_asha_visit.xlsx"
BROKEN = FIX / "broken_missing_choices.xlsx"


def test_produces_xform_xml_with_the_form_id():
    xml = to_xform(FIXTURE.read_bytes())
    assert "<h:html" in xml and 'id="amb_asha_visit"' in xml


def test_hindi_labels_survive_the_conversion():
    xml = to_xform(FIXTURE.read_bytes())
    assert "ज़िला" in xml
    assert "प्रखंड" in xml
    assert "आई एफ ए सिरप" in xml
    assert "???" not in xml


def test_both_languages_are_present():
    xml = to_xform(FIXTURE.read_bytes())
    assert 'lang="hi (Hindi)"' in xml and 'lang="en (English)"' in xml


def test_fixture_has_cascade_constraint_geo_image_and_nested_repeat():
    xml = to_xform(FIXTURE.read_bytes())
    assert "<itemset" in xml
    assert "उम्र छह से उनसठ महीने के बीच होनी चाहिए" in xml
    assert 'type="geopoint"' in xml and 'mediatype="image/*"' in xml


def test_repeat_is_really_nested():
    root = ET.fromstring(to_xform(FIXTURE.read_bytes()))
    ns = "{http://www.w3.org/2002/xforms}"
    outer = next(r for r in root.iter(ns + "repeat") if r.get("nodeset", "").endswith("/children"))
    inner_all = [r for r in outer.iter(ns + "repeat") if r is not outer]
    assert [r.get("nodeset") for r in inner_all] == [outer.get("nodeset") + "/ifa_doses"]
    assert outer.get("{http://openrosa.org/javarosa}count") == " /data/household_children "


def test_calculate_feeds_relevant_and_select_multiple_is_used():
    root = ET.fromstring(to_xform(FIXTURE.read_bytes()))
    ns = "{http://www.w3.org/2002/xforms}"
    binds = {b.get("nodeset").rsplit("/", 1)[1]: b for b in root.iter(ns + "bind")}
    assert "child_age_years" in binds["tablet_taken"].get("relevant")
    assert "selected(" in binds["referral_note"].get("relevant")
    assert any(e.get("ref", "").endswith("/symptoms") for e in root.iter(ns + "select"))


def test_a_broken_xlsform_raises_with_a_readable_message():
    with pytest.raises(XLSFormError) as e:
        to_xform(BROKEN.read_bytes())
    assert any("choices" in m for m in e.value.messages)


def test_a_non_xlsx_payload_raises_rather_than_crashing():
    with pytest.raises(XLSFormError) as e:
        to_xform(b"this is not a spreadsheet")
    assert e.value.messages


def test_empty_payload_raises():
    with pytest.raises(XLSFormError):
        to_xform(b"")


def test_no_temp_files_left_on_success_or_error(tmp_path, monkeypatch):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    to_xform(FIXTURE.read_bytes())
    with pytest.raises(XLSFormError):
        to_xform(BROKEN.read_bytes())
    with pytest.raises(XLSFormError):
        to_xform(b"junk")
    assert list(tmp_path.iterdir()) == []


def test_unsupported_expression_fixture_still_converts():
    assert "<h:html" in to_xform((FIX / "amb_unsupported_expr.xlsx").read_bytes())


def _cells(path):
    wb = openpyxl.load_workbook(path)
    return {ws.title: [list(r) for r in ws.iter_rows(values_only=True)] for ws in wb}


def test_committed_fixtures_match_the_generator(tmp_path):
    import importlib.util

    spec = importlib.util.spec_from_file_location("make_fixtures", FIX / "make_fixtures.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.build_all(tmp_path)
    for name in ("amb_asha_visit", "broken_missing_choices", "amb_unsupported_expr"):
        assert _cells(tmp_path / f"{name}.xlsx") == _cells(FIX / f"{name}.xlsx"), (
            f"{name}.xlsx is stale: re-run make_fixtures.py"
        )
