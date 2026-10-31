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

CALCULATES are recomputed to a fixed point, so declaration order does not matter: all
are re-evaluated pass after pass until no value changes, at most (calculates + 1) passes.
Task 18's JavaScript engine MUST use the same rule so phone and server agree.

HIDDEN NODES AND CROSS-ROW AGGREGATES (Task 18's engine must match this exactly)
    * Neither a hidden question nor a hidden repeat's rows are blanked. Their raw
      answers stay visible to other expressions, and to count()/sum() over a repeated
      field, which see every row of the repeat whether or not the repeat is relevant.
    * A hidden repeat's rows are skipped for calculation and validation, so their
      calculates are left unset (a calculate whose own `relevant` is false is unset too).
      If relevance flips between fixed-point passes, a value computed in an earlier pass
      is cleared in the next pass the calculate is hidden, not kept.
    Deferred: whether aggregates should exclude hidden rows. Not changed, only recorded.

EVALUATION-TIME ERRORS never escape as exceptions (a crash here would be a 500 and a
lost visit; Task 11 stores the submission regardless). They are reported as rule "error",
distinct from "required"/"constraint", so a supervisor can tell a broken form from a wrong
answer; `message` carries the expression and the reason:
    * `constraint` errors  -> an "error" failure (no "constraint" failure as well).
    * `relevant` errors    -> an "error" failure, and the node is treated as relevant:
                              showing a question wrongly is recoverable, hiding one
                              wrongly is not.
    * `calculate` errors   -> an "error" failure; the value is left empty.
    A constraint that merely references an omitted field does not error; omitted fields
    read as empty, so it simply evaluates true or false.
    The one thing raised besides a naive clock: `CalculateCycleError`, when calculates do
    not settle (a dependency cycle). A cyclic form should never have been publishable:
    compile.py refuses it at publish time; this is defence in depth for forms published
    before that guard or specs that arrive another way. (Cycles that settle at NaN do not
    reach here, which is why the compile-time check is the main guard.)

INPUT SHAPE
    data     top-level answers, name -> value.
    repeats  top-level repeat name -> list of row dicts. A nested repeat's rows sit
             inside its parent row under the nested repeat's name.
    Groups are flat in the data and do not appear in question paths.
    A `select_multiple` answer is canonically the XForms space-separated string
    ("pallor fever"). A list of strings is also accepted and joined with spaces at the
    boundary, so both wire formats mean the same thing (Task 11 stores the string form).

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
    rule: str  # "required" | "constraint" (answer wrong) | "error" (our rule is broken)
    message: str | None  # constraint: its message; error: the expression and the reason


class CalculateCycleError(ValueError):
    """The form's calculates do not settle: a dependency cycle. Should be unpublishable."""


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


def _why(kind: str, expr: str, exc: Exception) -> str:
    reason = getattr(exc, "reason", None) or f"{type(exc).__name__}: {exc}"
    return f"{kind} {expr!r} could not be evaluated: {reason}"


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
        self.nodes = spec["nodes"]
        self.lang = spec.get("default_language")
        self.failures: list[Failure] = []
        self.top_rows = {k: _rows(v) for k, v in repeats.items()}
        self.top_repeats = self._top_repeats(self.nodes)
        self.top = _Level(dict(data), {}, 0, "")
        self.evaluated = 0

    def _top_repeats(self, nodes: list[dict]) -> list[dict]:
        found = []
        for n in nodes:
            if n["type"] == "repeat":
                found.append(n)
            elif n["type"] == "group":
                found.extend(self._top_repeats(n.get("children", [])))
        return found

    # ---- preparation: normalise answers, drop client calculations
    def prepare(self, nodes: list[dict], own: dict, top: bool) -> None:
        for n in nodes:
            name = n["name"]
            if "calculate" in n:
                own.pop(name, None)  # never trust a client-supplied calculation
            elif n["type"] == "group":
                self.prepare(n.get("children", []), own, top)
            elif n["type"] == "repeat":
                if top:
                    rows = self.top_rows.setdefault(name, [])
                elif name in own:
                    rows = own[name] = _rows(own[name])
                else:
                    rows = []
                for row in rows:
                    self.prepare(n.get("children", []), row, False)
            elif n["type"] == "select_multiple" and isinstance(own.get(name), list):
                own[name] = " ".join(str(i) for i in own[name])

    # ---- scopes
    def values(self, level: _Level) -> dict:
        if level.siblings is None:
            vals = dict(level.own)
            for rep in self.top_repeats:
                vals.update(_gather(rep.get("children", []), self.top_rows.get(rep["name"], [])))
            return vals
        return {**level.outer, **_gather(level.nodes or [], level.siblings)}

    def children(self, node: dict, level: _Level) -> list[_Level]:
        name = node["name"]
        rows = self.top_rows.get(name, []) if level.siblings is None else level.own.get(name, [])
        outer = {**self.values(level), **_scalars(level.own)}
        return [_Level(row, outer, i, f"{level.prefix}{name}[{i + 1}]/", rows,
                       node.get("children", [])) for i, row in enumerate(rows)]

    def evaluate(self, expr: str, level: _Level, current: Any = None) -> Any:
        ctx = Context(values=self.values(level), current=current, now=self.now,
                      repeat_index=level.index)
        return evaluate(expr, ctx)

    def relevant(self, node: dict, level: _Level, record: bool = True) -> bool:
        try:
            return to_boolean(self.evaluate(node["relevant"], level))
        except Exception as exc:  # noqa: BLE001 - deliberate: see module docstring
            if record:
                self.failures.append(Failure(level.prefix + node["name"], "error",
                                             _why("relevant", node["relevant"], exc)))
            return True

    def message(self, node: dict) -> str | None:
        msg = node.get("constraint_message")
        if isinstance(msg, str):
            return msg or None
        if isinstance(msg, dict):
            return msg.get(self.lang) or next((v for v in msg.values() if v), None)
        return None

    # ---- calculates, to a fixed point
    def calc_pass(self, nodes: list[dict], level: _Level, record: bool) -> bool:
        changed = False
        for node in nodes:
            name = node["name"]
            if "calculate" in node:
                self.evaluated += 1
                new = None
                if not node.get("relevant") or self.relevant(node, level, record):
                    try:
                        new = self.evaluate(node["calculate"], level)
                    except Exception as exc:  # noqa: BLE001 - deliberate: see module docstring
                        if record:
                            self.failures.append(Failure(level.prefix + name, "error",
                                                         _why("calculate", node["calculate"], exc)))
                if _blank(new):
                    new = None
                old = level.own.pop(name, None)
                if new is not None:
                    level.own[name] = new
                changed = changed or repr(old) != repr(new)
            elif node["type"] == "group":
                changed = self.calc_pass(node.get("children", []), level, record) or changed
            elif node["type"] == "repeat":
                if node.get("relevant") and not self.relevant(node, level, record):
                    continue
                for child in self.children(node, level):
                    changed = self.calc_pass(node.get("children", []), child, record) or changed
        return changed

    def settle(self) -> None:
        """Recompute every calculate until nothing changes, so declaration order is irrelevant.

        (calculates evaluated in the first pass) + 1 passes are enough for any acyclic
        form; needing more means a cycle, which raises.
        """
        self.prepare(self.nodes, self.top.own, True)
        self.evaluated = 0
        changed = self.calc_pass(self.nodes, self.top, False)
        budget, passes = self.evaluated + 1, 1
        while changed:
            if passes >= budget:
                raise CalculateCycleError(
                    "calculate values do not settle; the form has a dependency cycle")
            changed = self.calc_pass(self.nodes, self.top, False)
            passes += 1
        self.calc_pass(self.nodes, self.top, True)  # settled: this pass only records errors

    # ---- validation
    def walk(self, nodes: list[dict], level: _Level) -> None:
        for node in nodes:
            if "calculate" in node:
                continue
            if node.get("relevant") and not self.relevant(node, level):
                continue
            if node["type"] == "repeat":
                for child in self.children(node, level):
                    self.walk(node.get("children", []), child)
            elif node["type"] == "group":
                self.walk(node.get("children", []), level)
            elif node["type"] != "note":
                self.question(node, level)

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
        except Exception as exc:  # noqa: BLE001 - deliberate: see module docstring
            self.failures.append(Failure(path, "error", _why("constraint", expr, exc)))
            return
        if not ok:
            self.failures.append(Failure(path, "constraint", self.message(node)))


def validate_submission(spec: dict, data: dict, repeats: dict[str, list[dict]],
                        now: datetime) -> list[Failure]:
    """Re-run `relevant`, `constraint` and `required` against `spec`; return every failure.

    Raises only for a naive `now` or a calculate dependency cycle (`CalculateCycleError`);
    bad answers and failing expressions become failures (rule "error" for the latter).
    Does not mutate its arguments.

    NOT CHECKED, out of Phase 1 scope: that a select_one / select_multiple answer is
    within the `choice_filter`-narrowed set. A silent gap would be worse than a
    documented one, so: nobody should assume this function enforces it.
    """
    run = _Run(spec, data, repeats, now)
    run.settle()
    run.walk(spec["nodes"], run.top)
    return run.failures
