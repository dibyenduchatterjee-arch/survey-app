# Expression corpus format (`expr_cases.json`)

One JSON list, read by `server/tests/test_expr.py` (pytest) and by the JavaScript suite
(`node --test`, Task 17). Adding a case adds it to both. The Python evaluator is
`server/app/forms/expr.py`; its docstring is the full rule book.

## Case shapes

Evaluation case:

| field | required | meaning |
|---|---|---|
| `name` | yes | unique; used as the test id |
| `expr` | yes | the expression text |
| `values` | yes | field name to value. A JSON list is a repeat: one entry per row |
| `current` | yes | the value of `.` (null means unanswered) |
| `now` | yes | ISO datetime WITH an offset, e.g. `2026-03-15T09:30:00+00:00` |
| `expect` | yes | the expected result, see normalisation below |
| `timezone` | no | IANA zone deciding `today()`. Default `Asia/Kolkata` |
| `repeat_index` | no | 0-based row of the current repeat. Default 0 |
| `note` | no | why the case exists; ignored by tests |

Unsupported case: `{"name", "expr", "unsupported": true, "note"?}`. `parse()` must raise
`UnsupportedExpression` (carrying `expression` and `reason`), and so must `evaluate()`.
Rejection happens when parsing, never while evaluating.

## Comparing a result with `expect`

- A date or datetime result is compared as its ISO string. `now()` is always UTC
  (`+00:00`); `today()` is `YYYY-MM-DD`.
- A NaN result is compared as the string `"NaN"`.
- A whole-number result is a plain integer; `-0` is `0`.
- Booleans must match as booleans, not as 1/0 (check the type, not just equality).
- Numbers are compared exactly. `sum()` and `+` are plain left-to-right IEEE addition,
  so `0.1 + 0.2` is `0.30000000000000004` in both languages.

## Rules the corpus cannot express: each side writes its own test

- A `now` without an offset (naive) is refused: `Context` raises `ValueError`.
- An unknown `timezone` is refused the same way.
- The evaluator reads no ambient clock: Python's test greps the source; the JS file
  must not contain `Date.now()` or `new Date()` without an argument.
- A naive datetime VALUE is NaN, not an error (that one is in the corpus).

## Decisions Task 17 inherits (each has cases)

- Unanswered (null, missing, "") is the empty string; as a number NaN; as boolean false.
- `=` / `!=`: either side boolean means compare as booleans; else either side a number or
  date means compare as numbers; else compare as strings, case-sensitively. NaN equals
  nothing, so `${a} != 5` is true when `a` is unanswered. `< <= > >=` are always numeric
  and false when either side is NaN.
- The string `"0"` and `"false"` are true; only number 0, "", unanswered and NaN are false.
- Division or mod by zero is NaN. `mod` keeps the dividend's sign. NaN propagates.
- A date, or an ISO date string, is its day count since 1970-01-01; `today() - ${dob}`
  is days. An ISO datetime string with an offset is fractional days; without one, NaN.
- Digits and whitespace are ASCII only. `"१२"` is NaN, and a Devanagari digit in an
  expression is unsupported. Only space, tab, CR, LF separate `selected()` choices or are
  trimmed by `number()`; a no-break space is an ordinary character.
- Comparison operators are ONE left-associative level (unlike XPath): `3 = 3 > 2` is false.
  Unary minus binds tighter than every binary operator: `-1 + 2` is 1.
- `today()` is the date in `timezone`; `now()` is the instant in UTC.
- `regex()` is a full match, ASCII classes, literal pattern. `string-length` counts code points.
- Repeats: a scalar read of a list uses `repeat_index`; `position()` is `repeat_index + 1`;
  `indexed-repeat` is 1-based and gives "" out of range.

## Choice filters: two namespaces (Task 17 needs the same mode)

A `choice_filter` such as `district = ${district}` is parsed by `parse_choice_filter`, not
`parse`. In that mode a BARE name (`district`) is a column of the choice being filtered,
read from that choice's `props` in the JSON spec (a `Prop` node), and `${name}` is a form
field (a `Ref` node), read from the current answers. The filter is evaluated once per
choice; a choice is shown when the result is true. Everything else (operators, functions,
literals) is as in the main subset. In plain `parse` a bare name is still rejected, so a
bare name can never silently pass as a form field in a `relevant` or `constraint`.
The JS twin needs a matching `parseChoiceFilter`. The compiler emits and validates the
same string; there is no separate probe form.

The JS twin evaluates a filter with `evaluateChoiceFilter(expression, context, props)`,
once per candidate choice. A column missing from `props` reads as the empty string. A
prop is text, so it follows the ordinary `=` rule: two strings compare as strings
(`"01"` is not `"1"`), and a number or date on the other side makes it numeric. This was
confirmed as the intended rule: the main subset already coerces when one side is numeric,
and a different rule in the choice-filter namespace would be a trap for the next form
author. The Python evaluator has no Prop evaluation yet, so these rules are pinned by the
JS tests only; when the server grows one, move them into a shared case format.

## Where the two languages differ, and how the corpus pins it (added in Task 17)

Each of these has cases; the JavaScript side imitates Python, never the other way round.

- **Number to text** is Python's `repr()` for fractions and for whole numbers of 1e16 and
  up: `1e+16`, `1e-05`, `0.0001`. JavaScript's `String()` differs from 1e16 up and below
  1e-4. A whole number below 1e16 prints as plain digits, never with `.0`
  (`1000000000000000`). This used to print `1000000000000000.0` between 1e15 and 1e16,
  contradicting the module docstring; fixed on the Python side.
- **regex()** is a Python pattern, re-emitted for a browser by `translateRegex()`. Cases
  pin: `\s` is ASCII only (no U+00A0, no U+2028), `.` stops at `\n` only, `$` also matches
  before a final `\n`, `\A` and `\Z` anchor, `{,n}` is a quantifier while `{`, `}`, `]`,
  `{}` and `{1, 2}` are literals, and an astral character is one code point.
- **string-length** counts code points, so an emoji is 1.
- **-0** is returned as `0`.
- **`${ }`** may contain `\f` and `\v` around the name (Python's `\s`), but they are not
  separators anywhere else.
- **Limits**: 200 parts and nesting depth 50. 100 operands joined by `+` is the most that
  parses (201 parts is refused); 49 nested parentheses is the deepest.
- **Field names such as `constructor` or `__proto__`** read as unanswered, as in Python.

- **Refused on both sides at parse time**: possessive quantifiers (`a*+`), atomic groups,
  backreferences (`(a)\1`), `\N{name}`, and a repeat count of 4294967295 or more. A regex
  the two engines would disagree about must fail to publish, not behave differently on
  the phone.
- **Infinity** (a literal past the double range): `Infinity mod x` is NaN and
  `indexed-repeat` with an infinite index is empty. Neither crashes.
- **Hour 24** (`T24:00`) in an ISO datetime string is NaN. Python 3.14's `fromisoformat`
  would read it as the next midnight, and even accepts an impossible date with it.

Known and deliberately left alone: JavaScript checks the letter case of a timezone name
only heuristically, so a mixed-case name like `Asia/KOLKATA` passes the browser and fails
the server. The name comes from the server's own validated setting, so a typo surfaces
at deployment, not in field data.
