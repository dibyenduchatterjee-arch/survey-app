"""The golden files the JavaScript engine is tested against must be current.

webapp/tests/fixtures/parity_cases.json is what validate.py produced for a set of
submissions, and amb_asha_visit.spec.json is what the compiler produced for the sample
form. The JS suite compares the phone engine with those files. If nobody checked the files
against the server, a change to validation or compilation would leave pytest green and the
JS suite green (against a stale golden) while the two engines drifted apart.

So these tests regenerate both in memory and demand equality. A failure here means: you
changed validation or compilation. Regenerate, review the diff, and run the JS suite:

    .venv/Scripts/python.exe webapp/tests/fixtures/make_parity.py
    (and for the spec) see test_the_committed_form_spec_is_what_the_compiler_produces
"""
import hashlib
import importlib.util
import json
from pathlib import Path

from app.forms.compile import compile_spec
from app.forms.xlsform import to_xform

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "webapp" / "tests" / "fixtures"
REGENERATE = (
    "validate.py or the compiler changed. Regenerate with "
    ".venv/Scripts/python.exe webapp/tests/fixtures/make_parity.py (the spec: recompile "
    "server/tests/fixtures/amb_asha_visit.xlsx into webapp/tests/fixtures/amb_asha_visit.spec.json), "
    "review the diff, and run `node --test webapp/tests/`."
)


def _load_make_parity():
    spec = importlib.util.spec_from_file_location("make_parity", FIXTURES / "make_parity.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_committed_form_spec_is_what_the_compiler_produces():
    xlsx = (Path(__file__).parent / "fixtures" / "amb_asha_visit.xlsx").read_bytes()
    fresh = compile_spec(to_xform(xlsx))
    committed = json.loads((FIXTURES / "amb_asha_visit.spec.json").read_text(encoding="utf-8"))
    assert fresh == committed, REGENERATE


def test_the_committed_parity_cases_are_what_validate_py_produces():
    make_parity = _load_make_parity()
    fresh = json.loads(make_parity.dumps(make_parity.build()))  # in memory, nothing written
    committed = json.loads((FIXTURES / "parity_cases.json").read_text(encoding="utf-8"))
    assert fresh == committed, REGENERATE


def test_the_parity_corpus_is_not_quietly_shrunk():
    cases = json.loads((FIXTURES / "parity_cases.json").read_text(encoding="utf-8"))["cases"]
    assert len(cases) >= 26
    assert len({c["name"] for c in cases}) == len(cases)


# The shared expression corpus is read by pytest and by `node --test`. If cases could be
# deleted from it with both suites staying green, a regression could be removed silently.
# Both suites pin the same count and the same hash of the sorted case names; changing the
# corpus on purpose means updating the two pins together (test_expr.py, expr.test.js).
CORPUS_COUNT = 388
CORPUS_NAMES_SHA256 = "592486aa42c1d06e9454180ac6b29ff04bdbd291553cc1fd6ed8ec6c8551929e"


def test_the_shared_expression_corpus_is_pinned():
    cases = json.loads((ROOT / "shared" / "expr_cases.json").read_text(encoding="utf-8"))
    assert len(cases) == CORPUS_COUNT
    names = "\n".join(sorted(c["name"] for c in cases))
    assert hashlib.sha256(names.encode()).hexdigest() == CORPUS_NAMES_SHA256
