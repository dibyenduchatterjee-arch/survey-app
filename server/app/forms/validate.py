"""Server-side re-validation of a submission against the stored form spec.

Pure logic: takes a compiled spec dict and the submitted answers, returns a list of
`Failure`. No database, no web framework, no ambient clock.

The phone already ran `relevant`, `constraint` and `required`. The server runs them
again because it cannot trust the client (modified app, replayed request, older form
version). The result is NOT a reason to reject: a submission that reached the server is
kept, and a failing one is stored flagged with these failures for a supervisor.

SCOPE LIMIT, deliberately not done in Phase 1
    `validate_submission` does NOT check that a `select_one` / `select_multiple` answer
    lies inside the set narrowed by the question's `choice_filter` (nor, for that
    matter, that it is a listed choice at all). That check is out of Phase 1 scope.
    Do not assume it happens here.

RULES
    * `relevant` is evaluated first. A node that is not relevant is skipped entirely,
      children included, and never reports `required`. A repeat's `relevant` sits on
      the repeat node and hides all its rows.
    * Every failure is collected; nothing stops at the first.
    * A `constraint` is only checked on an answered question (XLSForm semantics);
      an unanswered required question reports `required` alone.
    * `calculate` values sent by the client are discarded and recomputed here.
    * Repeat rows are validated one at a time, each with its own Context
      (`repeat_index` = row position, 0-based, so `position()` is 1-based as in XPath).
      Field names are unique across the whole form (Task 8 refuses duplicates), so
      inner-row-first name resolution is unambiguous.
    * The clock is the `now` parameter, passed to every Context. It must be timezone-aware.

EVALUATION-TIME ERRORS never escape as exceptions (a crash here would be a 500 and a
lost visit; Task 11 stores the submission regardless):
    * `constraint` errors        -> a "constraint" failure (we could not confirm it holds).
    * `relevant` errors          -> treated as relevant, so the question is still checked.
    * `calculate` errors         -> the value is left empty.
    A constraint that merely references an omitted field does not error; omitted fields
    read as empty, so it simply evaluates true or false.

INPUT SHAPE
    data     top-level answers, name -> value.
    repeats  top-level repeat name -> list of row dicts. A nested repeat's rows sit
             inside its parent row under the nested repeat's name.
    Groups are flat in the data and do not appear in question paths.

QUESTION PATHS (what Task 11 stores): "name" at top level, "repeat[n]/name" inside a
repeat, "outer[n]/inner[m]/name" when nested; n and m are 1-based row positions.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.forms.expr import Context, evaluate, to_boolean


@dataclass(frozen=True)
class Failure:
    question: str  # path, e.g. "children[2]/child_age_months"
    rule: str  # "required" | "constraint"
    message: str | None  # constraint_message in the form's default language, if any


def _blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, list | dict):
        return len(value) == 0
    return False


def _rows(source: Any) -> list[dict]:
    """Copy of a repeat's rows; a malformed row becomes an empty one, keeping positions."""
    if not isinstance(source, list):
        return []
    return [dict(r) if isinstance(r, dict) else {} for r in source]


def _gather(nodes: list[dict], rows: list[dict]) -> dict[str, list]:
    """Field name -> one entry per row, the flat-list shape the evaluator expects.

    Fields of a nested repeat are flattened across the nested rows of every row.
    """
    out: dict[str, list] = {}
    for node in nodes:
        kids = node.get("children", [])
        if node["type"] == "repeat":
            nested = [r for row in rows if isinstance(row.get(node["name"]), list)
                      for r in row[node["name"]] if isinstance(r, dict)]
            out.update(_gather(kids, nested))
        elif node["type"] == "group":
            out.update(_gather(kids, rows))
        else:
            out[node["name"]] = [row.get(node["name"]) for row in rows]
    return out


def _scalars(own: dict) -> dict:
    return {k: v for k, v in own.items()
            if not (isinstance(v, list) and v and all(isinstance(i, dict) for i in v))}


class _Level:
    """One scope of answers: the top level, or one row of a repeat."""

    def __init__(self, own: dict, outer: dict, index: int, prefix: str,
                 siblings: list[dict] | None = None, nodes: list[dict] | None = None):
        self.own, self.outer, self.index, self.prefix = own, outer, index, prefix
        self.siblings, self.nodes = siblings, nodes


