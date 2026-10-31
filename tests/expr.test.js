// The expression evaluator, driven by the corpus shared with the Python implementation.
//
// shared/expr_cases.json is read by this file and by server/tests/test_expr.py. Result
// normalisation for comparison with JSON: a date or datetime becomes its ISO string and
// NaN becomes the string "NaN". Numbers are compared with deepStrictEqual, which tells
// -0 from 0 and 1 from true: evaluate() itself must return 0, never -0.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  Context,
  ContextError,
  DateTimeValue,
  DateValue,
  UnsupportedExpression,
  evaluate,
  evaluateChoiceFilter,
  parse,
  parseChoiceFilter,
  toBoolean,
} from "../js/expr.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const cases = JSON.parse(readFileSync(path.join(ROOT, "shared", "expr_cases.json"), "utf8"));
const SOURCE = readFileSync(path.join(ROOT, "webapp", "js", "expr.js"), "utf8");

const NOW = "2026-03-15T09:30:00+00:00";

function jsonable(value) {
  if (value instanceof DateValue || value instanceof DateTimeValue) return value.isoformat();
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return value;
}

function ctxFrom(c) {
  const ctx = { values: c.values, current: c.current, now: c.now, repeatIndex: c.repeat_index ?? 0 };
  if (c.timezone !== undefined) ctx.timezone = c.timezone;
  return ctx;
}

for (const c of cases) {
  test(`corpus: ${c.name}`, () => {
    if (c.unsupported) {
      assert.throws(() => parse(c.expr), UnsupportedExpression);
      // Rejection is at parse time, so evaluating must refuse the same way.
      assert.throws(() => evaluate(c.expr, { values: {}, current: null, now: "2026-01-01T00:00:00+00:00" }), UnsupportedExpression);
    } else {
      assert.deepStrictEqual(jsonable(evaluate(c.expr, ctxFrom(c))), c.expect);
    }
  });
}

test("the corpus is broad enough and its names are unique", () => {
  const names = cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(cases.length >= 25);
  assert.ok(cases.filter((c) => c.unsupported).length >= 3);
});

test("the corpus covers every supported function and operator", () => {
  const joined = cases.filter((c) => !c.unsupported).map((c) => c.expr).join(" ");
  for (const fn of ["selected(", "count(", "count-selected(", "sum(", "if(", "string-length(", "regex(", "concat(", "number(", "int(", "today(", "now(", "coalesce(", "position(", "indexed-repeat(", "not(", "true(", "false("]) {
    assert.ok(joined.includes(fn), fn);
  }
  for (const op of [" div ", " mod ", " and ", " or ", " != ", " <= ", " >= ", " + ", " * "]) {
    assert.ok(joined.includes(op), op);
  }
});

// ---------------------------------------------------------------- no ambient clock

test("the evaluator reads no ambient clock", () => {
  // The whole file, comments included: nothing may even mention an ambient clock call.
  const code = SOURCE;
  assert.ok(!code.includes("Date.now("), "Date.now( appears in expr.js");
  assert.ok(!/new Date\(\s*\)/.test(code), "new Date() with no argument appears in expr.js");
  for (const ambient of ["performance.now", "process.hrtime", "Date()", "Math.random"]) {
    assert.ok(!code.includes(ambient), ambient);
  }
  // resolvedOptions() would reveal the host's own time zone.
  assert.ok(!/DateTimeFormat\(\)/.test(code), "Intl.DateTimeFormat() with no arguments appears in expr.js");
});

