"""XForm expression evaluator: tokenizer, recursive-descent parser, tree walker.

Pure logic over a `Context`; no database, no web framework, no ambient clock.
The browser has a second implementation (Task 17) that must give identical answers
for every case in shared/expr_cases.json. If you change a rule here, change the
corpus first and the other implementation second.

THE LOUD-FAILURE RULE
    Anything outside the supported subset raises `UnsupportedExpression` while
    *parsing*, so a form that uses it fails to publish. Nothing parses to a quiet
    "true". Unknown functions, wrong argument counts, XPath paths, predicates,
    axes, unions, bad regexes and over-large expressions are all rejected.

SUPPORTED
    ${field}  .  literals 'text' "text" 12 3.5 .5
    or  and  = != < <= > >=  + - * div mod  unary -  ( )
    true() false() not() selected() count() count-selected() sum() if() string-length() regex()
    concat() number() int() today() now() coalesce() position() indexed-repeat()
    Precedence, lowest to highest: or, and, comparison, + -, * div mod, unary -.
    All binary operators are left-associative. `not` is a function, as in XPath.
    DIFFERS FROM REAL XPATH: = != < <= > >= are ONE level here, left-associative,
    where XPath puts = and != below the relational operators. `3 = 3 > 2` is
    (3 = 3) > 2, which is false here and true in XPath. Unary minus binds tighter
    than * (`-1 + 2` is 1). Pinned by corpus cases.

TYPE RULES (every one of these is pinned by a case in the corpus)
    Values are None, str, bool, int, float, date or datetime. A list value is a
    repeat: one entry per row.
    * Digits and whitespace are ASCII only everywhere: the Devanagari answer "१२" is
      not a number (NaN) and a Devanagari digit in an expression is unsupported.
      Only space, tab, CR and LF separate selected() choices or are trimmed by
      number(); a no-break space is an ordinary character.
    * Unanswered (None, missing, "") reads as the empty string.
    * To string: numbers print without a trailing ".0"; booleans "true"/"false";
      dates in ISO form; NaN "NaN".
    * To number: strict XPath syntax only (optional "-", digits, optional
      fraction); no exponent, plus sign, hex, inf or nan. "" and junk are NaN.
      An ISO date string is its day count since 1970-01-01; an ISO datetime
      string with an offset is fractional days; one without an offset is NaN
      (refused, never guessed). A date is its day count.
    * To boolean: non-empty string, non-zero non-NaN number, any date is true.
      The STRING "0" is therefore true; only the number 0 is false.
    * = and !=: if either side is a boolean, compare as booleans; else if either
      is a number or a date, compare as numbers; else compare as strings, case
      sensitively. NaN equals nothing, so `${x} != 5` is true when x is unanswered.
    * < <= > >=: always numeric. Any NaN makes the answer false.
    * Arithmetic is numeric. NaN propagates. Division or mod by zero is NaN
      (XPath says Infinity; NaN keeps every later comparison false). mod keeps the
      sign of the dividend. Date arithmetic yields plain numbers of days:
      `today() - ${dob}` is an age in days.
    * today() is the calendar date of Context.now in Context.timezone (an IANA
      name, default Asia/Kolkata), so a 05:00 IST visit is dated today. now() is the
      instant, Context.now converted to UTC, whatever the timezone.
    * regex() must match the WHOLE string, uses ASCII classes (\\d is 0-9 only),
      and the pattern must be a string literal using only syntax JavaScript shares:
      no possessive quantifiers, atomic groups, backreferences or \\N{name}.
    * Repeats: `${f}` where f is a list reads row Context.repeat_index (0-based;
      past the end reads as empty). count() and sum() see every row. sum() skips
      empty rows, a non-numeric row makes it NaN. position() is repeat_index + 1.
      indexed-repeat(field, repeat, n) reads row n (1-based) of field; out of range
      is empty; the repeat argument must be a field reference but is not otherwise
      used, because values arrive flat, one list per field.
    * coalesce() returns the first argument that is not empty and not NaN.
      A result that is a whole-number float is returned as an int.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from re import _constants as _sre_constants
from re import _parser as _sre_parser
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_NODES = 200  # keeps the walker far from Python's recursion limit
MAX_DEPTH = 50

_EPOCH = date(1970, 1, 1)
_EPOCH_DT = datetime(1970, 1, 1, tzinfo=UTC)


class UnsupportedExpression(ValueError):
    """The expression is outside the supported subset or is malformed."""

    def __init__(self, expression: str, reason: str):
        super().__init__(f"unsupported expression {expression!r}: {reason}")
        self.expression = expression
        self.reason = reason


@dataclass
class Context:
    values: dict[str, Any]
    current: Any
    now: datetime
    repeat_index: int = 0
    # IANA zone that decides what "today" is. Mirrors Settings.form_timezone; the
    # caller passes the setting in so this module stays free of app imports.
    timezone: str = "Asia/Kolkata"

    def __post_init__(self) -> None:
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown timezone {self.timezone!r}") from exc
        if not isinstance(self.now, datetime) or self.now.utcoffset() is None:
            raise ValueError("Context.now must be a timezone-aware datetime")


# ---------------------------------------------------------------- tree


class Node:
    pass


@dataclass(frozen=True)
class Num(Node):
    value: float


@dataclass(frozen=True)
class Str(Node):
    value: str


@dataclass(frozen=True)
class Ref(Node):
    name: str


@dataclass(frozen=True)
class Prop(Node):
    """A bare name in a choice filter: a column of the choice being filtered."""

    name: str


@dataclass(frozen=True)
class Current(Node):
    pass


@dataclass(frozen=True)
class Unary(Node):
    op: str
    operand: Node


@dataclass(frozen=True)
class Binary(Node):
    op: str
    left: Node
    right: Node


@dataclass(frozen=True)
class Call(Node):
    name: str
    args: tuple[Node, ...]


# name -> (min args, max args or None, positions that must be ${field} references)
_FUNCTIONS: dict[str, tuple[int, int | None, tuple[int, ...]]] = {
    "not": (1, 1, ()),
    "selected": (2, 2, ()),
    "count": (1, 1, (0,)),
    "count-selected": (1, 1, ()),
    "sum": (1, 1, (0,)),
    "if": (3, 3, ()),
    "string-length": (0, 1, ()),
    "regex": (2, 2, ()),
    "concat": (1, None, ()),
    "number": (0, 1, ()),
    "int": (1, 1, ()),
    "true": (0, 0, ()),
    "false": (0, 0, ()),
    "today": (0, 0, ()),
    "now": (0, 0, ()),
    "coalesce": (1, None, ()),
    "position": (0, 0, ()),
    "indexed-repeat": (3, 3, (0, 1)),
}

# ---------------------------------------------------------------- tokenizer

_REF = re.compile(r"\$\{\s*([A-Za-z_][A-Za-z0-9_.\-]*)\s*\}", re.ASCII)
# Every digit and whitespace test is ASCII-only: Python's \d and str.isdigit() accept
# Devanagari and Arabic-Indic digits, JavaScript's do not.
_ASCII_DIGITS = "0123456789"
_ASCII_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"
_SPACE = " \t\r\n"
_NUMBER = re.compile(r"\d+(?:\.\d*)?|\.\d+", re.ASCII)
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.\-]*")
_WORD_OPERATORS = {"and", "or", "div", "mod"}
_REJECTED_CHARS = {
    "/": "XPath paths are not supported; write fields as ${name}",
    "[": "predicates are not supported",
    "]": "predicates are not supported",
    "@": "attributes are not supported",
    "|": "the union operator is not supported",
    "$": "variables are not supported; write fields as ${name}",
    ":": "XPath axes and namespaces are not supported",
}


def _tokenize(expr: str) -> list[tuple[str, Any]]:
    tokens: list[tuple[str, Any]] = []
    i, n = 0, len(expr)
    while i < n:
        ch = expr[i]
        if ch in _SPACE:
            i += 1
        elif ch == "$":
            m = _REF.match(expr, i)
            if not m:
                if expr.startswith("${", i) and "/" in expr[i:].split("}", 1)[0]:
                    raise UnsupportedExpression(expr, "paths inside ${...} are not supported; use the plain field name")
                raise UnsupportedExpression(expr, "malformed ${field} reference")
            tokens.append(("ref", m.group(1)))
            i = m.end()
        elif ch in "'\"":
            end = expr.find(ch, i + 1)
            if end < 0:
                raise UnsupportedExpression(expr, "unterminated string literal")
            tokens.append(("str", expr[i + 1 : end]))
            i = end + 1
        elif ch in _ASCII_DIGITS or (ch == "." and i + 1 < n and expr[i + 1] in _ASCII_DIGITS):
            m = _NUMBER.match(expr, i)
            if not m:
                raise UnsupportedExpression(expr, f"malformed number at position {i}")
            i = m.end()
            if i < n and expr[i] in _ASCII_LETTERS:
                raise UnsupportedExpression(expr, f"malformed number near {expr[m.start():i + 1]!r}")
            tokens.append(("num", float(m.group())))
        elif ch == ".":
            if expr.startswith("..", i):
                raise UnsupportedExpression(expr, "the parent step '..' is not supported")
            tokens.append(("cur", "."))
            i += 1
        elif ch in _ASCII_LETTERS:
            m = _NAME.match(expr, i)
            if not m:
                raise UnsupportedExpression(expr, f"unexpected character {ch!r}")
            if expr.startswith("::", m.end()):
                raise UnsupportedExpression(expr, "XPath axes are not supported")
            tokens.append(("name", m.group()))
            i = m.end()
        elif expr.startswith(("!=", "<=", ">="), i):
            tokens.append(("op", expr[i : i + 2]))
            i += 2
        elif ch in "=<>+-*":
            tokens.append(("op", ch))
            i += 1
        elif ch in "(),":
            tokens.append((ch, ch))
            i += 1
        elif ch in _REJECTED_CHARS:
            raise UnsupportedExpression(expr, _REJECTED_CHARS[ch])
        else:
            raise UnsupportedExpression(expr, f"unexpected character {ch!r}")
    tokens.append(("end", None))
    return tokens


# ---------------------------------------------------------------- parser


class _Parser:
    def __init__(self, expr: str, props: bool = False):
        self.expr = expr
        self.props = props
        self.tokens = _tokenize(expr)
        self.pos = 0
        self.depth = 0
        self.nodes = 0

    def fail(self, reason: str) -> UnsupportedExpression:
        return UnsupportedExpression(self.expr, reason)

    def peek(self) -> tuple[str, Any]:
        return self.tokens[self.pos]

    def take(self) -> tuple[str, Any]:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def at_op(self, *ops: str) -> bool:
        kind, value = self.peek()
        if kind == "op" and value in ops:
            return True
        return kind == "name" and value in ops and value in _WORD_OPERATORS

    def node(self, node: Node) -> Node:
        self.nodes += 1
        if self.nodes > MAX_NODES:
            raise self.fail(f"expression is too large (more than {MAX_NODES} parts)")
        return node

    def enter(self) -> None:
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise self.fail("expression is nested too deeply")

    def parse(self) -> Node:
        if self.peek()[0] == "end":
            raise self.fail("expression is empty")
        tree = self.parse_or()
        kind, value = self.peek()
        if kind != "end":
            raise self.fail(f"unexpected {value!r} after a complete expression")
        return tree

    def _binary(self, operators: tuple[str, ...], lower) -> Node:
        left = lower()
        while self.at_op(*operators):
            op = self.take()[1]
            left = self.node(Binary(op, left, lower()))
        return left

    def parse_or(self) -> Node:
        self.enter()
        try:
            return self._binary(("or",), self.parse_and)
        finally:
            self.depth -= 1

    def parse_and(self) -> Node:
        return self._binary(("and",), self.parse_comparison)

    def parse_comparison(self) -> Node:
        return self._binary(("=", "!=", "<", "<=", ">", ">="), self.parse_additive)

    def parse_additive(self) -> Node:
        return self._binary(("+", "-"), self.parse_multiplicative)

    def parse_multiplicative(self) -> Node:
        return self._binary(("*", "div", "mod"), self.parse_unary)

    def parse_unary(self) -> Node:
        if self.at_op("-"):
            self.take()
            self.enter()
            try:
                return self.node(Unary("-", self.parse_unary()))
            finally:
                self.depth -= 1
        return self.parse_primary()

    def parse_primary(self) -> Node:
        kind, value = self.take()
        if kind == "num":
            return self.node(Num(value))
        if kind == "str":
            return self.node(Str(value))
        if kind == "ref":
            return self.node(Ref(value))
        if kind == "cur":
            return self.node(Current())
        if kind == "(":
            inner = self.parse_or()
            if self.take()[0] != ")":
                raise self.fail("missing closing parenthesis")
            return inner
        if kind == "name":
            if self.peek()[0] != "(":
                if self.props:
                    return self.node(Prop(value))
                raise self.fail(f"bare name {value!r}: fields must be written ${{{value}}}")
            return self.parse_call(value)
        if kind == "end":
            raise self.fail("expression ends unexpectedly")
        raise self.fail(f"unexpected {value!r}")

    def parse_call(self, name: str) -> Node:
        if name not in _FUNCTIONS:
            raise self.fail(f"function {name}() is not supported")
        self.take()  # "("
        args: list[Node] = []
        if self.peek()[0] != ")":
            while True:
                args.append(self.parse_or())
                if self.peek()[0] == ",":
                    self.take()
                    continue
                break
        if self.take()[0] != ")":
            raise self.fail(f"missing closing parenthesis in {name}()")
        low, high, ref_positions = _FUNCTIONS[name]
        if len(args) < low or (high is not None and len(args) > high):
            expected = str(low) if low == high else f"{low} to {high if high is not None else 'any number of'}"
            raise self.fail(f"{name}() takes {expected} argument(s), got {len(args)}")
        for position in ref_positions:
            if not isinstance(args[position], Ref):
                raise self.fail(f"argument {position + 1} of {name}() must be a ${{field}} reference")
        if name == "regex":
            self.check_pattern(args[1])
        return self.node(Call(name, tuple(args)))

    def check_pattern(self, arg: Node) -> None:
        if not isinstance(arg, Str):
            raise self.fail("regex() pattern must be a string literal")
        pattern = arg.value
        for m in re.finditer(r"\(\?(.?)", pattern):
            if m.group(1) not in (":", "=", "!"):
                raise self.fail("regex() pattern uses syntax that browsers and the server do not share")
        if _has_named_escape(pattern):
            raise self.fail("regex() pattern uses a \\N{name} escape, which browsers do not share")
        try:
            re.compile(pattern, re.ASCII)
            tree = _sre_parser.parse(pattern, re.ASCII)
        except re.error as exc:
            raise self.fail(f"regex() pattern is invalid: {exc}") from exc
        except (OverflowError, RecursionError) as exc:
            # a repeat count of 2**32-1 or more, or absurd nesting: refuse, never crash
            raise self.fail("regex() pattern is too large or too deeply nested") from exc
        if _uses_unshared_construct(tree):
            raise self.fail("regex() pattern uses possessive quantifiers, atomic groups or backreferences, which browsers do not share")
        if (why := _backtracking_risk(tree)) is not None:
            raise self.fail(
                f"regex() pattern could backtrack catastrophically ({why}); an answer of a few dozen "
                "characters could hang the server and every phone that opens the form. "
                "Make the repeated part unambiguous, for example [a-z]+ instead of (a+)+"
            )


def _has_named_escape(pattern: str) -> bool:
    """True if the pattern contains a \\N{...} escape (an escaped backslash is skipped)."""
    i = 0
    while i < len(pattern):
        if pattern[i] == "\\":
            if pattern[i + 1 : i + 2] == "N":
                return True
            i += 2
        else:
            i += 1
    return False


_UNSHARED_OPS = {_sre_constants.POSSESSIVE_REPEAT, _sre_constants.ATOMIC_GROUP,
                 _sre_constants.GROUPREF, _sre_constants.GROUPREF_EXISTS}


def _uses_unshared_construct(node: Any) -> bool:
    """Walk an sre parse tree for possessive repeats, atomic groups and backreferences."""
    if isinstance(node, tuple) and len(node) == 2 and node[0] in _UNSHARED_OPS:
        return True
    if isinstance(node, tuple | list | _sre_parser.SubPattern):
        return any(_uses_unshared_construct(child) for child in node)
    return False


# ---- catastrophic backtracking -------------------------------------------------------------
#
# A pattern such as (a+)+$ lets the engine split the same text in exponentially many ways
# before it gives up. Python's `re` and every browser engine backtrack, so one such pattern in
# a form freezes the server and each phone that opens it. It is refused at publish, where
# failure is loud and the author can fix it. Only repeats that can run long (more than
# _LONG_REPEAT times) are examined, so a dotted number such as (\d+\.){3}\d+ and [0-9]{10}
# stay legal. Inside a long repeat these are refused:
#   * a body that can match nothing                              (a*)*   (a?){30}
#   * a part whose length can vary, followed by something that can start with the same
#     character - including the next time round the repeat       (a+)+   (a|aa)+   (x+x+)+
#   * alternatives that can start with the same character, or that we cannot tell apart
#                                                                 (.|ab)+
# Stricter than strictly necessary on purpose: a pattern is cheap to rewrite.

_LONG_REPEAT = 10
_REPEATS = (_sre_constants.MAX_REPEAT, _sre_constants.MIN_REPEAT)
_ASCII_CATEGORIES = {
    _sre_constants.CATEGORY_DIGIT: frozenset(map(ord, "0123456789")),
    _sre_constants.CATEGORY_SPACE: frozenset({9, 10, 11, 12, 13, 32}),  # ASCII whitespace
    _sre_constants.CATEGORY_WORD: frozenset(
        map(ord, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")
    ),
}
_Chars = frozenset[int] | None  # code points; None = cannot say, assume anything


def _union(*parts: _Chars) -> _Chars:
    return None if any(p is None for p in parts) else frozenset().union(*parts)


def _overlap(a: _Chars, b: _Chars) -> bool:
    return a is None or b is None or bool(a & b)


def _flatten(items: Any) -> list:
    """A sequence with every group opened in place (a group alone is only sequencing)."""
    out: list = []
    for op, av in items:
        if op == _sre_constants.SUBPATTERN:
            out.extend(_flatten(av[3]))
        else:
            out.append((op, av))
    return out


def _first_info(items: Any) -> tuple[_Chars, bool]:
    """(code points a match of `items` can begin with, whether it can match nothing)."""
    out: _Chars = frozenset()
    for op, av in items:
        if op == _sre_constants.LITERAL:
            return _union(out, frozenset({av})), False
        if op == _sre_constants.IN:
            chars: set[int] = set()
            for iop, iav in av:
                if iop == _sre_constants.LITERAL:
                    chars.add(iav)
                elif iop == _sre_constants.RANGE and iav[1] - iav[0] <= 256:
                    chars.update(range(iav[0], iav[1] + 1))
                elif iop == _sre_constants.CATEGORY and iav in _ASCII_CATEGORIES:
                    chars |= _ASCII_CATEGORIES[iav]
                else:
                    return None, False  # negated, huge or non-ASCII class: assume it overlaps
            return _union(out, frozenset(chars)), False
        if op == _sre_constants.AT:
            continue  # an anchor consumes nothing; the next item decides
        if op == _sre_constants.SUBPATTERN:
            got, empty = _first_info(av[3])
        elif op == _sre_constants.BRANCH:
            infos = [_first_info(alt) for alt in av[1]]
            got, empty = _union(*(i[0] for i in infos)), any(i[1] for i in infos)
        elif op in _REPEATS:
            got, empty = _first_info(av[2])
            empty = empty or av[0] == 0
        else:
            return None, False  # ANY, NOT_LITERAL, lookarounds ...
        out = _union(out, got)
        if not empty:
            return out, False
    return out, True


def _backtracking_risk(tree: Any) -> str | None:
    """Why this parsed pattern may backtrack catastrophically, or None if it looks safe."""
    for op, av in tree:
        if op in _REPEATS:
            low, high, body = av
            if high > _LONG_REPEAT:
                if body.getwidth()[0] == 0:
                    return "a repeated group can match nothing"
                if _ambiguous(_flatten(body), _first_info(body)[0]):
                    return "the same text can be split between repeats in more than one way"
            why = _backtracking_risk(body)
        elif op == _sre_constants.SUBPATTERN:
            why = _backtracking_risk(av[3])
        elif op == _sre_constants.BRANCH:
            why = next((w for alt in av[1] if (w := _backtracking_risk(alt))), None)
        elif op in (_sre_constants.ASSERT, _sre_constants.ASSERT_NOT):
            why = _backtracking_risk(av[1])
        else:
            why = None
        if why is not None:
            return why
    return None


def _ambiguous(items: list, after: _Chars) -> bool:
    """Inside a long repeat: can a variable-length part be cut in more than one place?

    `after` is what can follow this sequence (the next time round the repeat, and so on).
    """
    for i, (op, av) in enumerate(items):
        rest, rest_empty = _first_info(items[i + 1 :])
        follow = _union(rest, after) if rest_empty else rest
        if op in _REPEATS:
            low, high, body = av
            chars = _first_info(body)[0]
            if low != high and _overlap(chars, follow):
                return True
            again = _union(chars, follow) if high > 1 else follow
            if _ambiguous(_flatten(body), again):
                return True
        elif op == _sre_constants.BRANCH:
            infos = [_first_info(alt) for alt in av[1]]
            seen: _Chars = frozenset()
            for got, _empty in infos:
                if _overlap(seen, got):
                    return True
                seen = _union(seen, got)
            if any(empty for _got, empty in infos) and _overlap(seen, follow):
                return True  # an optional part followed by what it can itself start with
            if any(_ambiguous(_flatten(alt), follow) for alt in av[1]):
                return True
    return False


@lru_cache(maxsize=2048)
def _parse(expression: str) -> Node:
    return _Parser(expression).parse()


@lru_cache(maxsize=2048)
def _parse_choice_filter(expression: str) -> Node:
    return _Parser(expression, props=True).parse()


def parse_choice_filter(expression: str) -> Node:
    """Parse a choice_filter. Two namespaces: a bare name (`district`) is a column of
    the choice being filtered (a `Prop`), and `${name}` is a form field (a `Ref`).
    Everything else is exactly as in `parse()`."""
    if not isinstance(expression, str):
        raise UnsupportedExpression(str(expression), "expression must be text")
    return _parse_choice_filter(expression)


def parse(expression: str) -> Node:
    """Parse an expression, raising UnsupportedExpression for anything outside the subset."""
    if not isinstance(expression, str):
        raise UnsupportedExpression(str(expression), "expression must be text")
    return _parse(expression)


# ---------------------------------------------------------------- coercion

_NUMERIC = re.compile(r"-?(?:\d+(?:\.\d*)?|\.\d+)", re.ASCII)
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)
_ISO_DATETIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?", re.ASCII)
NAN = float("nan")


def _is_number(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def _days(d: date) -> float:
    return float((d - _EPOCH).days)


def _datetime_days(dt: datetime) -> float:
    if dt.utcoffset() is None:
        return NAN
    return (dt - _EPOCH_DT) / timedelta(days=1)


def to_number(v: Any) -> float:
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, int | float):
        return float(v)
    if v is None:
        return NAN
    if isinstance(v, str):
        s = v.strip(_SPACE)
        if _NUMERIC.fullmatch(s):
            return float(s)
        if _ISO_DATE.fullmatch(s):
            try:
                return _days(date.fromisoformat(s))
            except ValueError:
                return NAN
        if _ISO_DATETIME.fullmatch(s):
            if s[11:13] == "24":  # Python 3.14 reads T24:00 as the next midnight; browsers do not
                return NAN
            try:
                return _datetime_days(datetime.fromisoformat(s))
            except ValueError:
                return NAN
        return NAN
    if isinstance(v, datetime):
        return _datetime_days(v)
    if isinstance(v, date):
        return _days(v)
    raise TypeError(f"cannot use a {type(v).__name__} as a form value")


def to_string(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return v
    if isinstance(v, int | float):
        f = float(v)
        if math.isnan(f):
            return "NaN"
        if math.isinf(f):
            return "Infinity" if f > 0 else "-Infinity"
        if f == int(f) and abs(f) < 1e16:
            return str(int(f))
        return repr(f)
    if isinstance(v, datetime | date):
        return v.isoformat()
    raise TypeError(f"cannot use a {type(v).__name__} as a form value")


def to_boolean(v: Any) -> bool:
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, int | float):
        return not (math.isnan(v) or v == 0)
    if isinstance(v, str):
        return len(v) > 0
    return True


def _is_empty(v: Any) -> bool:
    return v is None or v == "" or (isinstance(v, float) and math.isnan(v))


def _is_temporal(v: Any) -> bool:
    return isinstance(v, date)  # datetime is a subclass of date


def _compare(op: str, left: Any, right: Any) -> bool:
    if op in ("=", "!="):
        if isinstance(left, bool) or isinstance(right, bool):
            equal = to_boolean(left) == to_boolean(right)
        elif _is_number(left) or _is_number(right) or _is_temporal(left) or _is_temporal(right):
            equal = to_number(left) == to_number(right)
        else:
            equal = to_string(left) == to_string(right)
        return equal if op == "=" else not equal
    a, b = to_number(left), to_number(right)
    if math.isnan(a) or math.isnan(b):
        return False
    return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


def _arithmetic(op: str, left: Any, right: Any) -> float:
    a, b = to_number(left), to_number(right)
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if b == 0 or math.isnan(a) or math.isnan(b):
        return NAN
    if op == "mod" and math.isinf(a):
        return NAN  # math.fmod(inf, x) raises; the answer is undefined, like division by zero
    return a / b if op == "div" else math.fmod(a, b)


# ---------------------------------------------------------------- walker


def _raw(ctx: Context, name: str) -> Any:
    return ctx.values.get(name)


def _scalar(ctx: Context, name: str) -> Any:
    """A field as a single value: a repeated field reads the current row."""
    raw = _raw(ctx, name)
    if isinstance(raw, list):
        raw = raw[ctx.repeat_index] if 0 <= ctx.repeat_index < len(raw) else None
    return "" if raw is None else raw


def _nodeset(ctx: Context, name: str) -> list[Any]:
    raw = _raw(ctx, name)
    if isinstance(raw, list):
        return raw
    return [] if _is_empty(raw) else [raw]


def _tokens(text: str) -> list[str]:
    """Split a select_multiple answer on ASCII whitespace only (a no-break space is not a separator)."""
    return [t for t in re.split(r"[ \t\r\n]+", text) if t]


def _plain_sum(numbers: list[float]) -> float:
    """Left-to-right addition, exactly what a JavaScript loop does (no compensated summation)."""
    total = 0.0
    for x in numbers:
        total += x
    return total


def _run(node: Node, ctx: Context) -> Any:
    if isinstance(node, Num):
        return node.value
    if isinstance(node, Str):
        return node.value
    if isinstance(node, Ref):
        return _scalar(ctx, node.name)
    if isinstance(node, Current):
        return "" if ctx.current is None else ctx.current
    if isinstance(node, Unary):
        return -to_number(_run(node.operand, ctx))
    if isinstance(node, Binary):
        op = node.op
        if op == "or":
            return to_boolean(_run(node.left, ctx)) or to_boolean(_run(node.right, ctx))
        if op == "and":
            return to_boolean(_run(node.left, ctx)) and to_boolean(_run(node.right, ctx))
        left, right = _run(node.left, ctx), _run(node.right, ctx)
        if op in ("=", "!=", "<", "<=", ">", ">="):
            return _compare(op, left, right)
        return _arithmetic(op, left, right)
    if isinstance(node, Call):
        return _call(node, ctx)
    raise TypeError(f"unknown node {node!r}")  # unreachable: parse() only builds the nodes above


def _call(node: Call, ctx: Context) -> Any:
    name, args = node.name, node.args

    def arg(i: int) -> Any:
        return _run(args[i], ctx)

    if name == "if":
        return arg(1) if to_boolean(arg(0)) else arg(2)
    if name == "not":
        return not to_boolean(arg(0))
    if name == "selected":
        return to_string(arg(1)) in _tokens(to_string(arg(0)))
    if name == "count-selected":
        return float(len(_tokens(to_string(arg(0)))))
    if name == "count":
        return float(len(_nodeset(ctx, args[0].name)))  # type: ignore[attr-defined]
    if name == "sum":
        rows = [r for r in _nodeset(ctx, args[0].name) if not _is_empty(r)]  # type: ignore[attr-defined]
        numbers = [to_number(r) for r in rows]
        return NAN if any(math.isnan(x) for x in numbers) else _plain_sum(numbers)
    if name == "string-length":
        text = to_string(_run(Current(), ctx) if not args else arg(0))
        return float(len(text))
    if name == "regex":
        return re.fullmatch(args[1].value, to_string(arg(0)), re.ASCII) is not None  # type: ignore[attr-defined]
    if name == "concat":
        return "".join(to_string(_run(a, ctx)) for a in args)
    if name == "number":
        return to_number(_run(Current(), ctx) if not args else arg(0))
    if name == "int":
        n = to_number(arg(0))
        return float(math.trunc(n)) if math.isfinite(n) else n
    if name == "today":
        return ctx.now.astimezone(ZoneInfo(ctx.timezone)).date()
    if name == "true":
        return True
    if name == "false":
        return False
    if name == "now":
        return ctx.now.astimezone(UTC)
    if name == "coalesce":
        for a in args:
            v = _run(a, ctx)
            if not _is_empty(v):
                return v
        return ""
    if name == "position":
        return float(ctx.repeat_index + 1)
    if name == "indexed-repeat":
        n = to_number(arg(2))
        if math.isnan(n) or math.isinf(n) or n != math.trunc(n):
            return ""
        rows = _raw(ctx, args[0].name)  # type: ignore[attr-defined]
        if not isinstance(rows, list):
            rows = [] if rows is None else [rows]
        index = int(n) - 1
        if 0 <= index < len(rows) and rows[index] is not None:
            return rows[index]
        return ""
    raise TypeError(f"unknown function {name}")  # unreachable: parse() checks the name


def evaluate(expression: str, context: Context) -> Any:
    """Evaluate `expression`. Raises UnsupportedExpression if it cannot be parsed."""
    result = _run(parse(expression), context)
    if isinstance(result, float) and math.isfinite(result) and result == int(result):
        return int(result)
    return result
