// The form engine. Its job is to agree with server/app/forms/validate.py exactly.
//
// Three kinds of test:
//   * behaviour on the REAL compiled spec of server/tests/fixtures/amb_asha_visit.xlsx
//     (fixtures/amb_asha_visit.spec.json, committed so no Python is needed here);
//   * edge cases on small hand-written specs;
//   * parity: fixtures/parity_cases.json holds what the SERVER's validate.py produced for
//     a set of submissions (see fixtures/make_parity.py). The engine must give the same
//     failures and the same settled values.
//
// Paths are the server's question paths: "name", "repeat[1]/name", "outer[1]/inner[2]/name".
// Row numbers in a path are 1-based, as the server writes them; the `index` argument of
// removeRepeatRow() is a 0-based array index.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { FormEngine } from "../js/formengine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(HERE, "fixtures", name), "utf8"));
const AMB = fixture("amb_asha_visit.spec.json");
const PARITY = fixture("parity_cases.json");
const NOW = "2026-10-31T09:00:00+05:30";

const engine = (spec = AMB, options = {}) => new FormEngine(spec, { now: NOW, ...options });
const visible = (e) => e.visibleNodes().map((v) => v.path);
const isVisible = (e, p) => visible(e).includes(p);
const failures = (e, rule) => e.errors().filter((f) => !rule || f.rule === rule).map((f) => `${f.question}:${f.rule}`);
const q = (type, name, extra = {}) => ({ type, name, ...extra });
const label = (t) => ({ default: t });
const spec = (nodes, choices = {}) => ({
  form_id: "t", version: "1", title: label("t"), languages: ["default"],
  default_language: "default", nodes, choices,
});
const YN = { yn: [{ value: "yes" }, { value: "no" }] };
const BAD = "${x} | 1"; // outside the subset, so evaluating it raises UnsupportedExpression

// A fully valid visit with one child, used as a base to break one rule at a time.
function validVisit() {
  const e = engine();
  e.setAnswer("district", "patna");
  e.setAnswer("block", "danapur");
  e.setAnswer("asha_name", "Sunita");
  e.setAnswer("household_children", 1);
  const row = e.addRepeatRow("children");
  e.setAnswer(`${row}/child_name`, "Asha");
  e.setAnswer(`${row}/child_age_months`, 30);
  e.setAnswer(`${row}/ifa_form`, "pink");
  return { e, row };
}

// ------------------------------------------------------------------ the brief's tests

test("a question whose relevant is false is not visible", () => {
  const e = engine();
  const row = e.addRepeatRow("children");
  assert.equal(isVisible(e, `${row}/referral_note`), false);
  assert.equal(isVisible(e, `${row}/syrup_given`), false);
  assert.equal(isVisible(e, `${row}/child_name`), true);
});

test("answering the trigger reveals the dependent question", () => {
  const e = engine();
  const row = e.addRepeatRow("children");
  e.setAnswer(`${row}/symptoms`, "pallor");
  assert.equal(isVisible(e, `${row}/referral_note`), true);
  e.setAnswer(`${row}/symptoms`, "fatigue");
  assert.equal(isVisible(e, `${row}/referral_note`), false);
  e.setAnswer(`${row}/ifa_form`, "syrup");
  assert.equal(isVisible(e, `${row}/syrup_given`), true);
});

test("hiding a question PRESERVES its raw answer (the server's rule, not the brief's)", () => {
  const e = engine();
  const row = e.addRepeatRow("children");
  e.setAnswer(`${row}/symptoms`, "pallor");
  e.setAnswer(`${row}/referral_note`, "pale palms");
  e.setAnswer(`${row}/symptoms`, "fatigue");
  assert.equal(isVisible(e, `${row}/referral_note`), false);
  assert.equal(e.getAnswer(`${row}/referral_note`), "pale palms");
  assert.equal(e.toSubmission().repeats.children[0].referral_note, "pale palms");
});

test("a calculate recomputes when its input changes", () => {
  const e = engine();
  const row = e.addRepeatRow("children");
  e.setAnswer(`${row}/child_age_months`, 30);
  assert.equal(e.getAnswer(`${row}/child_age_years`), 2);
  e.setAnswer(`${row}/child_age_months`, 36);
  assert.equal(e.getAnswer(`${row}/child_age_years`), 3);
  e.setAnswer(`${row}/child_age_months`, 59);
  assert.equal(e.getAnswer(`${row}/child_age_years`), 4);
});