test("the evaluator does not use eval or Function", () => {
  const code = SOURCE.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  assert.ok(!/\beval\s*\(/.test(code));
  assert.ok(!/\bnew Function\b/.test(code));
  assert.ok(!/^\s*import\s/m.test(code), "expr.js must be dependency-free");
});

test("today() follows context.now and context.timezone, not the host clock", () => {
  const t = (tz) => evaluate("today()", { values: {}, current: null, now: "2026-03-15T23:00:00+00:00", timezone: tz }).isoformat();
  assert.equal(t("Asia/Kolkata"), "2026-03-16");
  assert.equal(t("UTC"), "2026-03-15");
  assert.equal(evaluate("today()", { values: {}, current: null, now: "2026-03-15T23:00:00+00:00" }).isoformat(), "2026-03-16");
});

test("a Date object is accepted as now, with the same answer as its ISO string", () => {
  const d = new Date("2026-03-15T23:00:00Z");
  assert.equal(evaluate("today()", { values: {}, current: null, now: d }).isoformat(), "2026-03-16");
  assert.equal(evaluate("now()", { values: {}, current: null, now: d }).isoformat(), "2026-03-15T23:00:00+00:00");
});

// ---------------------------------------------------------------- context refusals

test("a naive now is refused, not guessed", () => {
  for (const now of ["2026-03-15T09:30:00", "2026-03-15", "", "not a time", 0, null, undefined, new Date(NaN)]) {
    assert.throws(() => new Context({ values: {}, current: null, now }), ContextError, String(now));
  }
  assert.throws(() => evaluate("1", { values: {}, current: null, now: "2026-03-15T09:30:00" }), ContextError);
});

test("an unknown timezone is refused", () => {
  for (const timezone of ["Mars/Olympus", "", "+05:30", "asia/kolkata", "Asia/kolkata", "UTC+5", 5, null]) {
    assert.throws(() => new Context({ values: {}, current: null, now: NOW, timezone }), ContextError, String(timezone));
  }
  assert.doesNotThrow(() => new Context({ values: {}, current: null, now: NOW, timezone: "America/New_York" }));
});

test("the default timezone is Asia/Kolkata", () => {
  assert.equal(new Context({ values: {}, current: null, now: NOW }).timezone, "Asia/Kolkata");
});

test("a context may be reused and passed as a Context instance", () => {
  const ctx = new Context({ values: { a: 2 }, current: null, now: NOW });
  assert.equal(evaluate("${a} + 1", ctx), 3);
  assert.equal(evaluate("${a} * 2", ctx), 4);
});

// ---------------------------------------------------------------- errors carry detail

test("UnsupportedExpression carries the expression and the reason", () => {
  const expr = "instance('x')/root/item[./name = ${a}]/label";
  assert.throws(
    () => parse(expr),
    (e) => e instanceof UnsupportedExpression && e instanceof Error && e.expression === expr && e.reason && e.message.includes(e.reason),
  );
});

test("a non-string expression is unsupported, never coerced", () => {
  for (const bad of [null, undefined, 5, {}, ["1"]]) {
    assert.throws(() => parse(bad), UnsupportedExpression);
    assert.throws(() => parseChoiceFilter(bad), UnsupportedExpression);
  }
});

test("parse returns a reusable tree", () => {
  assert.deepStrictEqual(parse("${a} + 1"), parse("${a} + 1"));
});

// ---------------------------------------------------------------- JavaScript-only hazards

test("fields named like Object.prototype members read as unanswered", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(evaluate("${" + name + "}", { values: {}, current: null, now: NOW }), "", name);
    assert.equal(evaluate("count(${" + name + "})", { values: {}, current: null, now: NOW }), 0, name);
  }
});

test("a value that is a JS Date reads as an instant", () => {
  const ctx = { values: { t: new Date("2026-03-15T09:00:00Z") }, current: null, now: NOW };
  assert.equal(evaluate("${t} < now()", ctx), true);
});

test("a value of another type is a TypeError, as in Python", () => {
  assert.throws(() => evaluate("concat(${a})", { values: { a: { x: 1 } }, current: null, now: NOW }), TypeError);
});

// ---------------------------------------------------------------- choice filters

const FILTER_CTX = (values) => ({ values, current: null, now: NOW });

test("plain parse still rejects a bare name, parseChoiceFilter accepts it", () => {
  assert.throws(() => parse("district = ${district}"), UnsupportedExpression);
  const tree = parseChoiceFilter("district = ${district}");
  assert.equal(tree.type, "binary");
  assert.deepStrictEqual(tree.left, { type: "prop", name: "district" });
  assert.deepStrictEqual(tree.right, { type: "ref", name: "district" });
});

