// XForm expression evaluator for the browser: a direct port of server/app/forms/expr.py.
//
// The phone and the server must give the same answer to every expression, or an
// enumerator's visit is accepted on one and rejected on the other. shared/expr_cases.json
// is read by both test suites; the rule book is the docstring of expr.py and
// shared/EXPR_CASES.md. If you change a rule, change the corpus first and both
// implementations second.
//
// THE LOUD-FAILURE RULE: anything outside the supported subset throws
// UnsupportedExpression while PARSING. Nothing parses to a quiet "true".
//
// Where JavaScript and Python differ, this file imitates Python on purpose:
//   * number -> text: Python's repr() of a float (1e+16, 1e-05, and "1000000000000000.0"
//     for whole numbers from 1e15 up to 1e16), not JavaScript's String().
//   * regex(): the pattern is parsed with Python's rules and re-emitted as a JavaScript
//     pattern that behaves the same (ASCII \s, '.' stops at \n only, '$' also matches
//     before a final \n, code points not UTF-16 units). See translateRegex().
//   * string-length counts code points; -0 is returned as 0; ${ } allows \f and \v.
//
// Dates come only from context.now. There is no ambient clock in this file.

export const MAX_NODES = 200;
export const MAX_DEPTH = 50;

const MICROS_PER_DAY = 86400000000n;

export class UnsupportedExpression extends Error {
  constructor(expression, reason) {
    super(`unsupported expression ${JSON.stringify(expression)}: ${reason}`);
    this.name = "UnsupportedExpression";
    this.expression = expression;
    this.reason = reason;
  }
}

export class ContextError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContextError";
  }
}

// ---------------------------------------------------------------- dates

// A calendar date (what today() returns): a day count since 1970-01-01.
export class DateValue {
  constructor(days) {
    this.days = days;
  }
  isoformat() {
    const [y, m, d] = civilFromDays(this.days);
    return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
  }
  toString() {
    return this.isoformat();
  }
  toJSON() {
    return this.isoformat();
  }
}

