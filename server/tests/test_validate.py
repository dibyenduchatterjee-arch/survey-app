import copy
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.forms.compile import compile_spec
from app.forms.validate import Failure, validate_submission
from app.forms.xlsform import to_xform

FIX = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 31, 6, 0, tzinfo=UTC)

HI_AGE = "उम्र छह से उनसठ महीने के बीच होनी चाहिए"
HI_COUNT = "कृपया शून्य से दस के बीच की संख्या डालें"


@pytest.fixture(scope="module")
def spec():
    return compile_spec(to_xform((FIX / "amb_asha_visit.xlsx").read_bytes()))


GOOD = {"district": "patna", "block": "danapur", "asha_name": "Sunita", "household_children": 2}


def row(**kw):
    base = {"child_name": "Ravi", "child_age_months": 48, "ifa_form": "tablet"}
    base.update(kw)
    return base


def find(nodes, name):
    for n in nodes:
        if n["name"] == name:
            return n
        hit = find(n.get("children", []), name)
        if hit:
            return hit
    return None


def pairs(fails):
    return [(f.question, f.rule) for f in fails]


def test_a_valid_submission_has_no_failures(spec):
    assert validate_submission(spec, GOOD, {"children": [row(), row(child_age_months=12)]}, NOW) == []


def test_a_missing_required_answer_is_reported_and_every_one_is_collected(spec):
    fails = validate_submission(spec, {}, {}, NOW)
    assert all(f.rule == "required" and isinstance(f, Failure) for f in fails)
    assert [f.question for f in fails] == ["district", "block", "asha_name", "household_children"]
    assert all(f.message is None for f in fails)


def test_blank_and_whitespace_count_as_unanswered(spec):
    data = {**GOOD, "district": "", "block": "   ", "asha_name": None}
    assert [f.question for f in validate_submission(spec, data, {}, NOW)] == [
        "district", "block", "asha_name"]


def test_a_failed_constraint_returns_its_hindi_message(spec):
    f = validate_submission(spec, {**GOOD, "household_children": 11}, {}, NOW)
    assert pairs(f) == [("household_children", "constraint")]
    assert f[0].message == HI_COUNT


def test_message_follows_the_form_default_language(spec):
    en = {**spec, "default_language": "en"}
    f = validate_submission(en, {**GOOD, "household_children": 11}, {}, NOW)
    assert f[0].message == "Enter a number from 0 to 10"


def test_an_unanswered_question_is_not_constraint_checked(spec):
    # household_children is required, so only "required" is reported, not a constraint too
    data = {k: v for k, v in GOOD.items() if k != "household_children"}
    assert pairs(validate_submission(spec, data, {}, NOW)) == [("household_children", "required")]


def test_a_required_question_hidden_by_relevant_is_not_required(spec):
    # syrup_given is required, but only relevant when ifa_form is syrup
    assert validate_submission(spec, GOOD, {"children": [row(ifa_form="tablet")]}, NOW) == []
    f = validate_submission(spec, GOOD, {"children": [row(ifa_form="syrup")]}, NOW)
    assert pairs(f) == [("children[1]/syrup_given", "required")]


def test_a_calculate_feeds_relevant(spec):
    # make tablet_taken required: it shows only when child_age_years (calculated) >= 3
    s = copy.deepcopy(spec)
    find(s["nodes"], "tablet_taken")["required"] = True
    young = validate_submission(s, GOOD, {"children": [row(child_age_months=24)]}, NOW)
    assert ("children[1]/tablet_taken", "required") not in pairs(young)
    older = validate_submission(s, GOOD, {"children": [row(child_age_months=48)]}, NOW)
    assert pairs(older) == [("children[1]/tablet_taken", "required")]


def test_a_client_supplied_calculate_value_is_not_trusted(spec):
    s = copy.deepcopy(spec)
    find(s["nodes"], "tablet_taken")["required"] = True
    lying = row(child_age_months=24, child_age_years=9)  # real age in years is 2
    assert validate_submission(s, GOOD, {"children": [lying]}, NOW) == []


def test_a_selected_relevant_is_evaluated(spec):
    s = copy.deepcopy(spec)
    find(s["nodes"], "referral_note")["required"] = True
    shown = validate_submission(s, GOOD, {"children": [row(symptoms="pallor fatigue")]}, NOW)
    assert pairs(shown) == [("children[1]/referral_note", "required")]
    assert validate_submission(s, GOOD, {"children": [row(symptoms="fatigue")]}, NOW) == []


