// The form engine: holds the answers on the phone, decides what is visible, recomputes
// derived values, validates, and manages repeat rows.
//
// It is the browser twin of server/app/forms/validate.py and MUST AGREE WITH IT EXACTLY.
// If the two disagree, the phone accepts an answer the server rejects, or the reverse, and
// a real household visit is lost or wrongly flagged. validate.py's module docstring is the
// specification; this file is a port of its logic, kept structurally close so the two can be
// read side by side. webapp/tests/fixtures/parity_cases.json holds what the SERVER produced
// for a set of submissions, and the tests hold this engine to it.
//
// THE RULES (each one is a decision made on the server; do not "improve" any here)
//   1. Calculates settle to a FIXED POINT, not document order: every calculate is
//      re-evaluated pass after pass until no value changes, at most (calculate instances
//      + 1) passes. A calculate declared before its input would otherwise compute from an
//      empty value and store a plausible wrong number silently.
//   (Deliberate phone-only choices: isComplete() ignores rule "error" because the enumerator
//   cannot fix a broken form and blocking her would strand field data; a calculate cycle
//   becomes an "error" failure instead of the server's exception, safer on a phone, and
//   unreachable in practice since compile.py refuses to publish a cyclic form;
//   `repeat_count` is not enforced here or on the server (Phase 2); recompute runs from
//   scratch like the server and is untimed at several hundred repeat rows.)
//   2. A calculate under ANY node whose `relevant` is false (group or repeat, any depth),
//      or whose own `relevant` is false, is not computed and its value is unset.
//   3. RAW ANSWERS OF HIDDEN QUESTIONS ARE PRESERVED, never blanked. (The task brief said
//      the opposite: "hiding a question clears its answer". The server settled this later
//      and on purpose: a calculate is derived, so deriving it from a section nobody saw
//      would invent data; a raw answer is received, and we keep what we receive. Hidden
//      raw answers still feed count() and sum(), so the phone and server totals agree.)
//   4. `relevant` is evaluated before anything else. A non-relevant node is skipped with
//      all its children and never reports `required`.
//   5. An expression that errors never throws out of the engine. An erroring `constraint`
//      is a failure of rule "error"; an erroring `relevant` is treated as RELEVANT (showing
//      a question wrongly is recoverable, hiding one wrongly is not) and is reported as
//      "error"; an erroring `calculate` leaves the value empty and is reported as "error".
//      A failure's `rule` is "required", "constraint" (the answer is wrong) or "error"
//      (the form itself is broken): they need different remedies.
//   6. Failures are named `name[index]/question`, 1-based, nested as
//      `children[1]/ifa_doses[2]/dose_date`.
//   7. A select_multiple answer is a space-separated string; a list is joined into one.
//   8. choice_filter: a bare name is a column of the candidate choice (its `props`),
//      `${name}` is a form field. Handled by parseChoiceFilter in expr.js.
//   9. A repeat's field resolves inner row first, then the outer rows. Safe only because
//      the compiler refuses a field name used twice anywhere in a form.
//
// HOW IT STAYS IN STEP WITH THE SERVER. After every change the engine does what the server
// does with a submission: drop every stored calculate, normalise, and settle from the raw
// answers alone. So the phone's calculated values are exactly what the server will compute
// from what the phone sends, never something left over from an earlier state.
//
// WHAT DOES THROW. Expressions never do. Naming a question or row that does not exist, an
// answer of an impossible kind, or a naive clock at construction are programming errors in
// the caller (a UI bug or a bad deployment) and raise RangeError, TypeError or ContextError.

import { Context, evaluate, evaluateChoiceFilter, toBoolean } from "./expr.js";
import { defaultLanguage, translate } from "./i18n.js";

const CYCLE_MESSAGE = "calculate values do not settle; the form has a dependency cycle";

// ---------------------------------------------------------------- small helpers

// Answers live in objects with no prototype, so a field called "__proto__" or
// "constructor" is an ordinary key. Anything handed out is converted to a plain object.
const dict = () => Object.create(null);
const has = (obj, key) => Object.hasOwn(obj, key);
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isRecord(v)) {
    const out = dict();
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
    return out;
  }
  return v;
}

// Python's str.isspace() characters, so "blank" means what validate.py's _blank means.
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const ONLY_SPACE = new RegExp(`^[${PY_SPACE}]*$`);