test("a calculate that feeds a relevant moves the dependent question", () => {
  const e = engine();
  const row = e.addRepeatRow("children");
  e.setAnswer(`${row}/ifa_form`, "pink");
  e.setAnswer(`${row}/child_age_months`, 30);
  assert.equal(isVisible(e, `${row}/tablet_taken`), false); // two years old
  e.setAnswer(`${row}/child_age_months`, 40);
  assert.equal(isVisible(e, `${row}/tablet_taken`), true); // three years
  e.setAnswer(`${row}/ifa_form`, "syrup");
  assert.equal(isVisible(e, `${row}/tablet_taken`), false);
});

test("a top-level calculate over the repeat follows rows being added and removed", () => {
  const e = engine();
  assert.equal(e.getAnswer("children_count"), 0);
  const r1 = e.addRepeatRow("children");
  assert.equal(e.getAnswer("children_count"), 1); // count() counts rows, answered or not, as on the server
  e.addRepeatRow("children");
  assert.equal(e.getAnswer("children_count"), 2);
  e.setAnswer(`${r1}/child_name`, "A");
  assert.equal(e.getAnswer("children_count"), 2);
  e.removeRepeatRow("children", 0);
  assert.equal(e.getAnswer("children_count"), 1);
});

test("a constraint violation appears in errors() with its message", () => {
  const e = engine();
  e.setAnswer("household_children", 11);
  const f = e.errors().find((x) => x.question === "household_children");
  assert.deepEqual(f, { question: "household_children", rule: "constraint", message: "कृपया शून्य से दस के बीच की संख्या डालें" });
  e.setAnswer("household_children", 3);
  assert.equal(failures(e).includes("household_children:constraint"), false);
});

test("the constraint message follows the chosen language, falling back to the default", () => {
  const e = engine(AMB, { lang: "en" });
  e.setAnswer("household_children", 11);
  assert.equal(e.errors().find((x) => x.question === "household_children").message, "Enter a number from 0 to 10");
  e.setLanguage("bn"); // no Bengali: the form's default language, Hindi
  assert.equal(e.errors().find((x) => x.question === "household_children").message, "कृपया शून्य से दस के बीच की संख्या डालें");
});

test("a constraint is only checked on an answered question", () => {
  const e = engine();
  assert.equal(failures(e).includes("household_children:constraint"), false);
  assert.equal(failures(e).includes("household_children:required"), true);
});

test("a required empty question blocks isComplete()", () => {
  const { e } = validVisit();
  assert.equal(e.isComplete(), true, failures(e).join());
  e.setAnswer("asha_name", "");
  assert.equal(e.isComplete(), false);
  assert.ok(failures(e).includes("asha_name:required"));
  e.setAnswer("asha_name", "   "); // spaces are not an answer
  assert.equal(e.isComplete(), false);
});

test("a constraint failure blocks isComplete()", () => {
  const { e, row } = validVisit();
  e.setAnswer(`${row}/child_age_months`, 70);
  assert.equal(e.isComplete(), false);
});

test("a required question that is not relevant does not block isComplete()", () => {
  const { e, row } = validVisit();
  // syrup_given is required but only relevant for syrup; this child takes the pink tablet
  assert.equal(isVisible(e, `${row}/syrup_given`), false);
  assert.equal(failures(e).includes(`${row}/syrup_given:required`), false);
  assert.equal(e.isComplete(), true);
  e.setAnswer(`${row}/ifa_form`, "syrup");
  assert.equal(e.isComplete(), false);
  assert.ok(failures(e).includes(`${row}/syrup_given:required`));
});

test("choice_filter narrows blocks to the chosen district", () => {
  const e = engine();
  assert.deepEqual(e.choices("block").map((c) => c.value), []);
  e.setAnswer("district", "patna");
  assert.deepEqual(e.choices("block").map((c) => c.value), ["danapur", "paliganj"]);
  e.setAnswer("district", "gaya");
  assert.deepEqual(e.choices("block").map((c) => c.value), ["bodh_gaya", "sherghati"]);
  assert.deepEqual(e.choices("district").map((c) => c.value), ["patna", "gaya", "muzaffarpur"]);
});

test("adding two repeat rows yields two rows in toSubmission()", () => {
  const e = engine();
  assert.equal(e.addRepeatRow("children"), "children[1]");
  assert.equal(e.addRepeatRow("children"), "children[2]");
  e.setAnswer("children[1]/child_name", "A");
  e.setAnswer("children[2]/child_name", "B");
  const rows = e.toSubmission().repeats.children;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.child_name), ["A", "B"]);
});

