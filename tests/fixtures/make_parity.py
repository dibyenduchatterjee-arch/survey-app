"""Writes parity_cases.json: what the SERVER does with a set of submissions.

webapp/tests/formengine.test.js loads each case into the JavaScript FormEngine and checks
that its failures and its settled values equal these. Run from the repo root:

    .venv/Scripts/python.exe webapp/tests/fixtures/make_parity.py

The JSON is committed so the JS tests need no Python at run time. Regenerate it, and the
JS tests will tell you where the phone and the server have drifted apart.
"""
from __future__ import annotations

import copy
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "server"))

from app.forms.validate import _Run, validate_submission  # noqa: E402

HERE = Path(__file__).parent
AMB = json.loads((HERE / "amb_asha_visit.spec.json").read_text(encoding="utf-8"))
NOW = "2026-10-31T09:00:00+05:30"
BAD = "${x} | 1"  # outside the subset: evaluating it raises UnsupportedExpression


def q(type_, name, **kw):
    return {"type": type_, "name": name, **kw}


SYNTH = {
    "form_id": "synth", "version": "1", "title": {"default": "synth"},
    "languages": ["default"], "default_language": "default", "choices": {},
    "nodes": [
        q("calculate", "a", calculate="${b} + 1"),            # declared before its input b
        q("calculate", "b", calculate="${x} * 2"),
        q("integer", "x", label={"default": "x"}),
        q("select_one", "show_r", label={"default": "show"}, choices_ref="yn"),
        q("group", "g", relevant="${x} > 5", children=[
            q("calculate", "gc", calculate="${x} + 100"),
            q("integer", "gq", label={"default": "gq"}, required=True),
        ]),
        q("calculate", "gate", calculate="if(${x} > 5, 'open', 'shut')"),  # declared late
        q("group", "h", relevant="${gate} = 'open'", children=[
            q("calculate", "hc", calculate="1"),
            q("integer", "hq", label={"default": "hq"}, required=True),
        ]),
        q("repeat", "r", relevant="${show_r} = 'yes'", children=[
            q("integer", "rv", label={"default": "rv"}, constraint=". < 10",
              constraint_message={"default": "rv under ten"}),
            q("calculate", "rc", calculate="${rv} * 2"),
            q("calculate", "rn", calculate="position()"),
            q("repeat", "rr", children=[
                q("integer", "rrv", label={"default": "rrv"}, required=True),
                q("calculate", "rrc", calculate="${rrv} + ${rv}"),
            ]),
        ]),
        q("calculate", "rsum", calculate="sum(${rv})"),
        q("calculate", "rcount", calculate="count(${rv})"),
        q("integer", "e1", label={"default": "e1"}, relevant=BAD, required=True),
        q("integer", "e2", label={"default": "e2"}, constraint=BAD),
        q("calculate", "e3", calculate=BAD),
        q("select_multiple", "sm", label={"default": "sm"}, choices_ref="yn"),
        q("text", "sm_note", label={"default": "n"}, relevant="selected(${sm}, 'no')", required=True),
    ],
}

# Regression case for a server bug fixed in Task 18: a repeat that turns hidden only AFTER
# a late-declared calculate settles must have the calculates in its rows unset. calc_pass
# used to hand clear_calculates the repeat's children with the PARENT's level, so only
# hidden groups were cleared. Expected now: the row is {"v": 3} with no "rc".
QUIRK = {
    "form_id": "quirk", "version": "1", "title": {"default": "quirk"},
    "languages": ["default"], "default_language": "default", "choices": {},
    "nodes": [
        q("integer", "x", label={"default": "x"}),
        q("repeat", "R", relevant="${gate} != 'open'", children=[
            q("integer", "v", label={"default": "v"}),
            q("calculate", "rc", calculate="${v} * 2"),
        ]),
        q("calculate", "gate", calculate="if(${x} > 5, 'open', 'shut')"),
    ],
}

