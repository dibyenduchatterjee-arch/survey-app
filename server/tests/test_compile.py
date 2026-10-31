import json
from pathlib import Path

import pytest

from app.forms.compile import FormCompileError, compile_spec
from app.forms.expr import UnsupportedExpression
from app.forms.xlsform import to_xform

FIX = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def xml():
    return to_xform((FIX / "amb_asha_visit.xlsx").read_bytes())


@pytest.fixture(scope="module")
def spec(xml):
    return compile_spec(xml)


def walk(nodes):
    for n in nodes:
        yield n
        yield from walk(n.get("children", []))


def find(nodes, name):
    return next(n for n in walk(nodes) if n["name"] == name)


def test_spec_carries_form_id_version_and_languages(spec):
    assert spec["form_id"] == "amb_asha_visit"
    assert spec["version"] == "2026103101"
    assert spec["languages"] == ["hi", "en"]
    assert spec["default_language"] == "hi"
    assert spec["title"]["en"] == "Anemia Mukt Bihar - ASHA home visit"


def test_labels_are_keyed_by_short_language_code(spec):
    assert find(spec["nodes"], "district")["label"] == {"hi": "ज़िला", "en": "District"}


def test_question_types_are_mapped(spec):
    types = {n["type"] for n in walk(spec["nodes"])}
    assert types >= {"select_one", "select_multiple", "integer", "geopoint", "image",
                     "repeat", "calculate", "text", "date", "note"}
    assert find(spec["nodes"], "visit_location")["type"] == "geopoint"
    assert find(spec["nodes"], "household_photo")["type"] == "image"
    assert find(spec["nodes"], "symptoms")["type"] == "select_multiple"
    assert find(spec["nodes"], "summary_note")["type"] == "note"


def test_metadata_is_not_a_question(spec):
    names = {n["name"] for n in walk(spec["nodes"])}
    assert not names & {"start", "end", "meta", "instanceID"}


def test_choice_filter_comes_out_in_dollar_form(spec):
    block = find(spec["nodes"], "block")
    assert block["choices_ref"] == "block"
    assert block["choice_filter"] == "district = ${district}"
    assert "choice_filter" not in find(spec["nodes"], "district")


def test_choices_carry_labels_and_filter_properties(spec):
    kanti = next(c for c in spec["choices"]["block"] if c["value"] == "kanti")
    assert kanti["label"] == {"hi": "कांटी", "en": "Kanti"}
    assert kanti["props"] == {"district": "muzaffarpur"}
    assert spec["choices"]["yes_no"][0] == {"value": "yes", "label": {"hi": "हाँ", "en": "Yes"}}


def test_relevant_and_calculate_are_carried_through_in_dollar_form(spec):
    assert find(spec["nodes"], "referral_note")["relevant"] == "selected(${symptoms}, 'pallor')"
    assert find(spec["nodes"], "tablet_taken")["relevant"] == \
        "${ifa_form} != 'syrup' and ${child_age_years} >= 3"
    assert find(spec["nodes"], "child_age_years")["calculate"] == "int(${child_age_months} div 12)"
    assert find(spec["nodes"], "children_count")["calculate"] == "count(${child_name})"
    assert find(spec["nodes"], "ifa_doses")["relevant"] == "${syrup_given} = 'yes'"


def test_constraint_message_keeps_its_languages(spec):
    n = find(spec["nodes"], "child_age_months")
    assert n["constraint"] == ". >= 6 and . <= 59"
    assert n["constraint_message"] == {
        "hi": "उम्र छह से उनसठ महीने के बीच होनी चाहिए",
        "en": "Age must be between 6 and 59 months",
    }
    assert n["hint"]["en"] == "6 to 59 months"
    assert n["required"] is True


def test_a_repeat_inside_a_repeat_compiles_with_both_names(spec):
    outer = find(spec["nodes"], "children")
    inner = find(outer["children"], "ifa_doses")
    assert outer["type"] == inner["type"] == "repeat"
    assert outer["repeat_count"] == "${household_children}"
    assert outer["label"]["hi"] == "बच्चों की सूची"
    assert [c["name"] for c in inner["children"]] == ["dose_date", "dose_ml"]
    # the pyxform wrapper group and the blank template row must not double the nodes
    assert [n["name"] for n in spec["nodes"]].count("children") == 1
    assert [c["name"] for c in outer["children"]].count("ifa_doses") == 1


def test_spec_is_json_with_intact_hindi(spec):
    text = json.dumps(spec, ensure_ascii=False)
    assert "मुज़फ़्फ़रपुर" in text and "???" not in text
    assert json.loads(text) == spec


def test_an_unsupported_expression_fails_compilation_loudly(xml):
    bad = xml.replace(
        ". &gt;= 6 and . &lt;= 59", "instance('ages')/root/item[name=.]/max &gt; 0"
    )
    assert bad != xml
    with pytest.raises(UnsupportedExpression) as e:
        compile_spec(bad)
    assert "child_age_months" in str(e.value)
    assert e.value.question == "child_age_months"


def test_the_unsupported_fixture_names_its_question():
    xml = to_xform((FIX / "amb_unsupported_expr.xlsx").read_bytes())
    with pytest.raises(UnsupportedExpression) as e:
        compile_spec(xml)
    assert "initial" in str(e.value) and "substr" in str(e.value)


def test_an_unsupported_choice_filter_names_its_question(xml):
    bad = xml.replace("[district= /data/district ]", "[substr(district, 1, 1)= 'p']")
    assert bad != xml
    with pytest.raises(UnsupportedExpression) as e:
        compile_spec(bad)
    assert "block" in str(e.value)


def test_computed_required_is_refused_not_dropped(xml):
    old = '<bind nodeset="/data/asha_name" type="string" required="true()"/>'
    new = '<bind nodeset="/data/asha_name" type="string" required=" /data/district  = \'x\'"/>'
    bad = xml.replace(old, new)
    assert bad != xml
    with pytest.raises(FormCompileError, match="asha_name"):
        compile_spec(bad)


def test_unknown_question_type_is_refused(xml):
    old = '<bind nodeset="/data/visit_location" type="geopoint"/>'
    bad = xml.replace(old, '<bind nodeset="/data/visit_location" type="geotrace"/>')
    assert bad != xml
    with pytest.raises(FormCompileError, match="visit_location"):
        compile_spec(bad)


def test_a_name_reused_in_a_nested_repeat_is_refused(xml):
    bad = xml.replace("<dose_ml/>", "<child_name/>")
    assert bad != xml
    with pytest.raises(FormCompileError) as e:
        compile_spec(bad)
    msg = str(e.value)
    assert "child_name" in msg
    assert "/data/children/child_name" in msg and "/data/children/ifa_doses/child_name" in msg


def test_a_name_reused_across_groups_is_refused(xml):
    bad = xml.replace("<asha_name/>", "<district/>", 1)
    assert bad != xml
    with pytest.raises(FormCompileError, match="district"):
        compile_spec(bad)