def test_each_repeat_row_is_validated_with_its_own_position(spec):
    fails = validate_submission(spec, GOOD, {"children": [row(), row(child_age_months=72)]}, NOW)
    assert pairs(fails) == [("children[2]/child_age_months", "constraint")]
    assert fails[0].message == HI_AGE


def test_every_bad_row_is_reported_not_just_the_first(spec):
    rows = [row(child_age_months=72), row(), row(child_name="", child_age_months=2)]
    assert pairs(validate_submission(spec, GOOD, {"children": rows}, NOW)) == [
        ("children[1]/child_age_months", "constraint"),
        ("children[3]/child_name", "required"),
        ("children[3]/child_age_months", "constraint"),
    ]


def test_nested_repeat_rows_carry_both_indices(spec):
    good_dose = {"dose_date": "2026-10-30", "dose_ml": 5}
    bad_dose = {"dose_ml": 5}
    kids = [
        row(ifa_form="syrup", syrup_given="yes", ifa_doses=[good_dose, bad_dose]),
        row(ifa_form="syrup", syrup_given="yes", ifa_doses=[bad_dose]),
    ]
    assert pairs(validate_submission(spec, GOOD, {"children": kids}, NOW)) == [
        ("children[1]/ifa_doses[2]/dose_date", "required"),
        ("children[2]/ifa_doses[1]/dose_date", "required"),
    ]


def test_a_repeat_hidden_by_relevant_is_skipped_with_all_its_rows(spec):
    kid = row(ifa_form="syrup", syrup_given="no", ifa_doses=[{"dose_ml": 5}])
    assert validate_submission(spec, GOOD, {"children": [kid]}, NOW) == []


def test_validation_uses_the_passed_clock(spec):
    kid = row(ifa_form="syrup", syrup_given="yes", ifa_doses=[{"dose_date": "2026-01-05"}])
    before = datetime(2026, 1, 1, tzinfo=UTC)
    fails = validate_submission(spec, GOOD, {"children": [kid]}, before)
    assert pairs(fails) == [("children[1]/ifa_doses[1]/dose_date", "constraint")]
    assert validate_submission(spec, GOOD, {"children": [kid]}, datetime(2026, 2, 1, tzinfo=UTC)) == []


def test_a_naive_clock_is_refused(spec):
    with pytest.raises(ValueError, match="timezone-aware"):
        validate_submission(spec, {}, {}, datetime(2026, 1, 1))


def test_a_constraint_on_an_omitted_field_fails_cleanly(spec):
    s = copy.deepcopy(spec)
    find(s["nodes"], "household_children")["constraint"] = "${never_sent} = 'x'"
    assert pairs(validate_submission(s, GOOD, {}, NOW)) == [("household_children", "constraint")]


def test_an_expression_that_errors_is_a_constraint_failure_not_a_crash(spec):
    s = copy.deepcopy(spec)
    find(s["nodes"], "household_children")["constraint"] = "bogus(.)"
    f = validate_submission(s, GOOD, {}, NOW)
    assert pairs(f) == [("household_children", "constraint")]
    assert f[0].message == HI_COUNT


def test_a_relevant_that_errors_leaves_the_question_checked(spec):
    s = copy.deepcopy(spec)
    find(s["nodes"], "asha_name")["relevant"] = "bogus()"
    data = {k: v for k, v in GOOD.items() if k != "asha_name"}
    assert pairs(validate_submission(s, data, {}, NOW)) == [("asha_name", "required")]


def test_a_calculate_that_errors_leaves_the_value_empty(spec):
    s = copy.deepcopy(spec)
    find(s["nodes"], "child_age_years")["calculate"] = "bogus()"
    assert validate_submission(s, GOOD, {"children": [row()]}, NOW) == []


def test_malformed_repeat_data_is_tolerated(spec):
    assert validate_submission(spec, GOOD, {"children": "oops"}, NOW) == []
    # a non-dict row is an empty row: its required answers are missing, positions are kept
    assert [f.question for f in validate_submission(spec, GOOD, {"children": ["oops"]}, NOW)] == [
        "children[1]/child_name", "children[1]/child_age_months"]


def test_inputs_are_not_mutated(spec):
    data, reps = dict(GOOD), {"children": [row()]}
    snap = copy.deepcopy((spec, data, reps))
    validate_submission(spec, data, reps, NOW)
    assert (spec, data, reps) == snap
