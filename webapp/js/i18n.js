// Language switching for compiled form specs.
//
// A compiled spec always has `languages` and `default_language`, never empty: a form with
// no translations is `["default"]` and its labels are keyed "default". So callers read
// `label[lang]` for a `lang` from availableLanguages() with no single-language branch.
//
// Every translatable field (label, hint, constraint_message, a choice's label) is an object
// of language to text. translate() reads any of them; label() is translate() on `.label`.

const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

const nonEmpty = (v) => typeof v === "string" && v !== "";

// The text of one translatable value in `lang`. When `lang` has no (or an empty) entry,
// falls back to `fallback` (pass the spec's default language), then to "default", then to the
// first non-empty translation, then "". Never throws and never inherits from Object.prototype.
export function translate(value, lang, fallback) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  for (const key of [lang, fallback, "default"]) {
    const text = key === undefined || key === null ? undefined : own(value, key);
    if (nonEmpty(text)) return text;
  }
  for (const text of Object.values(value)) if (nonEmpty(text)) return text;
  return "";
}

// The label of a node (or choice) in `lang`. `fallback` is the spec's default language.
export function label(node, lang, fallback) {
  if (node === null || typeof node !== "object") return "";
  return translate(node.label, lang, fallback);
}

// The language a form falls back to: its declared default if it is a listed language,
// else the first listed, else "default".
export function defaultLanguage(spec) {
  const langs = listed(spec);
  const declared = spec && typeof spec === "object" ? spec.default_language : undefined;
  if (typeof declared === "string" && (langs.length === 0 || langs.includes(declared))) return declared;
  return langs[0] ?? "default";
}

function listed(spec) {
  const langs = spec && typeof spec === "object" && Array.isArray(spec.languages) ? spec.languages : [];
  return langs.filter((l) => typeof l === "string" && l !== "");
}

// The languages a form offers, default language first. A copy: callers may change it.
export function availableLanguages(spec) {
  const langs = listed(spec);
  if (langs.length === 0) return [typeof spec?.default_language === "string" && spec.default_language ? spec.default_language : "default"];
  const first = defaultLanguage(spec);
  return [first, ...langs.filter((l) => l !== first)];
}