test("removing a repeat row renumbers position() for the rows after it", () => {
  const s = spec([q("repeat", "r", { children: [q("text", "t", { label: label("t") }), q("calculate", "n", { calculate: "position()" })] })]);
  const e = engine(s);
  for (const name of ["a", "b", "c"]) e.setAnswer(`${e.addRepeatRow("r")}/t`, name);
  assert.deepEqual(e.toSubmission().repeats.r.map((r) => r.n), [1, 2, 3]);
  e.removeRepeatRow("r", 0);
  const rows = e.toSubmission().repeats.r;
  assert.deepEqual(rows.map((r) => r.t), ["b", "c"]);
  assert.deepEqual(rows.map((r) => r.n), [1, 2]);
});

test("a nested repeat round-trips through toSubmission()", () => {
  const e = engine();
  e.setAnswer("household_children", 2);
  const c1 = e.addRepeatRow("children");
  const c2 = e.addRepeatRow("children");
  for (const row of [c1, c2]) {
    e.setAnswer(`${row}/child_name`, row);
    e.setAnswer(`${row}/ifa_form`, "syrup");
    e.setAnswer(`${row}/syrup_given`, "yes");
  }
  const d1 = e.addRepeatRow(`${c1}/ifa_doses`);
  const d2 = e.addRepeatRow(`${c1}/ifa_doses`);
  assert.equal(d2, "children[1]/ifa_doses[2]");
  e.setAnswer(`${d1}/dose_date`, "2026-10-01");
  e.setAnswer(`${d2}/dose_date`, "2026-10-08");
  e.setAnswer(`${d2}/dose_ml`, 5);
  const sub = e.toSubmission();
  assert.equal(sub.repeats.children[0].ifa_doses.length, 2);
  assert.deepEqual(sub.repeats.children[0].ifa_doses[1], { dose_date: "2026-10-08", dose_ml: 5 });
  assert.equal(sub.repeats.children[1].ifa_doses, undefined);

  // and the submission loads back into a fresh engine unchanged
  const again = engine(AMB, { data: sub.data, repeats: sub.repeats });
  assert.deepEqual(again.toSubmission(), sub);
});

test("nested repeat failures are named children[1]/ifa_doses[2]/dose_date, 1-based", () => {
  const e = engine();
  const c1 = e.addRepeatRow("children");
  e.setAnswer(`${c1}/ifa_form`, "syrup");
  e.setAnswer(`${c1}/syrup_given`, "yes");
  e.addRepeatRow(`${c1}/ifa_doses`);
  const d2 = e.addRepeatRow(`${c1}/ifa_doses`);
  e.setAnswer(`${c1}/ifa_doses[1]/dose_date`, "2026-10-01");
  e.setAnswer(`${d2}/dose_date`, "2027-01-01"); // the future
  const f = e.errors().find((x) => x.question === "children[1]/ifa_doses[2]/dose_date");
  assert.equal(f.rule, "constraint");
  assert.equal(f.message, "तारीख आज से आगे की नहीं हो सकती");
});

// ------------------------------------------------------------------ server behaviour, one by one

test("1. calculates settle to a fixed point: a calculate declared before its input is right", () => {
  const s = spec([
    q("calculate", "a", { calculate: "${b} + 1" }),
    q("calculate", "b", { calculate: "${c} * 2" }),
    q("calculate", "c", { calculate: "${x} + 10" }),
    q("integer", "x", { label: label("x") }),
  ]);
  const e = engine(s);
  e.setAnswer("x", 1);
  assert.equal(e.getAnswer("c"), 11);
  assert.equal(e.getAnswer("b"), 22);
  assert.equal(e.getAnswer("a"), 23);
  e.setAnswer("x", 2);
  assert.equal(e.getAnswer("a"), 25);
});

test("1. a calculate that never settles reports an error and does not throw or hang", () => {
  const s = spec([q("calculate", "a", { calculate: "coalesce(${a}, 0) + 1" })]); // 1, 2, 3 ... forever
  let e;
  assert.doesNotThrow(() => { e = engine(s); });
  assert.ok(e.errors().some((f) => f.rule === "error" && /settle|cycle/.test(f.message)));
  assert.doesNotThrow(() => e.toSubmission());
  assert.doesNotThrow(() => e.visibleNodes());
});

test("1. a late-declared gating calculate still opens the group that depends on it", () => {
  const s = spec([
    q("group", "h", { relevant: "${gate} = 'open'", children: [q("integer", "hq", { label: label("hq"), required: true })] }),
    q("calculate", "gate", { calculate: "if(${x} > 5, 'open', 'shut')" }),
    q("integer", "x", { label: label("x") }),
  ]);
  const e = engine(s);
  e.setAnswer("x", 8);
  assert.equal(isVisible(e, "hq"), true);
  assert.ok(failures(e).includes("hq:required"));
  e.setAnswer("x", 2);
  assert.equal(isVisible(e, "hq"), false);
});

