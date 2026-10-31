"""XForm XML to the compact JSON form spec the offline app reads (spec section 3).

Pure logic: no database, no web framework. The XML stays the canonical artifact;
this is a one-way projection of it for the browser.

THE LOUD-FAILURE RULE
    Every `relevant`, `constraint`, `calculate`, `repeat_count` and `choice_filter`
    is run through `expr.parse()` here, at publish time. An expression the
    evaluator cannot parse raises `UnsupportedExpression` carrying the name of the
    question (the spreadsheet row) to fix. Constructs this compiler cannot carry
    faithfully (unknown question types, dynamic defaults, computed `required`)
    raise `FormCompileError` instead of being dropped.

EXPRESSION FORM
    pyxform rewrites `${field}` into XPath paths (`/data/a/b`, `../b`). Those are
    turned back into `${b}`: the spec addresses fields by flat name, and the engine
    resolves the name against the current repeat row first, then outward
    (INNER-ROW-FIRST), then the top level of the form.
    That rule is only safe because of the DUPLICATE-NAME GUARD: a field name may
    appear once in the whole form, across groups, repeats and nesting levels, or
    compilation raises `FormCompileError` naming both locations. So `${x}` always
    means the one field called x; inner-row-first only decides WHICH ROW of a
    repeat is read, never which of two fields. Read the two together.

CHOICE FILTER
    pyxform moves `choice_filter` out of the bind into an XPath predicate on the
    itemset nodeset: `instance('block')/root/item[district= /data/district ]`.
    The predicate is extracted and converted back to `district = ${district}`.
    A bare name on the left (`district`) is a PROPERTY OF THE CHOICE being
    filtered, read from that choice's `props`; `${...}` is a form field. The string
    is validated with `expr.parse_choice_filter()` (bare names allowed) and emitted
    exactly as validated; plain `parse()` still rejects it.

CALCULATE CYCLES
    The dependency graph of the calculates (each one's `${field}` references in its
    formula and its `relevant`, restricted to other calculates) must be acyclic, or
    compilation raises `FormCompileError` naming the fields in the cycle. Without this a
    cycle such as a = ${b} + 1, b = ${a} + 1 settles quietly at NaN on both the phone
    and the server. validate.py keeps its own CalculateCycleError as defence in depth.

LANGUAGES
    `languages` and `default_language` are never empty: a form with no itext
    translations gets `["default"]` / `"default"`, and its labels are keyed
    `"default"`. Consumers always read `label[lang]` for a `lang` from `languages`.
    Language codes are short (`hi (Hindi)` and `Hindi (hi)` both give `hi`); two
    translations that shorten to the same code are refused, not merged.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any

from app.forms.expr import UnsupportedExpression, parse, parse_choice_filter

XF = "{http://www.w3.org/2002/xforms}"
H = "{http://www.w3.org/1999/xhtml}"
JR = "{http://openrosa.org/javarosa}"

_NAME = r"[A-Za-z_][\w.\-]*"
_ITEXT_REF = re.compile(r"^jr:itext\('([^']*)'\)$")
_ITEMSET = re.compile(r"^instance\('([^']+)'\)/root/item(?:\[(.*)\])?$", re.DOTALL)
_LANG = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_\-]*)")
_CONTROLS = {"input", "select1", "select", "upload"}
_UNSUPPORTED_CONTROLS = {"range", "rank", "trigger"}
_BIND_TYPES = {
    "int": "integer", "decimal": "decimal", "date": "date", "time": "time",
    "dateTime": "dateTime", "geopoint": "geopoint", "barcode": "barcode",
}
_CODE = re.compile(r"^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$")
_PAREN = re.compile(r"\(([^()]*)\)")


class FormCompileError(ValueError):
    """The form uses something the compiler cannot carry into the spec faithfully."""


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _short(lang: str) -> str:
    """'hi (Hindi)' and 'Hindi (hi)' -> 'hi'. Prefer the leading token when it looks
    like a language code, else a parenthesised code, else the leading token."""
    m = _LANG.match(lang)
    lead = m.group(1) if m else lang.strip()
    if _CODE.match(lead):
        return lead
    for p in _PAREN.findall(lang):
        if _CODE.match(p.strip()):
            return p.strip()
    return lead


# ------------------------------------------------------------ expressions

_PATTERNS = [
    re.compile(rf"current\(\)/(?:\.\./)*({_NAME})"),
    re.compile(rf"(?:\.\./)+({_NAME})"),
    re.compile(rf"(?<![\w)\]./])/{_NAME}(?:/{_NAME})*/({_NAME})"),
]
_LITERAL = re.compile(r"""('[^']*'|"[^"]*")""")