test("a choice filter shows the choices whose column matches the form field", () => {
  const f = (props, district) => evaluateChoiceFilter("district = ${district}", FILTER_CTX({ district }), props);
  assert.equal(f({ district: "patna" }, "patna"), true);
  assert.equal(f({ district: "gaya" }, "patna"), false);
  assert.equal(f({ district: "Patna" }, "patna"), false, "string compare is case sensitive");
});

test("a column absent from the choice's props reads as the empty string", () => {
  const e = (expr, props, values = {}) => evaluateChoiceFilter(expr, FILTER_CTX(values), props);
  assert.equal(e("district = ''", {}), true);
  assert.equal(e("district = ${district}", {}, { district: "patna" }), false);
  assert.equal(e("district = ${district}", {}, {}), true, "absent column and unanswered field are both empty");
  assert.equal(e("constructor = ''", {}), true, "an inherited property is not a column");
  assert.equal(e("district = ''", { district: null }), true);
  assert.equal(e("district = ''"), true, "props may be left out entirely");
});

test("props compare as strings unless the other side is a number", () => {
  const e = (expr, props, values = {}) => evaluateChoiceFilter(expr, FILTER_CTX(values), props);
  assert.equal(e("code = ${code}", { code: "01" }, { code: "1" }), false, "two strings: '01' is not '1'");
  assert.equal(e("code = ${code}", { code: "01" }, { code: 1 }), true, "a number on one side makes it numeric");
  assert.equal(e("code = 1", { code: "01" }), true);
  assert.equal(e("code = '1'", { code: "01" }), false);
  assert.equal(e("pop > 1000", { pop: "2500" }), true, "relational operators are always numeric");
  assert.equal(e("pop > 1000", { pop: "abc" }), false);
  assert.equal(e("pop > 1000", {}), false);
});

test("a bare name followed by ( is still a function call", () => {
  const e = (expr, props) => evaluateChoiceFilter(expr, FILTER_CTX({}), props);
  assert.equal(e("string-length(name) = 5", { name: "Patna" }), true);
  assert.equal(e("regex(code, '[0-9]+')", { code: "123" }), true);
  assert.throws(() => parseChoiceFilter("format-date(d, 'x')"), UnsupportedExpression);
  assert.throws(() => parseChoiceFilter("bogus(1)"), UnsupportedExpression);
});

test("choice filter mode changes nothing else: operators, limits and rejections are the same", () => {
  assert.throws(() => parseChoiceFilter("a/b = 1"), UnsupportedExpression);
  assert.throws(() => parseChoiceFilter("../a = 1"), UnsupportedExpression);
  assert.throws(() => parseChoiceFilter(""), UnsupportedExpression);
  assert.throws(() => parseChoiceFilter("a == 1"), UnsupportedExpression);
  const e = (expr, props, values) => evaluateChoiceFilter(expr, FILTER_CTX(values), props);
  assert.equal(e("a = 1 and b = 2 or c = 3", { a: "9", b: "9", c: "3" }), true);
  assert.equal(e("district = ${district} or ${all} = 'yes'", { district: "x" }, { district: "y", all: "yes" }), true);
  assert.equal(toBoolean(e("district", { district: "x" })), true);
});

test("a bare name in a choice filter never reads the form's answers", () => {
  assert.equal(evaluateChoiceFilter("district = 'x'", FILTER_CTX({ district: "x" }), {}), false);
  assert.equal(evaluateChoiceFilter("${district} = 'x'", FILTER_CTX({ district: "x" }), {}), true);
});

// ---------------------------------------------------------------- result types

test("evaluate never returns negative zero", () => {
  for (const expr of ["-0", "0 * -1", "int(-0.5)", "-0 + 0 * -1", "if(1 = 1, -0, 1)", "coalesce(-0, 1)", "-(0)", "-int(0.3)", "0 mod -3", "-0 mod 5"]) {
    const r = evaluate(expr, { values: {}, current: null, now: NOW });
    assert.ok(Object.is(r, 0), `${expr} gave ${Object.is(r, -0) ? "-0" : r}`);
  }
});

test("booleans stay booleans and numbers stay numbers", () => {
  const e = (x) => evaluate(x, { values: {}, current: null, now: NOW });
  assert.strictEqual(e("1 = 1"), true);
  assert.strictEqual(e("true() + 1"), 2);
  assert.strictEqual(e("not(0)"), true);
  assert.strictEqual(e("number(1 = 1)"), 1);
});