test("2. a calculate under a hidden group is unset, and re-cleared once the group hides", () => {
  const s = spec([
    q("integer", "x", { label: label("x") }),
    q("group", "g", { relevant: "${x} > 5", children: [q("calculate", "gc", { calculate: "${x} + 100" })] }),
  ]);
  const e = engine(s);
  e.setAnswer("x", 8);
  assert.equal(e.getAnswer("gc"), 108);
  e.setAnswer("x", 2);
  assert.equal(e.getAnswer("gc"), undefined);
  assert.equal("gc" in e.toSubmission().data, false);
  e.setAnswer("x", 9);
  assert.equal(e.getAnswer("gc"), 109);
});

test("2. a calculate under a hidden repeat, at depth, is unset in every row", () => {
  const s = spec([
    q("select_one", "show", { label: label("s"), choices_ref: "yn" }),
    q("repeat", "r", { relevant: "${show} = 'yes'", children: [
      q("integer", "v", { label: label("v") }),
      q("calculate", "rc", { calculate: "${v} * 2" }),
      q("repeat", "rr", { children: [q("integer", "w", { label: label("w") }), q("calculate", "rrc", { calculate: "${w} + ${v}" })] }),
    ] }),
  ], YN);
  const e = engine(s);
  e.setAnswer("show", "yes");
  const r1 = e.addRepeatRow("r");
  e.setAnswer(`${r1}/v`, 3);
  const w1 = e.addRepeatRow(`${r1}/rr`);
  e.setAnswer(`${w1}/w`, 4);
  assert.equal(e.getAnswer(`${r1}/rc`), 6);
  assert.equal(e.getAnswer(`${w1}/rrc`), 7);
  e.setAnswer("show", "no");
  assert.equal(e.getAnswer(`${r1}/rc`), undefined);
  assert.equal(e.getAnswer(`${w1}/rrc`), undefined);
  const sub = e.toSubmission().repeats.r[0];
  assert.deepEqual(sub, { v: 3, rr: [{ w: 4 }] }); // raw answers stay, calculates are gone
});

test("2. a calculate whose own relevant is false is unset", () => {
  const s = spec([
    q("integer", "x", { label: label("x") }),
    q("calculate", "c", { calculate: "${x} * 3", relevant: "${x} > 1" }),
  ]);
  const e = engine(s);
  e.setAnswer("x", 2);
  assert.equal(e.getAnswer("c"), 6);
  e.setAnswer("x", 1);
  assert.equal(e.getAnswer("c"), undefined);
});

test("3. raw answers of hidden questions still feed count() and sum()", () => {
  const s = spec([
    q("select_one", "show", { label: label("s"), choices_ref: "yn" }),
    q("repeat", "r", { relevant: "${show} = 'yes'", children: [q("integer", "v", { label: label("v") })] }),
    q("calculate", "total", { calculate: "sum(${v})" }),
    q("calculate", "n", { calculate: "count(${v})" }),
  ], YN);
  const e = engine(s);
  e.setAnswer("show", "yes");
  e.setAnswer(`${e.addRepeatRow("r")}/v`, 4);
  e.setAnswer(`${e.addRepeatRow("r")}/v`, 6);
  assert.equal(e.getAnswer("total"), 10);
  e.setAnswer("show", "no"); // the whole repeat is hidden; its rows are still counted
  assert.equal(e.getAnswer("total"), 10);
  assert.equal(e.getAnswer("n"), 2);
  assert.equal(e.visibleNodes().some((v) => v.name === "r"), false);
});

test("3. hidden raw answers are not blanked in the submission either", () => {
  const e = engine();
  e.setAnswer("household_children", 1);
  const row = e.addRepeatRow("children");
  e.setAnswer(`${row}/ifa_form`, "pink");
  e.setAnswer(`${row}/syrup_given`, "yes");
  const d = e.addRepeatRow(`${row}/ifa_doses`);
  e.setAnswer(`${d}/dose_date`, "2026-10-01");
  e.setAnswer(`${row}/ifa_form`, "pink"); // pink: the syrup question is hidden, its answer kept
  assert.equal(isVisible(e, `${row}/syrup_given`), false);
  assert.equal(e.getAnswer(`${row}/syrup_given`), "yes");
  e.setAnswer(`${row}/syrup_given`, "no"); // hides the dose repeat
  assert.equal(isVisible(e, `${d}/dose_date`), false);
  assert.deepEqual(e.toSubmission().repeats.children[0].ifa_doses, [{ dose_date: "2026-10-01" }]);
});