// An instant (what now() returns), always UTC; micros is a BigInt since the epoch.
export class DateTimeValue {
  constructor(micros) {
    this.micros = micros;
  }
  isoformat() {
    const days = floorDiv(this.micros, MICROS_PER_DAY);
    let rest = this.micros - days * MICROS_PER_DAY;
    const [y, m, d] = civilFromDays(Number(days));
    const micro = Number(rest % 1000000n);
    rest /= 1000000n;
    const secs = Number(rest);
    const hh = Math.floor(secs / 3600);
    const mm = Math.floor((secs % 3600) / 60);
    const ss = secs % 60;
    const frac = micro ? `.${pad(micro, 6)}` : "";
    return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}${frac}+00:00`;
  }
  toString() {
    return this.isoformat();
  }
  toJSON() {
    return this.isoformat();
  }
}

function pad(n, width) {
  return String(n).padStart(width, "0");
}

function floorDiv(a, b) {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

// Howard Hinnant's civil-calendar algorithms.
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

function daysInMonth(y, m) {
  if (m === 2) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function validDate(y, m, d) {
  return y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

const MAX_DAYS = daysFromCivil(9999, 12, 31);

// n / d for BigInts (d > 0), rounded once to the nearest double, ties to even.
// Python divides two timedeltas as exact integers; a plain Number(n) / Number(d) is
// only exact while n < 2**53, which stops being true around the year 2255.
function bigRatio(n, d) {
  if (n === 0n) return 0;
  const neg = n < 0n;
  if (neg) n = -n;
  const bits = (x) => x.toString(2).length;
  if (bits(n) <= 53 && bits(d) <= 53) return (neg ? -1 : 1) * (Number(n) / Number(d));
  let shift = Math.max(0, 55 - (bits(n) - bits(d)));
  const num = n << BigInt(shift);
  let q = num / d;
  const sticky = num % d !== 0n ? 1n : 0n;
  q = q * 2n + sticky;
  shift += 1;
  const drop = bits(q) - 53;
  let m = q >> BigInt(drop);
  const rem = q & ((1n << BigInt(drop)) - 1n);
  const half = 1n << BigInt(drop - 1);
  if (rem > half || (rem === half && (m & 1n) === 1n)) m += 1n;
  const out = Number(m) * 2 ** (drop - shift);
  return neg ? -out : out;
}

const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ISO_DATETIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:[0-9]{2})?$/;

// Mirrors datetime.fromisoformat for the strings ISO_DATETIME lets through (Python 3.14:
// hour 24 is accepted only as exactly 24:00[:00] and rolls to the next day; an offset's
// minutes may run to 99 provided the whole offset is under 24 hours; fractions beyond
// six digits are truncated). Returns null for anything Python refuses, else
// {micros, aware}.
function parseDateTime(s) {
  const m = ISO_DATETIME.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  let hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  const micro = m[7] === undefined ? 0 : Number(m[7].slice(0, 6).padEnd(6, "0"));
  if (!validDate(y, mo, d)) return null;
  let days = daysFromCivil(y, mo, d);
  if (hh === 24) {
    if (mi !== 0 || ss !== 0 || micro !== 0) return null;
    hh = 0;
    days += 1;
    if (days > MAX_DAYS) return null;
  } else if (hh > 23) {
    return null;
  }
  if (mi > 59 || ss > 59) return null;
  let offset = 0;
  const aware = m[8] !== undefined;
  if (aware && m[8] !== "Z") {
    offset = Number(m[8].slice(1, 3)) * 3600 + Number(m[8].slice(4, 6)) * 60;
    if (offset >= 86400) return null;
    if (m[8][0] === "-") offset = -offset;
  }
  const secs = BigInt(days) * 86400n + BigInt(hh * 3600 + mi * 60 + ss - offset);
  return { micros: secs * 1000000n + BigInt(micro), aware };
}

// ---------------------------------------------------------------- context

const formatters = new Map();

function zoneFormatter(timezone) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    formatters.set(timezone, f);
  }
  return f;
}

function checkTimezone(timezone) {
  const bad = () => new ContextError(`unknown timezone ${JSON.stringify(timezone)}`);
  // IANA names are case sensitive and every path segment starts with a capital
  // (Asia/Kolkata, Etc/GMT+5, UTC). Intl accepts any case, so refuse the lowercase starts.
  if (typeof timezone !== "string" || !/^[A-Z][A-Za-z0-9_+\-]*(?:\/[A-Z][A-Za-z0-9_+\-]*)*$/.test(timezone)) throw bad();
  let resolved;
  try {
    resolved = zoneFormatter(timezone).resolvedOptions().timeZone;
  } catch {
    throw bad();
  }
  if (resolved.toLowerCase() === timezone.toLowerCase() && resolved !== timezone) throw bad();
}

export class Context {
  constructor({ values, current = null, now, repeatIndex = 0, timezone = "Asia/Kolkata" } = {}) {
    checkTimezone(timezone);
    this.timezone = timezone;
    this.values = values === undefined || values === null ? {} : values;
    if (typeof this.values !== "object" || Array.isArray(this.values)) {
      throw new ContextError("Context.values must be an object of field name to value");
    }
    this.current = current === undefined ? null : current;
    this.repeatIndex = repeatIndex;
    this.nowMicros = Context.#instant(now);
  }

  static #instant(now) {
    if (now instanceof Date) {
      if (Number.isNaN(now.getTime())) throw new ContextError("Context.now is an invalid Date");
      return BigInt(now.getTime()) * 1000n;
    }
    if (typeof now === "string") {
      const parsed = parseDateTime(now);
      if (parsed && parsed.aware) return parsed.micros;
    }
    throw new ContextError("Context.now must be a Date or an ISO datetime with a UTC offset (a naive time is refused, not guessed)");
  }
}

// ---------------------------------------------------------------- tokenizer

const FUNCTIONS = {
  // name: [min args, max args or null, positions that must be ${field} references]
  not: [1, 1, []],
  selected: [2, 2, []],
  count: [1, 1, [0]],
  "count-selected": [1, 1, []],
  sum: [1, 1, [0]],
  if: [3, 3, []],
  "string-length": [0, 1, []],
  regex: [2, 2, []],
  concat: [1, null, []],
  number: [0, 1, []],
  int: [1, 1, []],
  true: [0, 0, []],
  false: [0, 0, []],
  today: [0, 0, []],
  now: [0, 0, []],
  coalesce: [1, null, []],
  position: [0, 0, []],
  "indexed-repeat": [3, 3, [0, 1]],
};

// Python's _REF uses \s under re.ASCII, which includes form feed and vertical tab,
// while its tokenizer's _SPACE does not. Both are reproduced exactly.
const REF = /\$\{[ \t\n\r\f\v]*([A-Za-z_][A-Za-z0-9_.\-]*)[ \t\n\r\f\v]*\}/y;
const NUMBER = /[0-9]+(?:\.[0-9]*)?|\.[0-9]+/y;
const NAME = /[A-Za-z_][A-Za-z0-9_.\-]*/y;
const SPACE = " \t\r\n";
const WORD_OPERATORS = new Set(["and", "or", "div", "mod"]);
const REJECTED_CHARS = {
  "/": "XPath paths are not supported; write fields as ${name}",
  "[": "predicates are not supported",
  "]": "predicates are not supported",
  "@": "attributes are not supported",
  "|": "the union operator is not supported",
  $: "variables are not supported; write fields as ${name}",
  ":": "XPath axes and namespaces are not supported",
};

const isDigit = (ch) => ch !== undefined && ch >= "0" && ch <= "9";
const isLetter = (ch) => ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_");

function tokenize(expr) {
  const tokens = [];
  const n = expr.length;
  let i = 0;
  while (i < n) {
    const ch = expr[i];
    if (SPACE.includes(ch)) {
      i += 1;
    } else if (ch === "$") {
      REF.lastIndex = i;
      const m = REF.exec(expr);
      if (!m) {
        if (expr.startsWith("${", i) && expr.slice(i).split("}", 1)[0].includes("/")) {
          throw new UnsupportedExpression(expr, "paths inside ${...} are not supported; use the plain field name");
        }
        throw new UnsupportedExpression(expr, "malformed ${field} reference");
      }
      tokens.push(["ref", m[1]]);
      i = REF.lastIndex;
    } else if (ch === "'" || ch === '"') {
      const end = expr.indexOf(ch, i + 1);
      if (end < 0) throw new UnsupportedExpression(expr, "unterminated string literal");
      tokens.push(["str", expr.slice(i + 1, end)]);
      i = end + 1;
    } else if (isDigit(ch) || (ch === "." && i + 1 < n && isDigit(expr[i + 1]))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(expr);
      if (!m) throw new UnsupportedExpression(expr, `malformed number at position ${i}`);
      const start = i;
      i = NUMBER.lastIndex;
      if (i < n && isLetter(expr[i])) {
        throw new UnsupportedExpression(expr, `malformed number near ${JSON.stringify(expr.slice(start, i + 1))}`);
      }
      tokens.push(["num", Number(m[0])]);
    } else if (ch === ".") {
      if (expr.startsWith("..", i)) throw new UnsupportedExpression(expr, "the parent step '..' is not supported");
      tokens.push(["cur", "."]);
      i += 1;
    } else if (isLetter(ch)) {
      NAME.lastIndex = i;
      const m = NAME.exec(expr);
      if (!m) throw new UnsupportedExpression(expr, `unexpected character ${JSON.stringify(ch)}`);
      const end = NAME.lastIndex;
      if (expr.startsWith("::", end)) throw new UnsupportedExpression(expr, "XPath axes are not supported");
      tokens.push(["name", m[0]]);
      i = end;
    } else if (expr.startsWith("!=", i) || expr.startsWith("<=", i) || expr.startsWith(">=", i)) {
      tokens.push(["op", expr.slice(i, i + 2)]);
      i += 2;
    } else if ("=<>+-*".includes(ch)) {
      tokens.push(["op", ch]);
      i += 1;
    } else if ("(),".includes(ch)) {
      tokens.push([ch, ch]);
      i += 1;
    } else if (Object.hasOwn(REJECTED_CHARS, ch)) {
      throw new UnsupportedExpression(expr, REJECTED_CHARS[ch]);
    } else {
      throw new UnsupportedExpression(expr, `unexpected character ${JSON.stringify(ch)}`);
    }
  }
  tokens.push(["end", null]);
  return tokens;
}

// ---------------------------------------------------------------- parser
//
// Tree nodes are plain objects: {type: "num"|"str"|"ref"|"prop"|"current"|"unary"|
// "binary"|"call", ...}. Precedence, lowest to highest: or, and, comparison (ONE
// left-associative level, unlike XPath), + -, * div mod, unary -, primary.

class Parser {
  constructor(expr, props = false) {
    this.expr = expr;
    this.props = props;
    this.tokens = tokenize(expr);
    this.pos = 0;
    this.depth = 0;
    this.nodes = 0;
  }

  fail(reason) {
    return new UnsupportedExpression(this.expr, reason);
  }

  peek() {
    return this.tokens[this.pos];
  }

  take() {
    const tok = this.tokens[this.pos];
    this.pos += 1;
    return tok;
  }

  atOp(...ops) {
    const [kind, value] = this.peek();
    if (kind === "op" && ops.includes(value)) return true;
    return kind === "name" && ops.includes(value) && WORD_OPERATORS.has(value);
  }

  node(node) {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) throw this.fail(`expression is too large (more than ${MAX_NODES} parts)`);
    return node;
  }

  enter() {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw this.fail("expression is nested too deeply");
  }

  parse() {
    if (this.peek()[0] === "end") throw this.fail("expression is empty");
    const tree = this.parseOr();
    const [kind, value] = this.peek();
    if (kind !== "end") throw this.fail(`unexpected ${JSON.stringify(value)} after a complete expression`);
    return tree;
  }

  binary(operators, lower) {
    let left = lower();
    while (this.atOp(...operators)) {
      const op = this.take()[1];
      left = this.node({ type: "binary", op, left, right: lower() });
    }
    return left;
  }

  parseOr() {
    this.enter();
    try {
      return this.binary(["or"], () => this.parseAnd());
    } finally {
      this.depth -= 1;
    }
  }

  parseAnd() {
    return this.binary(["and"], () => this.parseComparison());
  }

  parseComparison() {
    return this.binary(["=", "!=", "<", "<=", ">", ">="], () => this.parseAdditive());
  }

  parseAdditive() {
    return this.binary(["+", "-"], () => this.parseMultiplicative());
  }

  parseMultiplicative() {
    return this.binary(["*", "div", "mod"], () => this.parseUnary());
  }

  parseUnary() {
    if (this.atOp("-")) {
      this.take();
      this.enter();
      try {
        return this.node({ type: "unary", op: "-", operand: this.parseUnary() });
      } finally {
        this.depth -= 1;
      }
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const [kind, value] = this.take();
    if (kind === "num") return this.node({ type: "num", value });
    if (kind === "str") return this.node({ type: "str", value });
    if (kind === "ref") return this.node({ type: "ref", name: value });
    if (kind === "cur") return this.node({ type: "current" });
    if (kind === "(") {
      const inner = this.parseOr();
      if (this.take()[0] !== ")") throw this.fail("missing closing parenthesis");
      return inner;
    }
    if (kind === "name") {
      if (this.peek()[0] !== "(") {
        if (this.props) return this.node({ type: "prop", name: value });
        throw this.fail(`bare name ${JSON.stringify(value)}: fields must be written \${${value}}`);
      }
      return this.parseCall(value);
    }
    if (kind === "end") throw this.fail("expression ends unexpectedly");
    throw this.fail(`unexpected ${JSON.stringify(value)}`);
  }

  parseCall(name) {
    if (!Object.hasOwn(FUNCTIONS, name)) throw this.fail(`function ${name}() is not supported`);
    this.take(); // "("
    const args = [];
    if (this.peek()[0] !== ")") {
      for (;;) {
        args.push(this.parseOr());
        if (this.peek()[0] === ",") {
          this.take();
          continue;
        }
        break;
      }
    }
    if (this.take()[0] !== ")") throw this.fail(`missing closing parenthesis in ${name}()`);
    const [low, high, refPositions] = FUNCTIONS[name];
    if (args.length < low || (high !== null && args.length > high)) {
      const expected = low === high ? String(low) : `${low} to ${high !== null ? high : "any number of"}`;
      throw this.fail(`${name}() takes ${expected} argument(s), got ${args.length}`);
    }
    for (const position of refPositions) {
      if (args[position].type !== "ref") {
        throw this.fail(`argument ${position + 1} of ${name}() must be a \${field} reference`);
      }
    }
    const call = { type: "call", name, args };
    if (name === "regex") call.compiled = this.checkPattern(args[1]);
    return this.node(call);
  }

  checkPattern(arg) {
    if (arg.type !== "str") throw this.fail("regex() pattern must be a string literal");
    const pattern = arg.value;
    // Same scan as Python's re.finditer(r"\(\?(.?)", pattern): '.' stops at \n only.
    for (const m of pattern.matchAll(/\(\?([^\n]?)/g)) {
      if (m[1] !== ":" && m[1] !== "=" && m[1] !== "!") {
        throw this.fail("regex() pattern uses syntax that browsers and the server do not share");
      }
    }
    let source;
    try {
      source = translateRegex(pattern);
    } catch (e) {
      if (e instanceof PatternError) throw this.fail(`regex() pattern is invalid: ${e.message}`);
      throw this.fail("regex() pattern is too complex to check");
    }
    try {
      return new RegExp(`^(?:${source})$`, "u");
    } catch (e) {
      throw this.fail(`regex() pattern is invalid: ${e.message}`);
    }
  }
}

const parseCache = new Map();
const filterCache = new Map();
const CACHE_LIMIT = 2048;

function cached(cache, expression, props) {
  if (typeof expression !== "string") {
    throw new UnsupportedExpression(String(expression), "expression must be text");
  }
  let tree = cache.get(expression);
  if (!tree) {
    tree = new Parser(expression, props).parse();
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(expression, tree);
  }
  return tree;
}

// Parse an expression, throwing UnsupportedExpression for anything outside the subset.
export function parse(expression) {
  return cached(parseCache, expression, false);
}

// Parse a choice_filter. Two namespaces: a bare name (`district`) is a column of the
// choice being filtered (a "prop" node) and ${name} is a form field (a "ref" node).
// Everything else is exactly as in parse(); parse() itself still rejects bare names.
export function parseChoiceFilter(expression) {
  return cached(filterCache, expression, true);
}

// ---------------------------------------------------------------- regex
//
// regex() takes a Python pattern (the server's dialect, re.ASCII, fullmatch) and must
// behave identically in a browser. translateRegex() reads the pattern the way Python's
// sre_parse does, rejects what Python rejects, and re-emits it for a JavaScript RegExp
// in unicode mode (so '.' and classes work on code points, like Python). Every literal
// is emitted as \u{...}, so nothing the pattern says can change meaning in translation.
//
// Differences from plain JS that this fixes:
//   \s \S      JS matches Unicode space (U+00A0 ...); Python ASCII matches [ \t\n\r\f\v].
//   .          JS stops at \r U+2028 U+2029 too; Python stops at \n only.
//   $          JS: end only; Python: end, or before a final \n.
//   \A \Z \z   JS treats them as the letters A, Z, z; Python anchors.
//   \a \U..    JS: the letters; Python: bell, an 8-digit code point.
//   { } ]      lone ones are literals in Python, errors in JS unicode mode.
//   {,n}       a quantifier in Python, literal text in JS.
// Refused here, though Python accepts them (the server should refuse them too; see
// the task report): possessive quantifiers a*+, backreferences \1, \N{name}.

class PatternError extends Error {}

const MAXREPEAT = 4294967295; // Python's cap; above it Python raises OverflowError
const ASCII_WS_CLASS = "\\u{20}\\u{9}\\u{a}\\u{b}\\u{c}\\u{d}";
const ASCII_NONWS_CLASS = "\\u{0}-\\u{8}\\u{e}-\\u{1f}\\u{21}-\\u{10ffff}";
const HEX = /^[0-9a-fA-F]$/;
const isOct = (ch) => ch !== undefined && ch >= "0" && ch <= "7";
const lit = (cp) => `\\u{${cp.toString(16)}}`;
const SIMPLE_ESCAPES = { a: 7, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92 };

function translateRegex(pattern) {
  const cps = Array.from(pattern);
  let pos = 0;
  let opened = 0; // capturing groups opened so far
  const next = () => cps[pos];
  const get = () => cps[pos++];
  const match = (ch) => {
    if (cps[pos] === ch) {
      pos += 1;
      return true;
    }
    return false;
  };
  const getWhile = (limit, ok) => {
    let out = "";
    while (out.length < limit && cps[pos] !== undefined && ok(cps[pos])) out += cps[pos++];
    return out;
  };
  const fail = (m) => {
    throw new PatternError(m);
  };

  // Escapes valid both inside and outside a class. Returns a code point, or null when
  // the caller must handle the escape (a category). `c` is the character after "\".
  function codeEscape(c) {
    if (Object.hasOwn(SIMPLE_ESCAPES, c)) return SIMPLE_ESCAPES[c];
    if (c === "x") {
      const h = getWhile(2, (x) => HEX.test(x));
      if (h.length !== 2) fail("incomplete escape \\x");
      return parseInt(h, 16);
    }
    if (c === "u") {
      const h = getWhile(4, (x) => HEX.test(x));
      if (h.length !== 4) fail("incomplete escape \\u");
      return parseInt(h, 16);
    }
    if (c === "U") {
      const h = getWhile(8, (x) => HEX.test(x));
      if (h.length !== 8) fail("incomplete escape \\U");
      const v = parseInt(h, 16);
      if (v > 0x10ffff) fail("bad escape \\U (value outside the Unicode range)");
      return v;
    }
    if (c === "N") fail("\\N{name} escapes are not supported here");
    return null;
  }

  function classEscape() {
    const c = get();
    if (c === undefined) fail("bad escape (end of pattern)");
    if (c === "b") return { cp: 8 };
    if ("dDsSwW".includes(c)) return { cat: c };
    const code = codeEscape(c);
    if (code !== null) return { cp: code };
    if (isOct(c)) {
      const v = parseInt(c + getWhile(2, isOct), 8);
      if (v > 0o377) fail("octal escape value outside of range 0-0o377");
      return { cp: v };
    }
    if (isDigit(c)) fail(`bad escape \\${c}`);
    if (isLetter(c) && c !== "_") fail(`bad escape \\${c}`);
    return { cp: c.codePointAt(0) };
  }

  function categorySource(cat, inClass) {
    switch (cat) {
      case "d":
      case "D":
      case "w":
      case "W":
        return `\\${cat}`;
      case "s":
        return inClass ? ASCII_WS_CLASS : `[${ASCII_WS_CLASS}]`;
      default: // "S"
        return inClass ? ASCII_NONWS_CLASS : `[^${ASCII_WS_CLASS}]`;
    }
  }

  function parseClass() {
    const negate = match("^");
    const items = [];
    let count = 0;
    for (;;) {
      let this_ = get();
      if (this_ === undefined) fail("unterminated character set");
      if (this_ === "]" && count > 0) break;
      let code1;
      if (this_ === "\\") code1 = classEscape();
      else code1 = { cp: this_.codePointAt(0) };
      count += 1;
      if (match("-")) {
        let that = get();
        if (that === undefined) fail("unterminated character set");
        if (that === "]") {
          items.push(code1.cat ? categorySource(code1.cat, true) : lit(code1.cp));
          items.push(lit(45));
          break;
        }
        const code2 = that === "\\" ? classEscape() : { cp: that.codePointAt(0) };
        if (code1.cat || code2.cat || code2.cp < code1.cp) fail("bad character range");
        items.push(`${lit(code1.cp)}-${lit(code2.cp)}`);
      } else {
        items.push(code1.cat ? categorySource(code1.cat, true) : lit(code1.cp));
      }
    }
    return `[${negate ? "^" : ""}${items.join("")}]`;
  }

  // Reads {m}, {m,}, {,n}, {m,n}; null (position restored) when it is just a literal "{".
  function parseBraces() {
    const here = pos;
    if (next() === "}") return null; // "{}" is literal
    const lo = getWhile(Infinity, isDigit);
    let hi = lo;
    let comma = false;
    if (match(",")) {
      comma = true;
      hi = getWhile(Infinity, isDigit);
    }
    if (!match("}")) {
      pos = here;
      return null;
    }
    const min = lo ? Number(lo) : 0;
    const max = comma ? (hi ? Number(hi) : null) : min;
    if (min >= MAXREPEAT || (max !== null && max >= MAXREPEAT)) fail("the repetition number is too large");
    if (max !== null && max < min) fail("min repeat greater than max repeat");
    return max === null ? `{${min},}` : min === max ? `{${min}}` : `{${min},${max}}`;
  }

  // sre_parse's _parse: one alternative. Each item is {src, kind}; kind decides whether
  // a following quantifier is legal ("at" and "repeat" items cannot be repeated).
  function parseBranch(nested) {
    const items = [];
    for (;;) {
      const ch = next();
      if (ch === undefined || ch === "|" || ch === ")") break;
      pos += 1;
      if (ch === "\\") {
        const c = get();
        if (c === undefined) fail("bad escape (end of pattern)");
        if (c === "A") items.push({ src: "^", kind: "at" });
        else if (c === "Z" || c === "z") items.push({ src: "$", kind: "at" });
        else if (c === "b" || c === "B") items.push({ src: `\\${c}`, kind: "at" });
        else if ("dDsSwW".includes(c)) items.push({ src: categorySource(c, false), kind: "atom" });
        else {
          const code = codeEscape(c);
          if (code !== null) items.push({ src: lit(code), kind: "atom" });
          else if (c === "0") {
            items.push({ src: lit(parseInt("0" + getWhile(2, isOct), 8)), kind: "atom" });
          } else if (isDigit(c)) {
            let digits = c;
            if (isDigit(next())) {
              digits += get();
              if (isOct(digits[0]) && isOct(digits[1]) && isOct(next())) {
                digits += get();
                const v = parseInt(digits, 8);
                if (v > 0o377) fail("octal escape value outside of range 0-0o377");
                items.push({ src: lit(v), kind: "atom" });
                continue;
              }
            }
            const group = Number(digits);
            if (group <= opened) fail("backreferences are not supported");
            fail(`invalid group reference ${group}`);
          } else if (isLetter(c) && c !== "_") fail(`bad escape \\${c}`);
          else items.push({ src: lit(c.codePointAt(0)), kind: "atom" });
        }
      } else if (ch === "[") {
        items.push({ src: parseClass(), kind: "atom" });
      } else if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
        let quant;
        if (ch === "{") {
          quant = parseBraces();
          if (quant === null) {
            items.push({ src: lit(123), kind: "atom" });
            continue;
          }
        } else {
          quant = ch;
        }
        const item = items[items.length - 1];
        if (!item || item.kind === "at") fail("nothing to repeat");
        if (item.kind === "repeat") fail("multiple repeat");
        let suffix = "";
        if (match("?")) suffix = "?";
        else if (next() === "+") fail("possessive quantifiers are not supported");
        const base = item.kind === "assert" ? `(?:${item.src})` : item.src;
        items[items.length - 1] = { src: base + quant + suffix, kind: "repeat" };
      } else if (ch === ".") {
        items.push({ src: "[^\\n]", kind: "atom" });
      } else if (ch === "(") {
        let prefix = "(";
        let kind = "atom";
        if (match("?")) {
          const flag = get();
          if (flag === ":") prefix = "(?:";
          else if (flag === "=" || flag === "!") {
            prefix = `(?${flag}`;
            kind = "assert";
          } else fail("unsupported group syntax");
        } else {
          opened += 1;
        }
        const body = parseAlternatives(nested + 1);
        if (!match(")")) fail("missing ), unterminated subpattern");
        items.push({ src: `${prefix}${body})`, kind });
      } else if (ch === "^") {
        items.push({ src: "^", kind: "at" });
      } else if (ch === "$") {
        items.push({ src: "(?=\\n?$)", kind: "at" });
      } else {
        items.push({ src: lit(ch.codePointAt(0)), kind: "atom" });
      }
    }
    return items.map((it) => it.src).join("");
  }

  function parseAlternatives(nested) {
    const branches = [parseBranch(nested)];
    while (match("|")) branches.push(parseBranch(nested));
    return branches.join("|");
  }

  const source = parseAlternatives(0);
  if (pos < cps.length) fail("unbalanced parenthesis");
  return source;
}

// ---------------------------------------------------------------- coercion

const NUMERIC = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;
const isNumber = (v) => typeof v === "number";
const isTemporal = (v) => v instanceof DateValue || v instanceof DateTimeValue;
const isNaNNumber = (v) => typeof v === "number" && Number.isNaN(v);

function trimAscii(s) {
  let a = 0;
  let b = s.length;
  while (a < b && SPACE.includes(s[a])) a += 1;
  while (b > a && SPACE.includes(s[b - 1])) b -= 1;
  return s.slice(a, b);
}

// A raw value from the caller becomes one of: null, string, boolean, number, DateValue,
// DateTimeValue. A JS Date is an instant; everything else is a TypeError, as in Python.
function lift(v) {
  if (v === undefined) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new TypeError("cannot use an invalid Date as a form value");
    return new DateTimeValue(BigInt(v.getTime()) * 1000n);
  }
  return v;
}

export function toNumber(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return NaN;
  if (typeof v === "string") {
    const s = trimAscii(v);
    if (NUMERIC.test(s)) return Number(s);
    if (ISO_DATE.test(s)) {
      const y = Number(s.slice(0, 4));
      const m = Number(s.slice(5, 7));
      const d = Number(s.slice(8, 10));
      return validDate(y, m, d) ? daysFromCivil(y, m, d) : NaN;
    }
    const dt = parseDateTime(s);
    if (dt && dt.aware) return bigRatio(dt.micros, MICROS_PER_DAY);
    return NaN;
  }
  if (v instanceof DateTimeValue) return bigRatio(v.micros, MICROS_PER_DAY);
  if (v instanceof DateValue) return v.days;
  throw new TypeError(`cannot use a ${typeof v} as a form value`);
}

// Python's repr() of a finite float.
function pyFloatRepr(x) {
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const neg = x < 0;
  const [mantissa, exponent] = Math.abs(x).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exp = Number(exponent);
  let out;
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    out = `${m}e${exp < 0 ? "-" : "+"}${pad(Math.abs(exp), 2)}`;
  } else if (exp >= 0) {
    out = `${digits.slice(0, exp + 1).padEnd(exp + 1, "0")}.${digits.slice(exp + 1) || "0"}`;
  } else {
    out = `0.${"0".repeat(-exp - 1)}${digits}`;
  }
  return neg ? `-${out}` : out;
}

export function toString(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
    if (v === Math.trunc(v) && Math.abs(v) < 1e15) return String(Math.trunc(v));
    return pyFloatRepr(v);
  }
  if (isTemporal(v)) return v.isoformat();
  throw new TypeError(`cannot use a ${typeof v} as a form value`);
}

export function toBoolean(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return !(Number.isNaN(v) || v === 0);
  if (typeof v === "string") return v.length > 0;
  return true;
}

function isEmpty(v) {
  return v === null || v === undefined || v === "" || isNaNNumber(v);
}

function compare(op, left, right) {
  if (op === "=" || op === "!=") {
    let equal;
    if (typeof left === "boolean" || typeof right === "boolean") equal = toBoolean(left) === toBoolean(right);
    else if (isNumber(left) || isNumber(right) || isTemporal(left) || isTemporal(right)) equal = toNumber(left) === toNumber(right);
    else equal = toString(left) === toString(right);
    return op === "=" ? equal : !equal;
  }
  const a = toNumber(left);
  const b = toNumber(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  if (op === ">") return a > b;
  return a >= b;
}

function arithmetic(op, left, right) {
  const a = toNumber(left);
  const b = toNumber(right);
  if (op === "+") return a + b;
  if (op === "-") return a - b;
  if (op === "*") return a * b;
  if (b === 0 || Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return op === "div" ? a / b : a % b; // % is fmod: the sign of the dividend
}

// ---------------------------------------------------------------- walker

const own = (obj, name) => (Object.hasOwn(obj, name) ? obj[name] : undefined);

function raw(ctx, name) {
  return own(ctx.values, name);
}

// A field as a single value: a repeated field reads the current row.
function scalar(ctx, name) {
  let v = raw(ctx, name);
  if (Array.isArray(v)) v = ctx.repeatIndex >= 0 && ctx.repeatIndex < v.length ? v[ctx.repeatIndex] : null;
  v = lift(v);
  return v === null ? "" : v;
}

function nodeset(ctx, name) {
  const v = raw(ctx, name);
  if (Array.isArray(v)) return v.map(lift);
  return isEmpty(v) ? [] : [lift(v)];
}

// Split a select_multiple answer on ASCII whitespace only (a no-break space is not a separator).
function tokens(text) {
  return text.split(/[ \t\r\n]+/).filter((t) => t !== "");
}

function codePointLength(text) {
  let n = 0;
  for (const _ of text) n += 1; // eslint-disable-line no-unused-vars
  return n;
}

function run(node, ctx, props) {
  switch (node.type) {
    case "num":
    case "str":
      return node.value;
    case "ref":
      return scalar(ctx, node.name);
    case "prop": {
      // A column of the choice being filtered. Absent reads as the empty string. Props
      // are text, so they compare as strings unless the other side is a number or date.
      const v = props ? lift(own(props, node.name)) : null;
      return v === null ? "" : v;
    }
    case "current": {
      const v = lift(ctx.current);
      return v === null ? "" : v;
    }
    case "unary":
      return -toNumber(run(node.operand, ctx, props));
    case "binary": {
      const op = node.op;
      if (op === "or") return toBoolean(run(node.left, ctx, props)) || toBoolean(run(node.right, ctx, props));
      if (op === "and") return toBoolean(run(node.left, ctx, props)) && toBoolean(run(node.right, ctx, props));
      const left = run(node.left, ctx, props);
      const right = run(node.right, ctx, props);
      if (op === "=" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") return compare(op, left, right);
      return arithmetic(op, left, right);
    }
    case "call":
      return call(node, ctx, props);
    default:
      throw new TypeError(`unknown node ${node.type}`);
  }
}

function call(node, ctx, props) {
  const { name, args } = node;
  const arg = (i) => run(args[i], ctx, props);
  switch (name) {
    case "if":
      return toBoolean(arg(0)) ? arg(1) : arg(2);
    case "not":
      return !toBoolean(arg(0));
    case "selected":
      return tokens(toString(arg(0))).includes(toString(arg(1)));
    case "count-selected":
      return tokens(toString(arg(0))).length;
    case "count":
      return nodeset(ctx, args[0].name).length;
    case "sum": {
      const numbers = nodeset(ctx, args[0].name)
        .filter((r) => !isEmpty(r))
        .map(toNumber);
      if (numbers.some(Number.isNaN)) return NaN;
      let total = 0;
      for (const x of numbers) total += x; // left to right, no compensated summation
      return total;
    }
    case "string-length": {
      const text = toString(args.length === 0 ? run({ type: "current" }, ctx, props) : arg(0));
      return codePointLength(text);
    }
    case "regex":
      return node.compiled.test(toString(arg(0)));
    case "concat":
      return args.map((a) => toString(run(a, ctx, props))).join("");
    case "number":
      return toNumber(args.length === 0 ? run({ type: "current" }, ctx, props) : arg(0));
    case "int": {
      const n = toNumber(arg(0));
      return Number.isFinite(n) ? Math.trunc(n) + 0 : n; // + 0 turns -0 into 0
    }
    case "today":
      return new DateValue(todayDays(ctx));
    case "true":
      return true;
    case "false":
      return false;
    case "now":
      return new DateTimeValue(ctx.nowMicros);
    case "coalesce":
      for (const a of args) {
        const v = run(a, ctx, props);
        if (!isEmpty(v)) return v;
      }
      return "";
    case "position":
      return ctx.repeatIndex + 1;
    case "indexed-repeat": {
      const n = toNumber(arg(2));
      if (Number.isNaN(n) || n !== Math.trunc(n)) return "";
      let rows = raw(ctx, args[0].name);
      if (!Array.isArray(rows)) rows = rows === null || rows === undefined ? [] : [rows];
      const index = n - 1; // may be huge or infinite: then it is simply out of range
      if (index >= 0 && index < rows.length) {
        const v = lift(rows[index]);
        if (v !== null) return v;
      }
      return "";
    }
    default:
      throw new TypeError(`unknown function ${name}`); // unreachable: parse() checks the name
  }
}

// The calendar date of context.now in context.timezone (not the host's zone).
function todayDays(ctx) {
  const ms = Number(floorDiv(ctx.nowMicros, 1000n));
  const parts = zoneFormatter(ctx.timezone).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return daysFromCivil(get("year"), get("month"), get("day"));
}

function finish(result) {
  return result === 0 ? 0 : result; // -0 becomes 0: Python returns the integer 0
}

function asContext(context) {
  return context instanceof Context ? context : new Context(context);
}

// Evaluate `expression`. Throws UnsupportedExpression if it cannot be parsed, and
// ContextError if the context is unusable (naive `now`, unknown timezone).
export function evaluate(expression, context) {
  const ctx = asContext(context);
  return finish(run(parse(expression), ctx, null));
}

// Evaluate a choice_filter for one candidate choice. `props` is that choice's props
// object from the JSON spec. A choice is shown when toBoolean(result) is true.
export function evaluateChoiceFilter(expression, context, props = {}) {
  const ctx = asContext(context);
  return finish(run(parseChoiceFilter(expression), ctx, props));
}