CASES = [
    # ---- the real ASHA visit form
    ("amb valid visit", "amb", {
        "district": "patna", "block": "danapur", "asha_name": "Sunita", "household_children": 2,
    }, {"children": [
        {"child_name": "A", "child_age_months": 30, "ifa_form": "syrup", "syrup_given": "yes",
         "symptoms": "pallor", "referral_note": "pale",
         "ifa_doses": [{"dose_date": "2026-10-01", "dose_ml": 1}, {"dose_date": "2026-10-08"}]},
        {"child_name": "B", "child_age_months": 40, "ifa_form": "pink", "tablet_taken": "yes"},
    ]}),
    ("amb every kind of failure", "amb", {"household_children": 11}, {"children": [
        {"child_age_months": 70, "ifa_form": "syrup", "syrup_given": "yes", "symptoms": "pallor",
         "ifa_doses": [{"dose_date": "2026-12-25"}, {"dose_ml": 2}]},
        {"child_name": "B", "child_age_months": 5, "ifa_form": "pink"},
        {"child_name": "C", "ifa_form": "syrup"},
    ]}),
    ("amb hidden raw answers are kept", "amb", {
        "district": "gaya", "block": "bodh_gaya", "asha_name": "x", "household_children": 1,
    }, {"children": [
        {"child_name": "A", "child_age_months": 50, "ifa_form": "pink", "syrup_given": "yes",
         "symptoms": "fever", "referral_note": "stale",
         "ifa_doses": [{"dose_date": "2026-10-01"}, {}]},
    ]}),
    ("amb client calculates are discarded", "amb", {
        "district": "patna", "block": "danapur", "asha_name": "x", "household_children": 1,
        "children_count": 99,
    }, {"children": [{"child_name": "A", "child_age_months": 30, "child_age_years": 9,
                      "ifa_form": "pink", "tablet_taken": "no"}]}),
    ("amb select_multiple as a list", "amb", {
        "district": "patna", "block": "danapur", "asha_name": "x", "household_children": 1,
    }, {"children": [{"child_name": "A", "child_age_months": 20, "symptoms": ["pallor", "fatigue"],
                      "referral_note": "r"}]}),
    ("amb nothing answered", "amb", {}, {}),
    # ---- a form built to exercise every rule
    ("synth open and visible", "synth", {"x": 8, "show_r": "yes", "sm": ["no", "yes"]},
     {"r": [{"rv": 3, "rr": [{"rrv": 1}, {}]}, {"rv": 12, "rr": [{"rrv": 5}]}]}),
    ("synth hidden hides calculates", "synth", {"x": 2, "show_r": "no", "gq": 7, "hq": 8, "sm": "yes"},
     {"r": [{"rv": 3, "rc": 99, "rr": [{"rrv": 1}]}, {"rv": 4}]}),
    ("synth empty", "synth", {}, {}),
    ("hidden repeat clears a calculate computed before it hid", "quirk", {"x": 8}, {"R": [{"v": 3}]}),
    ("synth stale client calculates", "synth", {"x": 3, "a": 1000, "gc": 5, "gate": "open"}, {}),
]


def _plain(v):
    """JSON-safe: NaN (a calculate that came out as not-a-number) becomes the string "NaN"."""
    if isinstance(v, float) and v != v:
        return "NaN"
    if isinstance(v, dict):
        return {k: _plain(i) for k, i in v.items()}
    if isinstance(v, list):
        return [_plain(i) for i in v]
    return v if isinstance(v, int | float | str | bool | type(None)) else str(v)


def run_case(name, spec_name, data, repeats):
    spec = {"amb": AMB, "synth": SYNTH, "quirk": QUIRK}[spec_name]
    now = datetime.fromisoformat(NOW)
    failures = validate_submission(spec, copy.deepcopy(data), copy.deepcopy(repeats), now)
    run = _Run(spec, copy.deepcopy(data), copy.deepcopy(repeats), now)
    run.settle()
    settled = _plain({"data": run.top.own, "repeats": run.top_rows})
    return {
        "name": name, "spec": spec_name, "now": NOW, "data": data, "repeats": repeats,
        "failures": [{"question": f.question, "rule": f.rule, "message": f.message} for f in failures],
        "settled": settled,
    }


out = {"synth": SYNTH, "quirk": QUIRK, "cases": [run_case(*c) for c in CASES]}
(HERE / "parity_cases.json").write_text(
    json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(len(CASES), "cases written")