test("4. a non-relevant node never reports required, and its children are skipped too", () => {
  const s = spec([
    q("integer", "x", { label: label("x") }),
    q("group", "g", { relevant: "${x} > 5", children: [
      q("integer", "a", { label: label("a"), required: true }),
      q("group", "inner", { children: [q("integer", "b", { label: label("b"), required: true, constraint: ". > 100" })] }),
    ] }),
    q("repeat", "r", { relevant: "${x} > 5", children: [q("integer", "c", { label: label("c"), required: true })] }),
  ]);
  const e = engine(s);
  e.setAnswer("x", 1);
  e.addRepeatRow("r");
  e.setAnswer("b", 1);
  assert.deepEqual(e.errors(), []);
  assert.equal(e.isComplete(), true);
  e.setAnswer("x", 9);
  assert.deepEqual(failures(e).sort(), ["a:required", "b:constraint", "r[1]/c:required"]);
});

test("5. an erroring constraint is one 'error' failure, not a constraint failure, and does not throw", () => {
  const s = spec([q("integer", "x", { label: label("x") }), q("integer", "y", { label: label("y"), constraint: BAD })]);
  const e = engine(s);
  e.setAnswer("y", 3);
  assert.deepEqual(failures(e), ["y:error"]);
  assert.match(e.errors()[0].message, /constraint .* could not be evaluated/);
});

test("5. an erroring relevant is an 'error' failure and the question stays relevant", () => {
  const s = spec([q("integer", "x", { label: label("x") }), q("integer", "y", { label: label("y"), relevant: BAD, required: true })]);
  const e = engine(s);
  assert.equal(isVisible(e, "y"), true);
  assert.deepEqual(failures(e), ["y:error", "y:required"]);
  assert.match(e.errors()[0].message, /relevant .* could not be evaluated/);
});

test("5. an erroring calculate leaves the value empty and reports an 'error'", () => {
  const s = spec([q("integer", "x", { label: label("x") }), q("calculate", "c", { calculate: BAD })]);
  const e = engine(s);
  e.setAnswer("x", 3);
  assert.equal(e.getAnswer("c"), undefined);
  assert.deepEqual(failures(e), ["c:error"]);
  assert.match(e.errors()[0].message, /calculate .* could not be evaluated/);
});

test("5. an erroring relevant on a group is reported once and its children stay visible", () => {
  const s = spec([q("integer", "x", { label: label("x") }), q("group", "g", { relevant: BAD, children: [q("integer", "y", { label: label("y") })] })]);
  const e = engine(s);
  assert.equal(isVisible(e, "y"), true);
  assert.deepEqual(failures(e), ["g:error"]);
});

test("5. an 'error' failure does not stop the enumerator submitting; required and constraint do", () => {
  const s = spec([q("integer", "x", { label: label("x") }), q("integer", "y", { label: label("y"), constraint: BAD })]);
  const e = engine(s);
  e.setAnswer("y", 3);
  assert.equal(failures(e)[0], "y:error");
  assert.equal(e.isComplete(), true);
});

test("6. repeat failures are prefixed name[index]/question, 1-based", () => {
  const e = engine();
  const r1 = e.addRepeatRow("children");
  const r2 = e.addRepeatRow("children");
  e.setAnswer(`${r2}/child_name`, "B");
  assert.ok(failures(e).includes("children[1]/child_name:required"));
  assert.equal(failures(e).includes("children[2]/child_name:required"), false);
  assert.ok(r1 === "children[1]" && r2 === "children[2]");
});

test("7. select_multiple is a space-separated string; a list is normalised to one", () => {
  const e = engine();
  const row = e.addRepeatRow("children");
  e.setAnswer(`${row}/symptoms`, ["pallor", "fatigue"]);
  assert.equal(e.getAnswer(`${row}/symptoms`), "pallor fatigue");
  assert.equal(isVisible(e, `${row}/referral_note`), true);
  assert.equal(e.toSubmission().repeats.children[0].symptoms, "pallor fatigue");
  e.setAnswer(`${row}/symptoms`, "fatigue breathless");
  assert.equal(isVisible(e, `${row}/referral_note`), false);
});

test("8. a choice filter's bare name is the candidate's props column; ${name} is a form field", () => {
  const s = spec([
    q("select_one", "district", { label: label("d"), choices_ref: "district" }),
    q("select_one", "block", { label: label("b"), choices_ref: "block", choice_filter: "district = ${district}" }),
  ], {
    district: [{ value: "patna" }],
    block: [{ value: "a", props: { district: "patna" } }, { value: "b", props: { district: "gaya" } }, { value: "c" }],
  });
  const e = engine(s);
  e.setAnswer("district", "patna");
  assert.deepEqual(e.choices("block").map((c) => c.value), ["a"]); // c: an absent column reads as ""
  e.setAnswer("district", "");
  assert.deepEqual(e.choices("block").map((c) => c.value), ["c"]); // "" = "" is true
});

