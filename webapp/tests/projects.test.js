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
  assert.deepEqual(p, { key: "id-Bihar AMB", name: "Bihar AMB", person: "Sita" });
  const rec = await store.getSessionRecord("project:id-Bihar AMB");
  assert.ok(rec.token && rec.expires_at && rec.code === "gaya2026");
  assert.equal(rec.person, "Sita");
  assert.deepEqual(await projects.currentProject({ store }), { key: "id-Bihar AMB", name: "Bihar AMB", person: "Sita", revoked: false });
  assert.deepEqual(be.calls[0], { action: "open", code: "gaya2026" });
});

test("two codes on one device keep both projects, and the second does not replace the first", async () => {
  const store = memStore(), be = world();
  await projects.openProject("GAYA2026", o(store, be));
  await projects.openProject("PATNA", o(store, be));
  const held = await projects.listProjects({ store });
  assert.deepEqual(held.map(p => p.name), ["Bihar AMB", "Patna WIFS"]);
  assert.equal((await projects.currentProject({ store })).name, "Patna WIFS");   // the one just added is open
  await projects.setActiveProject("id-Bihar AMB", { store });
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
  await store.putForm({ ...FORM_A, form_id: "id-Bihar AMB::visit", _project: { id: "id-Bihar AMB", name: "Bihar AMB" } });
  await store.enqueue({ uuid: "u1", form_id: "id-Bihar AMB::visit", version: "2026103101" }, {});
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
  await projects.signOut("id-Patna WIFS", { store });
  assert.deepEqual((await projects.listProjects({ store })).map(p => p.name), ["Bihar AMB"]);
  assert.equal((await projects.currentProject({ store })).name, "Bihar AMB");
});

test("a token near its end is renewed with the stored code; a fresh one is reused", async () => {
  const store = memStore(), be = world();
  let t = Date.now();
  await projects.openProject("GAYA2026", o(store, be));
  const first = (await store.getSessionRecord("project:id-Bihar AMB")).token;
  assert.equal(await projects.tokenFor("id-Bihar AMB", o(store, be, { now: () => t })), first);
  assert.equal(be.counts.open, 1);
  t += 6 * 3600_000 - 30_000;        // within the last minute
  const second = await projects.tokenFor("id-Bihar AMB", o(store, be, { now: () => t }));
  assert.notEqual(second, first);
  assert.equal(be.counts.open, 2);
});

