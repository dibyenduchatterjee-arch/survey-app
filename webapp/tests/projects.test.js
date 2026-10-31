// Project-code login against a fake Apps Script backend. No test touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as projects from "../js/projects.js";
import { memStore, fakeBackend, URL_, FORM_A, FORM_B } from "./_fakes.mjs";

const world = () => fakeBackend({
  GAYA2026: { name: "Bihar AMB", forms: [FORM_A] },
  PATNA: { name: "Patna WIFS", forms: [FORM_B] },
  OLD: { name: "Closed", forms: [], active: false },
});
const o = (store, backend, extra = {}) => ({ store, fetchImpl: backend.fetchImpl, url: URL_, ...extra });

test("a wrong code is refused and nothing is stored", async () => {
  const store = memStore(), be = world();
  await assert.rejects(projects.openProject("NOPE", o(store, be)), e => e.code === "refused" && e.retry === false);
  assert.equal(store.session.size, 0);
  assert.deepEqual(await projects.listProjects({ store }), []);
  assert.equal(await projects.currentProject({ store }), null);
});

test("a blank code is refused without calling the backend", async () => {
  const store = memStore(), be = world();
  await assert.rejects(projects.openProject("   ", o(store, be)), e => e.code === "refused");
  assert.equal(be.calls.length, 0);
});

test("a switched-off project is refused exactly like a wrong code", async () => {
  const store = memStore(), be = world();
  await assert.rejects(projects.openProject("OLD", o(store, be)), e => e.code === "refused");
  assert.equal(store.session.size, 0);
});

test("a valid code stores the session and the project identity; the code is trimmed and sent as text/plain", async () => {
  const store = memStore(), be = world();
  const p = await projects.openProject("  gaya2026 ", o(store, be));
  assert.deepEqual(p, { key: "Bihar AMB", name: "Bihar AMB", person: "Sita" });
  const rec = await store.getSessionRecord("project:Bihar AMB");
  assert.ok(rec.token && rec.expires_at && rec.code === "gaya2026");
  assert.equal(rec.person, "Sita");
  assert.deepEqual(await projects.currentProject({ store }), { key: "Bihar AMB", name: "Bihar AMB", person: "Sita", revoked: false });
  assert.deepEqual(be.calls[0], { action: "open", code: "gaya2026" });
});

test("two codes on one device keep both projects, and the second does not replace the first", async () => {
  const store = memStore(), be = world();
  await projects.openProject("GAYA2026", o(store, be));
  await projects.openProject("PATNA", o(store, be));
  const held = await projects.listProjects({ store });
  assert.deepEqual(held.map(p => p.name), ["Bihar AMB", "Patna WIFS"]);
  assert.equal((await projects.currentProject({ store })).name, "Patna WIFS");   // the one just added is open
  await projects.setActiveProject("Bihar AMB", { store });
  assert.equal((await projects.currentProject({ store })).name, "Bihar AMB");
});

test("entering the same project's code again refreshes it instead of adding a duplicate", async () => {
  const store = memStore(), be = world();
  await projects.openProject("GAYA2026", o(store, be));
  await projects.openProject("gaya2026", o(store, be));
  assert.equal((await projects.listProjects({ store })).length, 1);
});

test("a network failure or an HTML error page stores nothing and is retryable", async () => {
  const store = memStore(), be = world();
  be.fail.open = () => "throw";
  await assert.rejects(projects.openProject("GAYA2026", o(store, be)), e => e.code === "network" && e.retry === true);
  be.fail.open = () => "html";
  await assert.rejects(projects.openProject("GAYA2026", o(store, be)), e => e.code === "bad_reply" && e.retry === true);
  be.fail.open = () => ({ ok: false, error: "too_many_attempts", retry: true, retry_after_s: 300 });
  await assert.rejects(projects.openProject("GAYA2026", o(store, be)), e => e.code === "too_many_attempts" && e.retryAfterMs === 300_000);
  assert.equal(store.session.size, 0);
});