def _to_dollar(expr: str, *, relative: bool = True) -> str:
    """Turn pyxform's XPath paths back into ${name} and tidy its spacing."""
    pats = _PATTERNS if relative else [_PATTERNS[0], _PATTERNS[2]]
    parts = _LITERAL.split(expr)
    for i in range(0, len(parts), 2):  # even parts are outside string literals
        seg = parts[i]
        for p in pats:
            seg = p.sub(lambda m: "${" + m.group(1) + "}", seg)
        seg = re.sub(r"\s+", " ", seg)
        seg = re.sub(r"\(\s+", "(", seg)
        seg = re.sub(r"\s+([),])", r"\1", seg)
        seg = re.sub(r"\s*(!=|<=|>=|=|<|>)\s*", r" \1 ", seg)
        parts[i] = seg
    return "".join(parts).strip()


def _check(expr: str, name: str, kind: str, parser=parse) -> str:
    try:
        parser(expr)
    except UnsupportedExpression as e:
        err = UnsupportedExpression(
            e.expression, f"in question '{name}' ({kind}): {e.reason}"
        )
        err.question = name
        raise err from None
    return expr


def _expr(raw: str, name: str, kind: str) -> str:
    return _check(_to_dollar(raw), name, kind)


def _choice_filter(predicate: str, name: str) -> str:
    return _check(_to_dollar(predicate, relative=False), name, "choice_filter",
                  parse_choice_filter)


# ------------------------------------------------------------------ labels

class _Texts:
    def __init__(self, model: ET.Element):
        self.langs: list[str] = []
        self.default: str | None = None
        self.by_lang: dict[str, dict[str, str]] = {}
        for tr in model.iter(f"{XF}translation"):
            code = _short(tr.get("lang", ""))
            if code in self.by_lang:
                raise FormCompileError(
                    f"two translations ('{tr.get('lang')}' and an earlier one) both "
                    f"shorten to the language code '{code}'; give them distinct codes"
                )
            self.langs.append(code)
            self.by_lang[code] = {}
            if tr.get("default") == "true()":
                self.default = code
            for t in tr.findall(f"{XF}text"):
                for v in t.findall(f"{XF}value"):
                    if v.get("form") is None:  # plain text, not image/audio variants
                        self.by_lang[code][t.get("id", "")] = "".join(v.itertext())
        if self.default is None and self.langs:
            self.default = self.langs[0]

    def ref(self, ref: str | None) -> dict[str, str] | None:
        """Resolve `jr:itext('id')` (or a literal) to {lang: text}."""
        if not ref:
            return None
        m = _ITEXT_REF.match(ref.strip())
        if not m:
            return {"default": ref}
        out = {c: self.by_lang[c][m.group(1)]
               for c in self.langs if m.group(1) in self.by_lang[c]}
        return out or None

    def label_of(self, ctl: ET.Element, tag: str = "label") -> dict[str, str] | None:
        el = ctl.find(f"{XF}{tag}")
        if el is None:
            return None
        if el.get("ref"):
            return self.ref(el.get("ref"))
        text = "".join(el.itertext()).strip()
        return {"default": text} if text else None


# ---------------------------------------------------------------- compiler

