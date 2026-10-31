// The console runs under a Content-Security-Policy that has no 'unsafe-inline' for script.
// The one inline concession was style ATTRIBUTES (console/js/forms.js indented nested
// questions with a style="" string). Setting a property through the CSSOM (el.style.x = ...)
// is not governed by style-src-attr, so the console must never write a style attribute: then
// the policy can drop `style-src-attr 'unsafe-inline'`. This test fails if one comes back.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE = path.resolve(HERE, "..", "console");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(CONSOLE).filter((f) => /\.(js|html)$/.test(f));

test("the console has files to check", () => {
  assert.ok(files.length >= 10);
});

for (const file of files) {
  test(`no inline style attribute in ${path.relative(CONSOLE, file)}`, () => {
    const code = readFileSync(file, "utf8");
    const rel = path.relative(CONSOLE, file);
    // markup: <div style="...">
    assert.ok(!/<[a-z][^>]*\sstyle\s*=/i.test(code), `${rel}: a style="" attribute in markup`);
    // the h(tag, { style: ... }) helper turns the key into setAttribute('style', ...)
    assert.ok(!/[{,]\s*['"]?style['"]?\s*:/.test(code), `${rel}: a style key passed to h()`);
    assert.ok(!/setAttribute\(\s*['"]style['"]/.test(code), `${rel}: setAttribute('style')`);
    assert.ok(!/\.cssText\b/.test(code), `${rel}: cssText`);
    assert.ok(!/insertAdjacentHTML|\.innerHTML\s*=|\.outerHTML\s*=/.test(code), `${rel}: markup built from a string`);
  });
}