test("dates come back as DateValue and DateTimeValue with ISO text", () => {
  const e = (x) => evaluate(x, { values: {}, current: null, now: "2026-03-15T09:30:00.250000+00:00" });
  assert.ok(e("today()") instanceof DateValue);
  assert.ok(e("now()") instanceof DateTimeValue);
  assert.equal(String(e("today()")), "2026-03-15");
  assert.equal(String(e("now()")), "2026-03-15T09:30:00.250000+00:00");
  assert.equal(JSON.stringify(e("now()")), '"2026-03-15T09:30:00.250000+00:00"');
});

// ---------------------------------------------------------------- number to text, extremes

test("number to text follows Python's repr at the extremes, not JavaScript's String()", () => {
  const s = (expr) => evaluate(`concat(${expr})`, { values: {}, current: null, now: NOW });
  assert.equal(s("10000000000000000"), "1e+16"); // JS String gives 10000000000000000
  assert.equal(s("0.00001"), "1e-05"); // JS String gives 0.00001
  assert.equal(s("0.0001"), "0.0001");
  assert.equal(s("0.000012345"), "1.2345e-05");
  assert.equal(s("999999999999999"), "999999999999999");
  assert.equal(s("1000000000000000"), "1000000000000000.0"); // a Python quirk, pinned
  assert.equal(s("1234567890123456"), "1234567890123456.0");
  assert.equal(s("123456789012345678"), "1.2345678901234568e+17");
  assert.equal(s("-10000000000000000"), "-1e+16");
  assert.equal(s("1" + "0".repeat(400)), "Infinity");
  assert.equal(s("-1" + "0".repeat(400)), "-Infinity");
});

test("date arithmetic is exact far from today, as Python's timedelta division is", () => {
  const e = (x) => evaluate(x, { values: {}, current: null, now: NOW });
  assert.equal(e("number('9999-12-31T23:59:59.999999-23:59')"), 2932897.9993055556);
  assert.equal(e("number('0001-01-01T00:00+05:30')"), -719162.2291666666);
  assert.equal(e("number('2026-03-15T09:00:00.5Z')"), 20527.37500578704);
  assert.equal(e("number('2026-03-15T24:00Z')"), 20528);
  assert.ok(Number.isNaN(e("number('2026-03-15T24:01Z')")));
  assert.ok(Number.isNaN(e("number('2026-03-15T25:00Z')")));
  assert.ok(Number.isNaN(e("number('2026-03-15T09:00+24:00')")));
  assert.equal(e("number('2026-03-15T09:00+05:60')"), 20527.125);
  assert.equal(e("number('2026-03-15T09:00:00.9999999Z')"), 20527.375011574062);
});

// ---------------------------------------------------------------- regex: where JS is stricter than Python

// Python accepts each of these; they cannot be reproduced exactly in a browser, so they
// are refused at parse time instead of silently behaving differently. They are NOT in
// the shared corpus because the Python suite would fail on them. See the task report:
// the cleanest fix is for expr.py to refuse them too, after which they can move there.
test("regex syntax that Python accepts but a browser cannot match exactly is refused loudly", () => {
  for (const pattern of ["a*+", "a++", "a?+", "a{2}+", "(a)\\1", "(a)?\\1", "\\N{DIGIT ONE}","a{99999999999}", "a{4294967295}"]) {
    assert.throws(() => parse(`regex(\${a}, '${pattern}')`), UnsupportedExpression, pattern);
  }
});

test("regex() refuses a pattern that is too deeply nested instead of overflowing the stack", () => {
  const deep = "(".repeat(20000) + ")".repeat(20000);
  assert.throws(() => parse(`regex(\${a}, '${deep}')`), UnsupportedExpression);
});

test("regex() uses the compiled pattern for every call without carrying state between calls", () => {
  const ctx = (a) => ({ values: { a }, current: null, now: NOW });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(evaluate("regex(${a}, '[a-c]+')", ctx("abc")), true);
    assert.equal(evaluate("regex(${a}, '[a-c]+')", ctx("abd")), false);
  }
});