function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return ONLY_SPACE.test(value);
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

// A comparison key standing in for Python's repr(): equal values give equal keys, and NaN
// equals NaN (a calculate that stays NaN has settled).
function signature(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isNaN(v) ? "nan" : Object.is(v, -0) ? "n:0" : `n:${v}`;
  if (typeof v === "string") return `s:${v}`;
  if (typeof v === "boolean") return `b:${v}`;
  if (typeof v.isoformat === "function") return `t:${v.isoformat()}`;
  return `o:${JSON.stringify(v)}`;
}

const isTemporal = (v) => v !== null && typeof v === "object" && typeof v.isoformat === "function";

// What leaves the engine: a date a calculate produced becomes its ISO string; NaN (a
// calculate with nothing to calculate from) becomes absent. Returns undefined for "absent".
function outward(v) {
  if (typeof v === "number" && Number.isNaN(v)) return undefined;
  if (isTemporal(v)) return v.isoformat();
  return v;
}

function plain(v) {
  if (Array.isArray(v)) return v.map(plain).filter((x) => x !== undefined);
  if (isRecord(v) && !isTemporal(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const p = plain(x);
      if (p !== undefined) Object.defineProperty(out, k, { value: p, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return outward(v);
}

function why(kind, expr, exc) {
  const reason = (exc && exc.reason) || `${exc?.name ?? "Error"}: ${exc?.message ?? exc}`;
  return `${kind} '${expr}' could not be evaluated: ${reason}`;
}

// Field name to one entry per row: the flat-list shape the evaluator expects. Fields of a
// nested repeat are flattened across the nested rows of every row.
function gather(nodes, rows) {
  const out = dict();
  for (const node of nodes) {
    const kids = node.children ?? [];
    if (node.type === "repeat") {
      const nested = [];
      for (const row of rows) {
        const inner = row[node.name];
        if (Array.isArray(inner)) for (const r of inner) if (isRecord(r)) nested.push(r);
      }
      Object.assign(out, gather(kids, nested));
    } else if (node.type === "group") {
      Object.assign(out, gather(kids, rows));
    } else {
      out[node.name] = rows.map((row) => (has(row, node.name) ? row[node.name] : null));
    }
  }
  return out;
}

// A row's own scalar answers: everything but a non-empty list of nested rows.
function scalars(own) {
  const out = dict();
  for (const [k, v] of Object.entries(own)) {
    if (!(Array.isArray(v) && v.length > 0 && v.every(isRecord))) out[k] = v;
  }
  return out;
}

// One scope of answers: the top level, or one row of a repeat.
class Level {
  constructor(own, outer, index, prefix, siblings = null, nodes = null) {
    this.own = own;
    this.outer = outer;
    this.index = index;
    this.prefix = prefix;
    this.siblings = siblings;
    this.nodes = nodes;
  }
}

const SEGMENT = /^([A-Za-z_][A-Za-z0-9_.\-]*)(?:\[([0-9]+)\])?$/;

function parsePath(path) {
  if (typeof path !== "string" || path === "") throw new RangeError(`not a question path: ${JSON.stringify(path)}`);
  return path.split("/").map((part) => {
    const m = SEGMENT.exec(part);
    if (!m) throw new RangeError(`not a question path: ${JSON.stringify(path)}`);
    const row = m[2] === undefined ? null : Number(m[2]);
    if (row !== null && row < 1) throw new RangeError(`row numbers start at 1: ${JSON.stringify(path)}`);
    return { name: m[1], row };
  });
}

// ---------------------------------------------------------------- the engine

export class FormEngine {
  // spec     a compiled spec (server/app/forms/compile.py).
  // options  now       a Date, an ISO datetime WITH an offset, or a function returning one,
  //                   read at every recompute so today() stays right in a long session.
  //                   Default: the device clock.
  //          lang      the language constraint messages are reported in. Default: the form's.
  //          timezone  IANA zone deciding today(). Default Asia/Kolkata.
  //          data, repeats   a saved draft (the shape toSubmission() returns). Copied.
  constructor(spec, { now, lang, timezone, data, repeats } = {}) {
    this.spec = spec;
    this.nodes = spec.nodes ?? [];
    this.fallbackLang = defaultLanguage(spec);
    this.lang = lang ?? this.fallbackLang;
    this.timezone = timezone;
    this.nowOf = typeof now === "function" ? now : () => (now === undefined ? new Date() : now);
    this.topRepeats = this.#topRepeats(this.nodes);
    this.data = clone(isRecord(data) ? data : {});
    this.topRows = new Map();
    const given = isRecord(repeats) ? repeats : {};
    for (const [name, rows] of Object.entries(given)) this.topRows.set(name, clone(Array.isArray(rows) ? rows : []));
    this.top = new Level(this.data, dict(), 0, "");
    this.#recompute(); // also fails fast on a naive clock
  }

  // ---- public: answers

  // Set an answer. `path` is a question path: "name" at the top level, "repeat[1]/name"
  // inside a repeat, "outer[1]/inner[2]/name" when nested (1-based, as errors() writes them).
  // Empty ("", null, undefined, an empty list) removes the answer. A hidden question's
  // answer is NOT removed when it hides: see rule 3.
  setAnswer(path, value) {
    const { node, level } = this.#locate(path, "question");
    if (has(node, "calculate")) throw new RangeError(`${path} is a calculate; it cannot be answered`);
    let v = value;
    if (Array.isArray(v)) {
      if (node.type !== "select_multiple") throw new TypeError(`${path}: a list is only an answer to select_multiple`);
      if (v.some((i) => typeof i !== "string" && typeof i !== "number")) throw new TypeError(`${path}: choices must be text`);
      v = v.map(String).join(" ");
    }
    if (v !== null && v !== undefined && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new TypeError(`${path}: an answer is text, a number or true/false, not ${typeof v}`);
    }
    if (v === null || v === undefined || v === "") delete level.own[node.name];
    else level.own[node.name] = v;
    this.#recompute();
  }

  // The current answer, or undefined: unanswered, a path that names nothing, or a
  // calculate that has nothing to calculate from. Never throws.
  getAnswer(path) {
    try {
      const { node, level } = this.#locate(path, "question");
      return has(level.own, node.name) ? outward(level.own[node.name]) : undefined;
    } catch (e) {
      if (e instanceof RangeError) return undefined;
      throw e;
    }
  }

  setLanguage(lang) {
    this.lang = lang;
    this._errors = null;
  }

  // ---- public: repeats

  // Add a row to the repeat at `path` ("children", or "children[1]/ifa_doses" for a nested
  // one). Returns the new row's path, "children[2]", to address its questions.
  addRepeatRow(path) {
    const { node, level } = this.#locate(path, "repeat");
    const rows = this.#rowsOf(node, level, true);
    rows.push(dict());
    this.#recompute();
    return `${level.prefix}${node.name}[${rows.length}]`;
  }

  // Remove the row at 0-based array `index` of the repeat at `path`. Later rows move up, and
  // so does their position().
  removeRepeatRow(path, index) {
    const { node, level } = this.#locate(path, "repeat");
    const rows = this.#rowsOf(node, level, false);
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
      throw new RangeError(`${path} has ${rows.length} rows; there is no row at index ${index}`);
    }
    rows.splice(index, 1);
    if (rows.length === 0 && level.siblings !== null) delete level.own[node.name]; // a nested repeat with no rows
    this.#recompute();
  }

  // How many rows the repeat at `path` has (0 if the path names nothing).
  rowCount(path) {
    try {
      const { node, level } = this.#locate(path, "repeat");
      return this.#rowsOf(node, level, false).length;
    } catch (e) {
      if (e instanceof RangeError) return 0;
      throw e;
    }
  }

  // ---- public: what to show

  // Everything the enumerator should currently see, in order, as flat entries
  // {node, name, path, depth}. Groups and repeats are entries too, followed by their
  // contents; a repeat entry also has `rowCount`, and its rows' questions carry paths like
  // "children[2]/child_name". Calculates are never shown. A hidden node hides its children.
  visibleNodes() {
    const out = [];
    this.#visit(this.nodes, this.top, 0, out);
    return out;
  }

  // The choices of the select question at `path`, narrowed by its choice_filter for the
  // current answers. A filter that cannot be evaluated shows every choice. [] for a path
  // that is not a select question.
  choices(path) {
    let located;
    try {
      located = this.#locate(path, "question");
    } catch (e) {
      if (e instanceof RangeError) return [];
      throw e;
    }
    const { node, level } = located;
    const list = has(node, "choices_ref") ? this.spec.choices?.[node.choices_ref] : node.choices;
    if (!Array.isArray(list)) return [];
    if (!node.choice_filter) return list.slice();
    const ctx = this.#context(level);
    return list.filter((choice) => {
      try {
        return toBoolean(evaluateChoiceFilter(node.choice_filter, ctx, isRecord(choice.props) ? choice.props : {}));
      } catch {
        return true; // showing a choice wrongly is recoverable; hiding one is not
      }
    });
  }

  // ---- public: checking

  // Every failure, as {question, rule, message}, in the order the server reports them.
  // rule "required" and "constraint": the answer is wrong. rule "error": the form itself
  // is broken (an expression that cannot be evaluated, or calculates that never settle).
  errors() {
    if (!this._errors) {
      this._failures = [];
      this.#walk(this.nodes, this.top);
      this._errors = [...this.settleFailures, ...this._failures];
    }
    return this._errors.map((f) => ({ ...f }));
  }

  // True when nothing blocks sending: no required question empty, no constraint broken.
  // A rule "error" does not block: the enumerator cannot fix a broken form, and the server
  // keeps the submission flagged either way.
  isComplete() {
    return !this.errors().some((f) => f.rule === "required" || f.rule === "constraint");
  }

  // {data, repeats} in the shape the server's validate_submission takes: top-level answers,
  // and top-level repeat name -> rows with nested rows inside their parent row. A copy.
  // Calculated values are included (the server discards and recomputes them).
  toSubmission() {
    const repeats = {};
    for (const rep of this.topRepeats) {
      Object.defineProperty(repeats, rep.name, {
        value: plain(this.topRows.get(rep.name) ?? []), enumerable: true, writable: true, configurable: true,
      });
    }
    return { data: plain(this.data), repeats };
  }

  // ---- addressing

  #topRepeats(nodes) {
    const found = [];
    for (const n of nodes) {
      if (n.type === "repeat") found.push(n);
      else if (n.type === "group") found.push(...this.#topRepeats(n.children ?? []));
    }
    return found;
  }

  // A question or repeat by name, looking through groups but not into repeats (a repeat's
  // fields belong to its rows and need a row in the path).
  #find(nodes, name) {
    for (const n of nodes) {
      if (n.name === name) return n;
      if (n.type === "group") {
        const inner = this.#find(n.children ?? [], name);
        if (inner) return inner;
      }
    }
    return null;
  }

  // Walk a path to its node and the Level that holds its answers. `want` is "question" or
  // "repeat": what the last segment must be. Throws RangeError for a path that names nothing.
  #locate(path, want) {
    const segs = parsePath(path);
    let nodes = this.nodes;
    let level = this.top;
    for (let i = 0; i < segs.length; i++) {
      const { name, row } = segs[i];
      const node = this.#find(nodes, name);
      if (!node) {
        const outside = this.#find(this.#everything(), name);
        throw new RangeError(outside
          ? `${name} is inside a repeat: name its row, like ${this.#hint(name)}`
          : `no question named ${name}`);
      }
      const last = i === segs.length - 1;
      if (last) {
        if (want === "repeat") {
          if (node.type !== "repeat") throw new RangeError(`${name} is not a repeat`);
          if (row !== null) throw new RangeError(`${path} names a row; name the repeat`);
          return { node, level };
        }
        if (node.type === "repeat" || node.type === "group") throw new RangeError(`${name} is a ${node.type}, not a question`);
        if (row !== null) throw new RangeError(`${name} is not a repeat`);
        return { node, level };
      }
      if (node.type !== "repeat" || row === null) throw new RangeError(`${name} must be a repeat row, like ${name}[1]`);
      const kids = this.#children(node, level);
      if (row > kids.length) throw new RangeError(`${name} has ${kids.length} rows; there is no row ${row}`);
      level = kids[row - 1];
      nodes = node.children ?? [];
    }
    throw new RangeError(`not a question path: ${JSON.stringify(path)}`);
  }

  #everything(nodes = this.nodes, out = []) {
    for (const n of nodes) {
      out.push(n);
      if (n.children) this.#everything(n.children, out);
    }
    return out;
  }

  #hint(name) {
    const chain = [];
    const find = (nodes, trail) => {
      for (const n of nodes) {
        if (n.name === name) return trail;
        if (n.children) {
          const r = find(n.children, n.type === "repeat" ? [...trail, `${n.name}[1]`] : trail);
          if (r) return r;
        }
      }
      return null;
    };
    return [...(find(this.nodes, chain) ?? []), name].join("/");
  }

  #rowsOf(node, level, create) {
    if (level.siblings === null) {
      let rows = this.topRows.get(node.name);
      if (!rows) {
        rows = [];
        if (create) this.topRows.set(node.name, rows);
      }
      return rows;
    }
    if (!Array.isArray(level.own[node.name])) {
      if (!create) return [];
      level.own[node.name] = [];
    }
    return level.own[node.name];
  }

  // ---- scopes (the server's _Run, method for method)

  // Normalise answers and drop calculates, as the server does with every submission.
  #prepare(nodes, own, top) {
    for (const n of nodes) {
      const name = n.name;
      if (has(n, "calculate")) {
        delete own[name]; // calculates are always recomputed, never trusted
      } else if (n.type === "group") {
        this.#prepare(n.children ?? [], own, top);
      } else if (n.type === "repeat") {
        let rows;
        if (top) {
          if (!this.topRows.has(name)) this.topRows.set(name, []);
          rows = this.topRows.get(name);
        } else if (has(own, name)) {
          rows = own[name];
        } else {
          rows = [];
        }
        for (let i = 0; i < rows.length; i++) if (!isRecord(rows[i])) rows[i] = dict(); // keeps positions
        for (const row of rows) this.#prepare(n.children ?? [], row, false);
      } else if (n.type === "select_multiple" && Array.isArray(own[name])) {
        own[name] = own[name].map(String).join(" ");
      }
    }
  }

  #values(level) {
    if (level.siblings === null) {
      const vals = { ...level.own };
      for (const rep of this.topRepeats) Object.assign(vals, gather(rep.children ?? [], this.topRows.get(rep.name) ?? []));
      return vals;
    }
    return { ...level.outer, ...gather(level.nodes ?? [], level.siblings) };
  }

  #children(node, level) {
    const name = node.name;
    const rows = level.siblings === null ? (this.topRows.get(name) ?? []) : (Array.isArray(level.own[name]) ? level.own[name] : []);
    const outer = { ...this.#values(level), ...scalars(level.own) };
    return rows.map((row, i) => new Level(row, outer, i, `${level.prefix}${name}[${i + 1}]/`, rows, node.children ?? []));
  }

  #context(level, current = null) {
    const ctx = this.ctx;
    ctx.values = this.#values(level);
    ctx.current = current === undefined ? null : current;
    ctx.repeatIndex = level.index;
    return ctx;
  }

  #evaluate(expr, level, current = null) {
    return evaluate(expr, this.#context(level, current));
  }

  #relevant(node, level, record, sink) {
    try {
      return toBoolean(this.#evaluate(node.relevant, level));
    } catch (exc) {
      if (record) sink.push({ question: level.prefix + node.name, rule: "error", message: why("relevant", node.relevant, exc) });
      return true; // showing a question wrongly is recoverable, hiding one wrongly is not
    }
  }

  #message(node) {
    const msg = node.constraint_message;
    if (typeof msg === "string") return msg || null;
    if (isRecord(msg)) return translate(msg, this.lang, this.fallbackLang) || null;
    return null;
  }

  // ---- calculates, to a fixed point

  #countCalculates(nodes, own, top) {
    let total = 0;
    for (const n of nodes) {
      if (has(n, "calculate")) {
        total += 1;
      } else if (n.type === "group") {
        total += this.#countCalculates(n.children ?? [], own, top);
      } else if (n.type === "repeat") {
        const rows = top ? (this.topRows.get(n.name) ?? []) : (Array.isArray(own[n.name]) ? own[n.name] : []);
        for (const row of rows) total += this.#countCalculates(n.children ?? [], row, false);
      }
    }
    return total;
  }

  // Unset every calculate under a hidden node; true if any value was removed.
  #clearCalculates(nodes, level) {
    let changed = false;
    for (const node of nodes) {
      if (has(node, "calculate")) {
        const had = has(level.own, node.name) && level.own[node.name] !== null && level.own[node.name] !== undefined;
        delete level.own[node.name];
        changed = had || changed;
      } else if (node.type === "group") {
        changed = this.#clearCalculates(node.children ?? [], level) || changed;
      } else if (node.type === "repeat") {
        for (const child of this.#children(node, level)) {
          changed = this.#clearCalculates(node.children ?? [], child) || changed;
        }
      }
    }
    return changed;
  }

  #calcPass(nodes, level, record, sink) {
    let changed = false;
    for (const node of nodes) {
      const name = node.name;
      const isCalc = has(node, "calculate");
      if (!isCalc && node.relevant && !this.#relevant(node, level, false, sink)) {
        // a hidden group or repeat: its calculates are unset. An error in its relevant
        // is recorded once, by the walk.
        changed = this.#clearCalculates([node], level) || changed; // [node]: a hidden repeat's calculates live in its rows
        continue;
      }
      if (isCalc) {
        let result = null;
        if (!node.relevant || this.#relevant(node, level, record, sink)) {
          try {
            result = this.#evaluate(node.calculate, level);
          } catch (exc) {
            if (record) sink.push({ question: level.prefix + name, rule: "error", message: why("calculate", node.calculate, exc) });
          }
        }
        if (isBlank(result)) result = null;
        const old = has(level.own, name) ? level.own[name] : null;
        delete level.own[name];
        if (result !== null) level.own[name] = result;
        changed = changed || signature(old) !== signature(result);
      } else if (node.type === "group") {
        changed = this.#calcPass(node.children ?? [], level, record, sink) || changed;
      } else if (node.type === "repeat") {
        for (const child of this.#children(node, level)) {
          changed = this.#calcPass(node.children ?? [], child, record, sink) || changed;
        }
      }
    }
    return changed;
  }

  // Recompute every calculate until nothing changes, so declaration order is irrelevant.
  // (calculate instances in the whole form, rows included, hidden or not) + 1 passes are
  // enough for any acyclic form. Needing more means a cycle: the server raises, the phone
  // must not, so it reports an "error" failure and stops.
  #recompute() {
    this.ctx = new Context({ values: {}, now: this.nowOf(), ...(this.timezone === undefined ? {} : { timezone: this.timezone }) });
    this.settleFailures = [];
    this._errors = null;
    this.#prepare(this.nodes, this.data, true);
    const budget = this.#countCalculates(this.nodes, this.data, true) + 1;
    let changed = this.#calcPass(this.nodes, this.top, false, null);
    let passes = 1;
    while (changed) {
      if (passes >= budget) {
        this.settleFailures.push({ question: "", rule: "error", message: CYCLE_MESSAGE });
        return;
      }
      changed = this.#calcPass(this.nodes, this.top, false, null);
      passes += 1;
    }
    this.#calcPass(this.nodes, this.top, true, this.settleFailures); // settled: this pass only records errors
  }

  // ---- visibility and validation

  #visit(nodes, level, depth, out) {
    for (const node of nodes) {
      if (has(node, "calculate")) continue;
      if (node.relevant && !this.#relevant(node, level, false, null)) continue;
      const entry = { node, name: node.name, path: level.prefix + node.name, depth };
      if (node.type === "repeat") {
        const rows = this.#children(node, level);
        out.push({ ...entry, rowCount: rows.length });
        for (const child of rows) this.#visit(node.children ?? [], child, depth + 1, out);
      } else if (node.type === "group") {
        out.push(entry);
        this.#visit(node.children ?? [], level, depth + 1, out);
      } else {
        out.push(entry);
      }
    }
  }

  #walk(nodes, level) {
    for (const node of nodes) {
      if (has(node, "calculate")) continue;
      if (node.relevant && !this.#relevant(node, level, true, this._failures)) continue;
      if (node.type === "repeat") {
        for (const child of this.#children(node, level)) this.#walk(node.children ?? [], child);
      } else if (node.type === "group") {
        this.#walk(node.children ?? [], level);
      } else if (node.type !== "note") {
        this.#question(node, level);
      }
    }
  }

  #question(node, level) {
    const path = level.prefix + node.name;
    const value = has(level.own, node.name) ? level.own[node.name] : null;
    if (isBlank(value)) {
      if (node.required) this._failures.push({ question: path, rule: "required", message: null });
      return;
    }
    const expr = node.constraint;
    if (!expr) return;
    let ok;
    try {
      ok = toBoolean(this.#evaluate(expr, level, value));
    } catch (exc) {
      this._failures.push({ question: path, rule: "error", message: why("constraint", expr, exc) });
      return;
    }
    if (!ok) this._failures.push({ question: path, rule: "constraint", message: this.#message(node) });
  }
}