test("8. props compare as strings unless the other side is numeric", () => {
  const s = spec([
    q("integer", "grade", { label: label("g") }),
    q("select_one", "section", { label: label("s"), choices_ref: "sec", choice_filter: "grade = ${grade}" }),
    q("text", "code", { label: label("c") }),
    q("select_one", "by_code", { label: label("b"), choices_ref: "sec", choice_filter: "grade = ${code}" }),
  ], { sec: [{ value: "x", props: { grade: "1" } }, { value: "y", props: { grade: "01" } }] });
  const e = engine(s);
  e.setAnswer("grade", 1); // a number on the other side: numeric, so "01" equals 1
  assert.deepEqual(e.choices("section").map((c) => c.value), ["x", "y"]);
  e.setAnswer("code", "1"); // a string on both sides: string compare, "01" is not "1"
  assert.deepEqual(e.choices("by_code").map((c) => c.value), ["x"]);
});

test("8. an erroring choice filter shows every choice rather than hiding any, and does not throw", () => {
  const s = spec([q("select_one", "block", { label: label("b"), choices_ref: "block", choice_filter: "district | 1" })],
    { block: [{ value: "a" }, { value: "b" }] });
  const e = engine(s);
  assert.deepEqual(e.choices("block").map((c) => c.value), ["a", "b"]);
});

test("8. choices() of a question with no filter, an unknown list, or no choices is safe", () => {
  const s = spec([q("select_one", "q", { label: label("q"), choices_ref: "missing" }), q("text", "t", { label: label("t") })]);
  const e = engine(s);
  assert.deepEqual(e.choices("q"), []);
  assert.deepEqual(e.choices("t"), []);
  assert.deepEqual(e.choices("nope"), []);
});

test("8. a filter inside a repeat reads the row's own answers", () => {
  const s = spec([
    q("repeat", "r", { children: [
      q("select_one", "d", { label: label("d"), choices_ref: "district" }),
      q("select_one", "b", { label: label("b"), choices_ref: "block", choice_filter: "district = ${d}" }),
    ] }),
  ], {
    district: [{ value: "patna" }, { value: "gaya" }],
    block: [{ value: "a", props: { district: "patna" } }, { value: "b", props: { district: "gaya" } }],
  });
  const e = engine(s);
  const r1 = e.addRepeatRow("r");
  const r2 = e.addRepeatRow("r");
  e.setAnswer(`${r1}/d`, "patna");
  e.setAnswer(`${r2}/d`, "gaya");
  assert.deepEqual(e.choices(`${r1}/b`).map((c) => c.value), ["a"]);
  assert.deepEqual(e.choices(`${r2}/b`).map((c) => c.value), ["b"]);
});

test("9. a nested repeat's inner row sees its own row first, then the outer row", () => {
  const s = spec([
    q("repeat", "outer", { children: [
      q("integer", "o", { label: label("o") }),
      q("repeat", "inner", { children: [
        q("integer", "i", { label: label("i") }),
        q("calculate", "sum_oi", { calculate: "${o} + ${i}" }),
        q("calculate", "pos", { calculate: "position()" }),
      ] }),
    ] }),
  ]);
  const e = engine(s);
  const o1 = e.addRepeatRow("outer");
  const o2 = e.addRepeatRow("outer");
  e.setAnswer(`${o1}/o`, 10);
  e.setAnswer(`${o2}/o`, 20);
  e.setAnswer(`${e.addRepeatRow(`${o1}/inner`)}/i`, 1);
  e.setAnswer(`${e.addRepeatRow(`${o2}/inner`)}/i`, 2);
  e.setAnswer(`${e.addRepeatRow(`${o2}/inner`)}/i`, 3);
  const rows = e.toSubmission().repeats.outer;
  assert.deepEqual(rows[0].inner, [{ i: 1, sum_oi: 11, pos: 1 }]);
  assert.deepEqual(rows[1].inner, [{ i: 2, sum_oi: 22, pos: 1 }, { i: 3, sum_oi: 23, pos: 2 }]);
});

// ------------------------------------------------------------------ the engine as an API

test("a single-language form works with label[lang] and no branch", () => {
  const s = spec([q("text", "t", { label: label("Name") })]);
  const e = engine(s);
  assert.deepEqual(e.visibleNodes().map((v) => v.node.label[s.languages[0]]), ["Name"]);
});