class _Run:
    def __init__(self, spec: dict, data: dict, repeats: dict, now: datetime):
        Context(values={}, current=None, now=now)  # fail fast on a naive clock
        self.now = now
        self.lang = spec.get("default_language")
        self.failures: list[Failure] = []
        self.top_rows = {k: _rows(v) for k, v in repeats.items()}
        self.top_repeats = self._top_repeats(spec["nodes"])
        self.top = _Level(dict(data), {}, 0, "")

    def _top_repeats(self, nodes: list[dict]) -> list[dict]:
        found = []
        for n in nodes:
            if n["type"] == "repeat":
                found.append(n)
            elif n["type"] == "group":
                found.extend(self._top_repeats(n.get("children", [])))
        return found

    def values(self, level: _Level) -> dict:
        if level.siblings is None:
            vals = dict(level.own)
            for rep in self.top_repeats:
                vals.update(_gather(rep.get("children", []), self.top_rows.get(rep["name"], [])))
            return vals
        return {**level.outer, **_gather(level.nodes or [], level.siblings)}

    def evaluate(self, expr: str, level: _Level, current: Any = None) -> Any:
        ctx = Context(values=self.values(level), current=current, now=self.now,
                      repeat_index=level.index)
        return evaluate(expr, ctx)

    def relevant(self, node: dict, level: _Level) -> bool:
        try:
            return to_boolean(self.evaluate(node["relevant"], level))
        except Exception:  # noqa: BLE001 - deliberate: see module docstring
            return True

    def message(self, node: dict) -> str | None:
        msg = node.get("constraint_message")
        if isinstance(msg, str):
            return msg or None
        if isinstance(msg, dict):
            return msg.get(self.lang) or next((v for v in msg.values() if v), None)
        return None

    def walk(self, nodes: list[dict], level: _Level) -> None:
        for node in nodes:
            name = node["name"]
            if "calculate" in node:
                level.own.pop(name, None)  # never trust a client-supplied calculation
            if node.get("relevant") and not self.relevant(node, level):
                continue
            if node["type"] == "repeat":
                self.repeat(node, level)
            elif node["type"] == "group":
                self.walk(node.get("children", []), level)
            elif "calculate" in node:
                try:
                    result = self.evaluate(node["calculate"], level)
                except Exception:  # noqa: BLE001 - deliberate: see module docstring
                    result = None
                if not _blank(result):
                    level.own[name] = result
            elif node["type"] != "note":
                self.question(node, level)

    def repeat(self, node: dict, level: _Level) -> None:
        name = node["name"]
        if level.siblings is None:
            rows = self.top_rows.setdefault(name, [])
        else:
            rows = _rows(level.own.get(name))
            level.own[name] = rows
        outer = {**self.values(level), **_scalars(level.own)}
        for i, row in enumerate(rows):
            child = _Level(row, outer, i, f"{level.prefix}{name}[{i + 1}]/", rows,
                           node.get("children", []))
            self.walk(node.get("children", []), child)

    def question(self, node: dict, level: _Level) -> None:
        path = level.prefix + node["name"]
        value = level.own.get(node["name"])
        if _blank(value):
            if node.get("required"):
                self.failures.append(Failure(path, "required", None))
            return
        expr = node.get("constraint")
        if not expr:
            return
        try:
            ok = to_boolean(self.evaluate(expr, level, value))
        except Exception:  # noqa: BLE001 - deliberate: see module docstring
            ok = False
        if not ok:
            self.failures.append(Failure(path, "constraint", self.message(node)))


def validate_submission(spec: dict, data: dict, repeats: dict[str, list[dict]],
                        now: datetime) -> list[Failure]:
    """Re-run `relevant`, `constraint` and `required` against `spec`; return every failure.

    Never raises for bad answers or failing expressions (see the module docstring), only
    for a naive `now`. Does not mutate its arguments.

    NOT CHECKED, out of Phase 1 scope: that a select_one / select_multiple answer is
    within the `choice_filter`-narrowed set. A silent gap would be worse than a
    documented one, so: nobody should assume this function enforces it.
    """
    run = _Run(spec, data, repeats, now)
    run.walk(spec["nodes"], run.top)
    return run.failures
