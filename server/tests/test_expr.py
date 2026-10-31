"""The expression evaluator, driven by the corpus shared with the browser implementation.

shared/expr_cases.json is read by this file and (Task 17) by `node --test`. Result
normalisation for comparison with JSON: a date or datetime becomes its ISO string,
NaN becomes the string "NaN". Booleans must match as booleans, not as 0/1.
"""

import json
import math
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from app.forms.expr import Context, UnsupportedExpression, evaluate, parse

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "server" / "app" / "forms"
CASES = json.loads((ROOT / "shared" / "expr_cases.json").read_text(encoding="utf-8"))


def _jsonable(value):
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, float) and math.isnan(value):
        return "NaN"
    return value


def _context(case):
    return Context(
        values=case["values"],
        current=case.get("current"),
        now=datetime.fromisoformat(case["now"]),
        repeat_index=case.get("repeat_index", 0),
    )


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_expression_corpus(case):
    if case.get("unsupported"):
        with pytest.raises(UnsupportedExpression):
            parse(case["expr"])
        # Rejection is at parse time, so evaluating must refuse the same way.
        with pytest.raises(UnsupportedExpression):
            evaluate(case["expr"], Context(values={}, current=None, now=datetime(2026, 1, 1, tzinfo=UTC)))
    else:
        result = _jsonable(evaluate(case["expr"], _context(case)))
        assert result == case["expect"]
        assert isinstance(result, bool) == isinstance(case["expect"], bool)


def test_corpus_is_broad_enough_and_names_are_unique():
    names = [c["name"] for c in CASES]
    assert len(names) == len(set(names))
    assert len(CASES) >= 25
    assert sum(1 for c in CASES if c.get("unsupported")) >= 3


def test_corpus_covers_every_supported_function():
    joined = " ".join(c["expr"] for c in CASES if not c.get("unsupported"))
    for fn in ("selected(", "count(", "count-selected(", "sum(", "if(", "string-length(",
               "regex(", "concat(", "number(", "int(", "today(", "now(", "coalesce(",
               "position(", "indexed-repeat(", "not("):
        assert fn in joined, fn
    for op in (" div ", " mod ", " and ", " or ", " != ", " <= ", " >= ", " + ", " * "):
        assert op in joined, op


def test_today_uses_the_server_supplied_clock_not_the_host_clock():
    ctx = Context(values={}, current=None, now=datetime(2026, 1, 1, tzinfo=UTC))
    assert evaluate("today()", ctx) == date(2026, 1, 1)
    source = (SRC / "expr.py").read_text(encoding="utf-8")
    assert "date.today()" not in source
    for ambient in ("datetime.now(", "utcnow", "time.time(", "import time", "from time"):
        assert ambient not in source, ambient


def test_a_naive_now_is_refused_not_guessed():
    with pytest.raises(ValueError):
        Context(values={}, current=None, now=datetime(2026, 1, 1))


def test_unsupported_expression_carries_expression_and_reason():
    with pytest.raises(UnsupportedExpression) as e:
        parse("instance('x')/root/item[./name = ${a}]/label")
    assert e.value.expression == "instance('x')/root/item[./name = ${a}]/label"
    assert e.value.reason
    assert e.value.expression in str(e.value) and e.value.reason in str(e.value)


def test_unsupported_expression_is_a_value_error_never_a_silent_true():
    with pytest.raises(ValueError):
        evaluate("nonsense(${a})", Context(values={}, current=None, now=datetime(2026, 1, 1, tzinfo=UTC)))


def test_parse_returns_a_reusable_tree():
    tree = parse("${a} + 1")
    assert parse("${a} + 1") == tree


def test_evaluator_does_not_use_eval_or_import_the_app():
    source = (SRC / "expr.py").read_text(encoding="utf-8")
    for banned in ("eval(", "literal_eval", "exec(", "app.db", "app.api", "fastapi"):
        assert banned not in source, banned


def test_naive_datetime_values_are_not_evaluated_as_a_clock():
    ctx = Context(values={"t": datetime(2026, 1, 1)}, current=None, now=datetime(2026, 1, 2, tzinfo=UTC))
    assert evaluate("${t} < now()", ctx) is False