test("visibleNodes() lists questions, notes and containers, never calculates", () => {
  const e = engine();
  const names = e.visibleNodes().map((v) => v.name);
  assert.ok(names.includes("summary_note") && names.includes("children") && names.includes("district"));
  assert.equal(names.includes("children_count"), false);
  const row = e.addRepeatRow("children");
  assert.equal(isVisible(e, `${row}/child_name`), true);
  assert.equal(e.visibleNodes().find((v) => v.name === "children").rowCount, 1);
  assert.equal(e.visibleNodes().find((v) => v.path === `${row}/child_name`).depth, 1);
});

test("visibleNodes() hides a whole group and everything in it", () => {
  const s = spec([q("integer", "x", { label: label("x") }), q("group", "g", { relevant: "${x} = 1", children: [q("text", "t", { label: label("t") })] })]);
  const e = engine(s);
  assert.deepEqual(visible(e), ["x"]);
  e.setAnswer("x", 1);
  assert.deepEqual(visible(e), ["x", "g", "t"]);
});

test("setAnswer to empty removes the answer; 0 is an answer", () => {
  const s = spec([q("integer", "n", { label: label("n") }), q("text", "t", { label: label("t") })]);
  const e = engine(s);
  e.setAnswer("n", 0);
  assert.equal(e.getAnswer("n"), 0);
  e.setAnswer("n", null);
  assert.equal(e.getAnswer("n"), undefined);
  assert.equal("n" in e.toSubmission().data, false);
  e.setAnswer("t", "");
  assert.equal("t" in e.toSubmission().data, false);
});

test("toSubmission() is a copy: changing it does not touch the engine", () => {
  const { e } = validVisit();
  const sub = e.toSubmission();
  sub.data.asha_name = "tampered";
  sub.repeats.children[0].child_name = "tampered";
  assert.equal(e.getAnswer("asha_name"), "Sunita");
  assert.equal(e.getAnswer("children[1]/child_name"), "Asha");
});

test("a draft can be restored from data and repeats", () => {
  const { e } = validVisit();
  const sub = e.toSubmission();
  const again = engine(AMB, { data: sub.data, repeats: sub.repeats });
  assert.deepEqual(again.toSubmission(), sub);
  assert.equal(again.isComplete(), true);
  assert.equal(again.getAnswer("children[1]/child_age_years"), 2);
});

test("restoring discards stored calculates and recomputes them", () => {
  const e = engine(AMB, { data: { children_count: 99 }, repeats: { children: [{ child_name: "A", child_age_months: 30, child_age_years: 9 }] } });
  assert.equal(e.getAnswer("children_count"), 1);
  assert.equal(e.getAnswer("children[1]/child_age_years"), 2);
});

test("restoring does not mutate what it was given", () => {
  const data = { household_children: 1 };
  const repeats = { children: [{ child_name: "A", symptoms: ["pallor", "fatigue"] }] };
  const before = JSON.stringify([data, repeats]);
  engine(AMB, { data, repeats }).setAnswer("children[1]/child_name", "B");
  assert.equal(JSON.stringify([data, repeats]), before);
});

test("the clock is the one given: today() follows now", () => {
  const e = engine(AMB, { now: "2026-10-01T09:00:00+05:30" });
  const row = e.addRepeatRow("children");
  e.setAnswer(`${row}/ifa_form`, "syrup");
  e.setAnswer(`${row}/syrup_given`, "yes");
  const d = e.addRepeatRow(`${row}/ifa_doses`);
  e.setAnswer(`${d}/dose_date`, "2026-10-15");
  assert.ok(failures(e).includes(`${d}/dose_date:constraint`));
  const sub = e.toSubmission();
  const later = engine(AMB, { now: "2026-10-20T09:00:00+05:30", data: sub.data, repeats: sub.repeats });
  assert.equal(failures(later).includes(`${d}/dose_date:constraint`), false);
});

test("now may be a function, read at each recompute, so a long session keeps today() current", () => {
  let clock = "2026-10-01T09:00:00+05:30";
  const e = new FormEngine(AMB, { now: () => clock });
  const row = e.addRepeatRow("children");
  e.setAnswer(`${row}/ifa_form`, "syrup");
  e.setAnswer(`${row}/syrup_given`, "yes");
  const d = e.addRepeatRow(`${row}/ifa_doses`);
  e.setAnswer(`${d}/dose_date`, "2026-10-15");
  assert.ok(failures(e).includes(`${d}/dose_date:constraint`));
  clock = "2026-10-20T09:00:00+05:30";
  e.setAnswer(`${row}/child_name`, "x"); // any change recomputes
  assert.equal(failures(e).includes(`${d}/dose_date:constraint`), false);
});

test("a naive clock is refused at construction, as the server refuses it", () => {
  assert.throws(() => new FormEngine(AMB, { now: "2026-10-31T09:00:00" }), /offset|naive/i);
});