class _Compiler:
    def __init__(self, root: ET.Element):
        head = root.find(f"{H}head")
        body = root.find(f"{H}body")
        model = head.find(f"{XF}model") if head is not None else None
        if body is None or model is None:
            raise FormCompileError("not an XForm: missing head, model or body")
        self.model = model
        self.title = (head.findtext(f"{H}title") or "").strip()
        if next(model.iter(f"{XF}setvalue"), None) is not None or \
                next(body.iter(f"{XF}setvalue"), None) is not None:
            raise FormCompileError(
                "dynamic default values (setvalue) are not supported; use a fixed default"
            )
        self.texts = _Texts(model)
        self.binds = {b.get("nodeset"): b for b in model.findall(f"{XF}bind")}
        self.controls: dict[str, ET.Element] = {}
        self.groups: dict[str, ET.Element] = {}
        self.repeats: dict[str, ET.Element] = {}
        for el in body.iter():
            tag = _local(el.tag)
            if tag in _CONTROLS and el.get("ref"):
                self.controls[el.get("ref")] = el
            elif tag in _UNSUPPORTED_CONTROLS:
                raise FormCompileError(f"unsupported question type '{tag}' at {el.get('ref')}")
            elif tag == "group" and el.get("ref"):
                self.groups[el.get("ref")] = el
            elif tag == "repeat" and el.get("nodeset"):
                self.repeats[el.get("nodeset")] = el
        self.seen: dict[str, str] = {}
        self.refs: list[tuple[str, str]] = []
        self.data = next(
            (i[0] for i in model.findall(f"{XF}instance") if i.get("id") is None and len(i)),
            None,
        )
        if self.data is None:
            raise FormCompileError("not an XForm: no primary instance")

    # -- helpers
    def _flag(self, bind: ET.Element | None, attr: str, name: str) -> bool:
        v = bind.get(attr) if bind is not None else None
        if v is None or v.strip() == "false()":
            return False
        if v.strip() == "true()":
            return True
        raise FormCompileError(
            f"question '{name}': {attr} must be yes/no, not the expression {v!r}"
        )

    def _common(self, node: dict, bind: ET.Element | None, name: str) -> None:
        if bind is None:
            return
        if self._flag(bind, "required", name):
            node["required"] = True
        msg = self.texts.ref(bind.get(f"{JR}requiredMsg"))
        if msg:
            node["required_message"] = msg
        if bind.get("relevant"):
            node["relevant"] = _expr(bind.get("relevant"), name, "relevant")
        if bind.get("constraint"):
            node["constraint"] = _expr(bind.get("constraint"), name, "constraint")
            msg = self.texts.ref(bind.get(f"{JR}constraintMsg"))
            if msg:
                node["constraint_message"] = msg
        if bind.get("calculate"):
            node["calculate"] = _expr(bind.get("calculate"), name, "calculate")

    # -- tree
    def nodes(self, elem: ET.Element, path: str, top: bool = False) -> list[dict]:
        out = []
        for child in elem:
            if child.get(f"{JR}template") is not None:
                continue  # the blank row pyxform keeps for ODK Collect
            name = _local(child.tag)
            if top and name == "meta":
                continue
            p = f"{path}/{name}"
            if name in self.seen:
                raise FormCompileError(
                    f"the name '{name}' is used twice, at {self.seen[name]} and {p}; "
                    "every question and group name must be unique in the whole form, "
                    "because expressions refer to fields as ${name}"
                )
            self.seen[name] = p
            node = self.group(child, p, name) if len(child) else self.leaf(child, p, name)
            if node is not None:
                out.append(node)
        return out

    def group(self, elem: ET.Element, path: str, name: str) -> dict:
        repeat = self.repeats.get(path)
        wrapper = self.groups.get(path)
        node: dict[str, Any] = {"type": "repeat" if repeat is not None else "group", "name": name}
        source = wrapper if wrapper is not None else repeat
        label = self.texts.label_of(source) if source is not None else None
        if label:
            node["label"] = label
        self._common(node, self.binds.get(path), name)
        if repeat is not None and repeat.get(f"{JR}count"):
            node["repeat_count"] = _expr(repeat.get(f"{JR}count"), name, "repeat_count")
        if wrapper is not None and wrapper.get("appearance"):
            node["appearance"] = wrapper.get("appearance")
        node["children"] = self.nodes(elem, path)
        return node

    def leaf(self, elem: ET.Element, path: str, name: str) -> dict | None:
        bind = self.binds.get(path)
        ctl = self.controls.get(path)
        if ctl is None:
            if bind is not None and bind.get("calculate"):
                node: dict[str, Any] = {"type": "calculate", "name": name}
                self._common(node, bind, name)
                return node
            return None  # start/end/instanceID: metadata with no question
        btype = (bind.get("type") if bind is not None else None) or "string"
        tag = _local(ctl.tag)
        if tag == "select1":
            ctype = "select_one"
        elif tag == "select":
            ctype = "select_multiple"
        elif tag == "upload":
            kind = ctl.get("mediatype", "").split("/")[0]
            ctype = kind if kind in ("image", "audio", "video") else "file"
        elif btype == "string":
            ctype = "note" if self._flag(bind, "readonly", name) else "text"
        elif btype in _BIND_TYPES:
            ctype = _BIND_TYPES[btype]
        else:
            raise FormCompileError(f"question '{name}': unsupported question type '{btype}'")

        node = {"type": ctype, "name": name}
        label = self.texts.label_of(ctl)
        if label:
            node["label"] = label
        hint = self.texts.label_of(ctl, "hint")
        if hint:
            node["hint"] = hint
        self._common(node, bind, name)
        if tag in ("select1", "select"):
            self._itemset(node, ctl, name)
        if ctl.get("appearance"):
            node["appearance"] = ctl.get("appearance")
        if ctype != "note" and self._flag(bind, "readonly", name):
            node["read_only"] = True
        default = (elem.text or "").strip()
        if default:
            node["default"] = default
        return node

    def _itemset(self, node: dict, ctl: ET.Element, name: str) -> None:
        its = ctl.find(f"{XF}itemset")
        m = _ITEMSET.match(its.get("nodeset", "").strip()) if its is not None else None
        if m is None:
            got = its.get("nodeset") if its is not None else "inline items"
            raise FormCompileError(
                f"question '{name}': choices must come from a choices list, got {got!r}"
            )
        node["choices_ref"] = m.group(1)
        self.refs.append((name, m.group(1)))
        if m.group(2) is not None:
            node["choice_filter"] = _choice_filter(m.group(2), name)

    def choices(self) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for inst in self.model.findall(f"{XF}instance"):
            iid = inst.get("id")
            if not iid or len(inst) == 0 or inst[0].find(f"{XF}item") is None:
                continue
            rows = []
            for item in inst[0].findall(f"{XF}item"):
                props = {_local(c.tag): (c.text or "") for c in item}
                value = props.pop("name", "")
                tid = props.pop("itextId", None)
                lab = props.pop("label", None)
                if tid:
                    label = self.texts.ref(f"jr:itext('{tid}')") or {}
                else:
                    label = {"default": lab} if lab else {}
                row: dict[str, Any] = {"value": value, "label": label}
                if props:
                    row["props"] = props
                rows.append(row)
            out[iid] = rows
        return out


