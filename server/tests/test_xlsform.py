import tempfile
from pathlib import Path

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
    assert xml.count("<repeat") == 2


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