test("signing out of everything clears the logins and leaves the queue, drafts and forms alone", async () => {
  const store = memStore(), be = world();
  await projects.openProject("GAYA2026", o(store, be));
  await store.putForm({ ...FORM_A, form_id: "Bihar AMB::visit", _project: { id: "Bihar AMB", name: "Bihar AMB" } });
  await store.enqueue({ uuid: "u1", form_id: "Bihar AMB::visit", version: "2026103101" }, {});
  await projects.signOut(undefined, { store });
  assert.deepEqual(await projects.listProjects({ store }), []);
  assert.equal(await store.getSessionRecord("active"), undefined);
  assert.equal(await store.queueLength(), 1);
  assert.equal((await store.listForms()).length, 1);
});

test("signing out of one project keeps the other", async () => {
  const store = memStore(), be = world();
  await projects.openProject("GAYA2026", o(store, be));
  await projects.openProject("PATNA", o(store, be));
  await projects.signOut("Patna WIFS", { store });
  assert.deepEqual((await projects.listProjects({ store })).map(p => p.name), ["Bihar AMB"]);
  assert.equal((await projects.currentProject({ store })).name, "Bihar AMB");
});

test("a token near its end is renewed with the stored code; a fresh one is reused", async () => {
  const store = memStore(), be = world();
  let t = Date.now();
  await projects.openProject("GAYA2026", o(store, be));
  const first = (await store.getSessionRecord("project:Bihar AMB")).token;
  assert.equal(await projects.tokenFor("Bihar AMB", o(store, be, { now: () => t })), first);
  assert.equal(be.counts.open, 1);
  t += 6 * 3600_000 - 30_000;        // within the last minute
  const second = await projects.tokenFor("Bihar AMB", o(store, be, { now: () => t }));
  assert.notEqual(second, first);
  assert.equal(be.counts.open, 2);
});

test("when the backend refuses the stored code the project is marked revoked and nothing else changes", async () => {
  const store = memStore(), be = world();
  await projects.openProject("GAYA2026", o(store, be));
  await store.enqueue({ uuid: "u1", form_id: "Bihar AMB::visit", version: "2026103101" }, {});
  be.projects.GAYA2026.active = false;
  await assert.rejects(projects.tokenFor("Bihar AMB", o(store, be, { force: true })), e => e.code === "revoked");
  const [p] = await projects.listProjects({ store });
  assert.equal(p.revoked, true);
  assert.equal((await store.getSessionRecord("project:Bihar AMB")).token, null);
  assert.equal(await store.queueLength(), 1);
  // entering the code again, once it works, restores it
  be.projects.GAYA2026.active = true;
  await projects.openProject("GAYA2026", o(store, be));
  assert.equal((await projects.listProjects({ store }))[0].revoked, false);
});

test("tokens and codes are kept in IndexedDB via db.js, never localStorage", async () => {
  for (const f of ["../js/projects.js", "../js/sync.js", "../js/app.js"]) {
    const src = (await readFile(new URL(f, import.meta.url), "utf8")).replace(/\/\/.*$/gm, "");
    for (const m of src.matchAll(/localStorage\.(setItem|set)\(([^)]*)\)|store\.set\(([^)]*)\)/g)) {
      assert.doesNotMatch(m[0], /token|code|session/i, `${f}: ${m[0]}`);
    }
  }
  assert.doesNotMatch((await readFile(new URL("../js/projects.js", import.meta.url), "utf8")).replace(/\/\/.*$/gm, ""), /localStorage/);
});

test("the backend address comes from config.js and a placeholder is refused", async () => {
  const ex = await readFile(new URL("../config.example.js", import.meta.url), "utf8");
  assert.match(ex, /appsScriptUrl/);
  assert.match(ex, /PASTE/);
  assert.equal(projects.isUsableUrl("PASTE-THE-WEB-APP-URL-THAT-ENDS-IN-/exec"), false);
  assert.equal(projects.isUsableUrl(undefined), false);
  assert.equal(projects.isUsableUrl("http://insecure.example/exec"), false);
  assert.equal(projects.isUsableUrl(URL_), true);
});