_REF = re.compile(r"\$\{(" + _NAME + r")\}")


def _calculates(nodes: list[dict], out: dict[str, set[str]] | None = None) -> dict[str, set[str]]:
    out = {} if out is None else out
    for n in nodes:
        if "calculate" in n:
            out[n["name"]] = set(_REF.findall(n["calculate"] + " " + n.get("relevant", "")))
        _calculates(n.get("children", []), out)
    return out


def _check_calculate_cycles(nodes: list[dict]) -> None:
    graph = _calculates(nodes)
    graph = {k: [d for d in sorted(v) if d in graph] for k, v in graph.items()}
    state: dict[str, int] = {}  # 1 = on the current path, 2 = finished
    path: list[str] = []

    def visit(name: str) -> None:
        state[name] = 1
        path.append(name)
        for dep in graph[name]:
            if state.get(dep) == 1:
                cycle = path[path.index(dep):] + [dep]
                raise FormCompileError(
                    "calculations refer to each other in a cycle: " + " -> ".join(cycle)
                    + "; check the calculation and relevant columns of these rows"
                )
            if dep not in state:
                visit(dep)
        path.pop()
        state[name] = 2

    for name in graph:
        if name not in state:
            visit(name)


def compile_spec(xform_xml: str) -> dict:
    """Compile XForm XML into the JSON form spec; see the module docstring."""
    try:
        root = ET.fromstring(xform_xml.encode("utf-8"))
    except ET.ParseError as e:
        raise FormCompileError(f"not valid XML: {e}") from e
    c = _Compiler(root)
    langs = c.texts.langs or ["default"]
    nodes = c.nodes(c.data, "/" + _local(c.data.tag), top=True)
    _check_calculate_cycles(nodes)
    choices = c.choices()
    for qname, ref in c.refs:
        if ref not in choices:
            raise FormCompileError(
                f"question '{qname}' uses the choice list '{ref}', which does not exist"
            )
    return {
        "form_id": c.data.get("id", ""),
        "version": c.data.get("version", ""),
        "title": {code: c.title for code in langs},
        "languages": langs,
        "default_language": c.texts.default or "default",
        "nodes": nodes,
        "choices": choices,
    }