test("naming a question that does not exist, or a row that does not, is a programming error and throws", () => {
  const e = engine();
  assert.throws(() => e.setAnswer("nope", 1), RangeError);
  assert.throws(() => e.setAnswer("child_name", "x"), RangeError); // inside a repeat: needs children[n]/
  assert.throws(() => e.setAnswer("children[3]/child_name", "x"), RangeError);
  assert.throws(() => e.setAnswer("children_count", 5), RangeError); // a calculate
  assert.throws(() => e.removeRepeatRow("children", 0), RangeError);
  assert.throws(() => e.addRepeatRow("district"), RangeError);
  assert.equal(e.getAnswer("nope"), undefined);
  assert.equal(e.getAnswer("children[9]/child_name"), undefined);
});

test("removing a row that exists, whichever one, leaves the others in order", () => {
  const e = engine();
  for (const n of ["A", "B", "C"]) e.setAnswer(`${e.addRepeatRow("children")}/child_name`, n);
  e.removeRepeatRow("children", 1);
  assert.deepEqual(e.toSubmission().repeats.children.map((r) => r.child_name), ["A", "C"]);
  assert.equal(e.getAnswer("children_count"), 2);
  e.removeRepeatRow("children", 1);
  e.removeRepeatRow("children", 0);
  assert.equal(e.getAnswer("children_count"), 0);
  assert.deepEqual(e.toSubmission().repeats, { children: [] });
});

test("rowCount() counts rows at any depth", () => {
  const e = engine();
  const r = e.addRepeatRow("children");
  e.addRepeatRow(`${r}/ifa_doses`);
  e.addRepeatRow(`${r}/ifa_doses`);
  assert.equal(e.rowCount("children"), 1);
  assert.equal(e.rowCount(`${r}/ifa_doses`), 2);
  assert.equal(e.rowCount("children[5]/ifa_doses"), 0);
});

test("errors() never throws, whatever the answers", () => {
  const e = engine();
  e.setAnswer("household_children", "not a number");
  e.setAnswer("asha_name", 12345);
  const r = e.addRepeatRow("children");
  e.setAnswer(`${r}/child_age_months`, "abc");
  e.setAnswer(`${r}/symptoms`, []);
  assert.doesNotThrow(() => e.errors());
  assert.doesNotThrow(() => e.visibleNodes());
  assert.doesNotThrow(() => e.toSubmission());
});

test("errors() returns a copy", () => {
  const e = engine();
  e.errors().length = 0;
  assert.ok(e.errors().length > 0);
});

test("a calculate that comes out as NaN is left out of the submission", () => {
  const e = engine();
  e.addRepeatRow("children"); // age unanswered: int(NaN) is NaN
  assert.equal("child_age_years" in e.toSubmission().repeats.children[0], false);
});

test("a date a calculate returns is submitted as an ISO string", () => {
  const s = spec([q("calculate", "d", { calculate: "today()" })]);
  const e = engine(s);
  assert.equal(e.toSubmission().data.d, "2026-10-31");
  assert.equal(e.getAnswer("d"), "2026-10-31");
});

test("a form with many repeat rows recomputes quickly enough for a phone", () => {
  const e = engine();
  const start = performance.now();
  for (let i = 0; i < 10; i++) {
    const r = e.addRepeatRow("children");
    e.setAnswer(`${r}/child_name`, `c${i}`);
    e.setAnswer(`${r}/child_age_months`, 12 + i);
  }
  e.errors();
  assert.ok(performance.now() - start < 3000, `took ${performance.now() - start} ms`);
});

// ------------------------------------------------------------------ parity with the server

const stripNaN = (v) => {
  if (Array.isArray(v)) return v.map(stripNaN);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "NaN").map(([k, x]) => [k, stripNaN(x)]));
  }
  return v;
};

for (const c of PARITY.cases) {
  const specFor = c.spec === "amb" ? AMB : PARITY[c.spec];
  test(`parity with validate.py: ${c.name}`, () => {
    const e = new FormEngine(specFor, { now: c.now, lang: specFor.default_language, data: c.data, repeats: c.repeats });
    assert.deepEqual(e.errors().map((f) => [f.question, f.rule]), c.failures.map((f) => [f.question, f.rule]));
    for (const f of c.failures) {
      if (f.rule === "constraint" || f.rule === "required") {
        const mine = e.errors().find((x) => x.question === f.question && x.rule === f.rule);
        assert.equal(mine.message, f.message, `${f.question} message`);
      }
    }
    assert.deepEqual(e.toSubmission(), stripNaN(c.settled));
  });
}