test("when the backend refuses the stored code the project is marked revoked and nothing else changes", async () => {
  const store = memStore(), be = world();
  await projects.openProject("GAYA2026", o(store, be));
  await store.enqueue({ uuid: "u1", form_id: "id-Bihar AMB::visit", version: "2026103101" }, {});
  be.projects.GAYA2026.active = false;
  await assert.rejects(projects.tokenFor("id-Bihar AMB", o(store, be, { force: true })), e => e.code === "revoked");
  const [p] = await projects.listProjects({ store });
  assert.equal(p.revoked, true);
  assert.equal((await store.getSessionRecord("project:id-Bihar AMB")).token, null);
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

// ---- identity is the backend's project_id, not the name ------------------------------------

const twins = () => fakeBackend({
  ONE: { name: "Anaemia", id: "pid-one", forms: [FORM_A] },
  TWO: { name: "Anaemia", id: "pid-two", forms: [FORM_B] },
});

test("two projects with the same name are two projects, each keyed by its own id", async () => {
  const store = memStore(), be = twins();
  const a = await projects.openProject("ONE", o(store, be));
  const b = await projects.openProject("TWO", o(store, be));
  assert.deepEqual([a.key, b.key], ["pid-one", "pid-two"]);
  assert.deepEqual([a.name, b.name], ["Anaemia", "Anaemia"]);          // the name is still what is shown
  const held = await projects.listProjects({ store });
  assert.deepEqual(held.map(p => [p.key, p.name]), [["pid-one", "Anaemia"], ["pid-two", "Anaemia"]]);
  assert.ok(await store.getSessionRecord("project:pid-one") && await store.getSessionRecord("project:pid-two"));
  assert.equal(await store.getSessionRecord("project:Anaemia"), undefined);   // nothing is keyed by the name
});

test("a reply without project_id is refused plainly, never keyed by name, and stores nothing", async () => {
  const store = memStore();
  const old = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, project: "Bihar AMB", person: "Sita", token: "t", expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
  await assert.rejects(projects.openProject("X", { store, fetchImpl: old, url: URL_ }), e => e.code === "server_outdated" && e.retry === false && /old version/.test(e.message));
  assert.equal(store.session.size, 0);
});

// ---- phones that logged in under the name key are moved, not orphaned -----------------------

// What a phone from the previous build holds: everything keyed by the project NAME.
async function legacyPhone() {
  const store = memStore();
  const NAME = "Bihar AMB";
  await store.putSessionRecord({ id: "project:" + NAME, key: NAME, name: NAME, person: "Sita", code: "GAYA2026", token: "old-token", expires_at: null, revoked: false, added_at: 5 });
  await store.putSessionRecord({ id: "active", key: NAME });
  for (const version of ["2026101001", "2026103101"]) {
    await store.putForm({ ...FORM_A, version, form_id: NAME + "::visit", _form_id: "visit", _project: { id: NAME, name: NAME } });
  }
  await store.saveDraft({ id: "d1", form_id: NAME + "::visit", version: "2026101001", data: { asha_name: "आधा" } });   // an older version, half done
  await store.enqueue({ uuid: "q1", form_id: NAME + "::visit", version: "2026103101", person: "Sita", data: {}, repeats: {} }, { photo: new Blob(["x"]) });
  await store.putRejected({ uuid: "r1", form_id: NAME + "::visit", version: "2026103101", submission: { uuid: "r1", form_id: NAME + "::visit" }, media: [] });
  return store;
}

test("entering the code on a phone with name-keyed data moves forms, drafts, queue, rejected and login to the id", async () => {
  const be = world(), store = await legacyPhone();
  await projects.openProject("GAYA2026", o(store, be));
  const ID = "id-Bihar AMB";
  assert.equal(await store.getSessionRecord("project:Bihar AMB"), undefined);
  const rec = await store.getSessionRecord("project:" + ID);
  assert.equal(rec.key, ID); assert.equal(rec.name, "Bihar AMB"); assert.equal(rec.added_at, 5);
  assert.equal((await store.getSessionRecord("active")).key, ID);
  const forms = await store.listForms();
  assert.deepEqual(forms.map(f => f.form_id), [ID + "::visit", ID + "::visit"]);
  assert.deepEqual(forms.map(f => f.version).sort(), ["2026101001", "2026103101"]);          // both versions survive
  assert.ok(forms.every(f => f._project.id === ID && f._project.name === "Bihar AMB"));
  const [d] = await store.listDrafts();
  assert.equal(d.form_id, ID + "::visit"); assert.equal(d.version, "2026101001");            // the draft stays on ITS version
  assert.ok(await store.getForm(d.form_id, d.version));                                      // and that version is still there
  assert.deepEqual(store.queue.map(q => [q.uuid, q.form_id]), [["q1", ID + "::visit"]]);     // same uuid
  assert.equal((await store.getMedia("q1")).length, 1);
  const [r] = await store.listRejected();
  assert.deepEqual([r.form_id, r.submission.form_id], [ID + "::visit", ID + "::visit"]);
});

test("a name-keyed phone that is only offline is left alone until it can ask", async () => {
  const be = world(), store = await legacyPhone();
  be.fail.open = () => "throw";
  const left = await projects.upgradeLegacyProjects(o(store, be));
  assert.deepEqual(left, ["Bihar AMB"]);
  assert.ok(await store.getSessionRecord("project:Bihar AMB"));
  assert.equal(store.queue[0].form_id, "Bihar AMB::visit");
  be.fail = {};
  assert.deepEqual(await projects.upgradeLegacyProjects(o(store, be)), []);
  assert.equal(store.queue[0].form_id, "id-Bihar AMB::visit");
  assert.deepEqual(await projects.upgradeLegacyProjects(o(store, be)), []);                  // idempotent
});

test("a name-keyed phone whose code is now refused keeps its queue exactly as it is", async () => {
  const be = world(), store = await legacyPhone();
  be.projects.GAYA2026.active = false;
  assert.deepEqual(await projects.upgradeLegacyProjects(o(store, be)), ["Bihar AMB"]);
  assert.equal(store.queue.length, 1);
  assert.equal(store.queue[0].form_id, "Bihar AMB::visit");
});

test("migrating one project never touches another project's records", async () => {
  const be = world(), store = await legacyPhone();
  await store.enqueue({ uuid: "p1", form_id: "id-Patna WIFS::visit", version: "2026103101", data: {}, repeats: {} }, {});
  await store.enqueue({ uuid: "p2", form_id: "Bihar AMB 2::visit", version: "2026103101", data: {}, repeats: {} }, {});   // a prefix of the name is not the name
  await projects.upgradeLegacyProjects(o(store, be));
  const by = Object.fromEntries(store.queue.map(q => [q.uuid, q.form_id]));
  assert.equal(by.p1, "id-Patna WIFS::visit");
  assert.equal(by.p2, "Bihar AMB 2::visit");
  assert.equal(by.q1, "id-Bihar AMB::visit");
});

// ---- config.js: the placeholder must fail loudly and in plain words ------------------------------

test("with the placeholder URL no request is made, and the error says the app is not set up", async () => {
  const { config } = await import("../config.js");
  assert.equal(typeof config.appsScriptUrl, "string");
  if (projects.isUsableUrl(config.appsScriptUrl)) return;           // the owner has pasted the real address: nothing to prove
  assert.equal(await projects.isConfigured(), false);
  const calls = [];
  await assert.rejects(
    projects.callApi({ action: "open", code: "X" }, { fetchImpl: async (...a) => { calls.push(a); throw new Error("must not be called"); } }),
    e => e.code === "not_configured" && e.retry === false && /has not been set up yet/.test(e.message));
  assert.equal(calls.length, 0);
});

test("config.js is committed (not ignored) and so is config.example.js", async () => {
  const root = new URL("../../", import.meta.url);
  const ignore = (await readFile(new URL(".gitignore", root), "utf8")).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  assert.ok(!ignore.some(l => /(^|\/)config(\.example)?\.js$/.test(l)), "config.js must not be in .gitignore");
  await readFile(new URL("webapp/config.js", root), "utf8");
  await readFile(new URL("webapp/config.example.js", root), "utf8");
});
