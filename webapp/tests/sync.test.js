// Sync against the Apps Script backend, with the backend faked: no test here touches the network.
// `memStore` has db.js's exact interface; `fakeBackend` is the API from task-40-report.

import test from "node:test";
import assert from "node:assert/strict";

import * as sync from "../js/sync.js";
import * as projects from "../js/projects.js";
import { memStore, fakeBackend, URL_, FORM_A, FORM_B, sub, photo, noSleep } from "./_fakes.mjs";

const world = () => fakeBackend({
  GAYA2026: { name: "Bihar AMB", forms: [FORM_A] },
  PATNA: { name: "Patna WIFS", forms: [FORM_B] },
});
const opts = (store, be, extra = {}) => ({ store, fetchImpl: be.fetchImpl, url: URL_, sleep: noSleep(), random: () => 0.5, ...extra });

// A phone that has opened a project and downloaded its forms.
async function ready(be, codes = ["GAYA2026"]) {
  const store = memStore();
  for (const c of codes) await projects.openProject(c, { store, fetchImpl: be.fetchImpl, url: URL_ });
  await sync.bootstrap(opts(store, be));
  return store;
}
const submits = be => be.calls.filter(c => c.action === "submit");

test.beforeEach(() => { sync._resetSyncState(); });

// ---- bootstrap and project isolation ---------------------------------------------------

test("a valid code lists only that project's forms, tagged and namespaced", async () => {
  const be = world();
  const store = await ready(be);
  const forms = await store.listForms();
  assert.equal(forms.length, 1);
  assert.equal(forms[0].form_id, "id-Bihar AMB::visit");
  assert.equal(forms[0]._form_id, "visit");
  assert.deepEqual(forms[0]._project, { id: "id-Bihar AMB", name: "Bihar AMB" });
  assert.equal(forms[0].title.en, "Home visit");
});

test("two codes on one device: both projects' forms are kept apart even with the same form id and version", async () => {
  const be = world();
  const store = await ready(be, ["GAYA2026", "PATNA"]);
  const forms = await store.listForms();
  assert.deepEqual(forms.map(f => f.form_id).sort(), ["id-Bihar AMB::visit", "id-Patna WIFS::visit"]);
  assert.equal((await store.getForm("id-Patna WIFS::visit", "2026103101")).nodes[0].name, "school_name");
  assert.equal((await store.getForm("id-Bihar AMB::visit", "2026103101")).nodes[0].name, "asha_name");
});

test("each project's forms are fetched with that project's own token only", async () => {
  const be = world();
  await ready(be, ["GAYA2026", "PATNA"]);
  const asked = be.calls.filter(c => c.action === "forms");
  assert.equal(asked.length, 2);
  assert.notEqual(asked[0].token, asked[1].token);
});

test("a submission goes to its own project and never to another", async () => {
  const be = world();
  const store = await ready(be, ["GAYA2026", "PATNA"]);
  await store.enqueue(sub("a1", "id-Bihar AMB::visit"), {});
  await store.enqueue(sub("p1", "id-Patna WIFS::visit", { data: { school_name: "School 7" } }), {});
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.uploaded, 2);
  assert.equal(be.rows("Bihar AMB", "visit").length, 1);
  assert.equal(be.rows("Patna WIFS", "visit").length, 1);
  assert.equal(be.rows("Bihar AMB", "visit")[0].uuid, "a1");
  assert.equal(be.rows("Patna WIFS", "visit")[0].school_name, "School 7");
  assert.equal(be.rows("Patna WIFS", "visit")[0].asha_name, undefined);
});

test("a new form version is stored alongside the old one, never replacing it", async () => {
  const be = world();
  const store = await ready(be);
  be.projects.GAYA2026.forms = [{ ...FORM_A, version: "2026110101", nodes: [...FORM_A.nodes, { type: "text", name: "extra" }] }];
  const r = await sync.bootstrap(opts(store, be));
  assert.equal(r.forms.filter(f => f.downloaded).length, 1);
  assert.equal((await store.listForms()).length, 2);
  assert.equal((await store.getForm("id-Bihar AMB::visit", "2026103101")).nodes.length, FORM_A.nodes.length);
});

test("an already-stored version is left exactly as it was (a draft keeps the form it started on)", async () => {
  const be = world();
  const store = await ready(be);
  const before = JSON.stringify(await store.getForm("id-Bihar AMB::visit", "2026103101"));
  be.projects.GAYA2026.forms = [{ ...FORM_A, title: { en: "CHANGED SAME VERSION" } }];
  const r = await sync.bootstrap(opts(store, be));
  assert.equal(r.forms[0].downloaded, false);
  assert.equal(JSON.stringify(await store.getForm("id-Bihar AMB::visit", "2026103101")), before);
});

test("one bad spec does not stop the others, and a project that fails does not stop the next", async () => {
  const be = world();
  const store = memStore();
  for (const c of ["GAYA2026", "PATNA"]) await projects.openProject(c, { store, fetchImpl: be.fetchImpl, url: URL_ });
  be.projects.GAYA2026.forms = [{ nope: 1 }, FORM_A];
  be.projects.GAYA2026.skipped = ["broken.spec.json"];
  const r = await sync.bootstrap(opts(store, be));
  assert.equal(r.forms.length, 2);
  assert.equal(r.errors.length, 2);
  be.projects.GAYA2026.active = false;     // now the first project's forms call is a session failure
  const r2 = await sync.bootstrap(opts(store, be));
  assert.ok(r2.errors.some(e => e.project === "Bihar AMB"));
});

test("bootstrap throws when projects are held and none could be asked", async () => {
  const be = world();
  const store = await ready(be);
  be.fail.forms = () => "throw";
  await assert.rejects(sync.bootstrap(opts(store, be)));
  assert.equal((await store.listForms()).length, 1);   // what was downloaded earlier is untouched
});

test("bootstrap with no project open does nothing and does not call the backend", async () => {
  const be = world();
  const r = await sync.bootstrap(opts(memStore(), be));
  assert.deepEqual(r.forms, []);
  assert.equal(be.calls.length, 0);
});

// ---- uploading ---------------------------------------------------------------------------

test("a submission posts once, uuid first, answers in order, without claiming a name; nothing is posted on a second run", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1"), {});
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.uploaded, 1);
  assert.equal(await store.queueLength(), 0);
  assert.equal(submits(be).length, 1);
  const body = submits(be)[0];
  assert.equal(body.uuid, "u1");
  const main = body.tabs.find(t => t.kind === "main");
  assert.equal(main.name, "visit");
  assert.deepEqual(main.key, ["uuid"]);
  assert.deepEqual(Object.keys(main.rows[0]), ["uuid", "asha_name", "household_children", "household_photo", "_gps", "_started_at", "_finished_at", "_device_id", "_form_version"]);
  assert.equal("_submitted_by" in main.rows[0], false);   // the backend stamps the name from the person's code
  assert.equal(be.rows("Bihar AMB", "visit")[0]._submitted_by, "Sita");
  assert.equal(main.rows[0].asha_name, "सीता");
  assert.equal(body.tabs[body.tabs.length - 1].kind, "main");
  const again = await sync.syncOnce(opts(store, be));
  assert.equal(again.uploaded + again.replayed, 0);
  assert.equal(submits(be).length, 1);
});

test("the client never sends the received-at stamps (the script stamps them)", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1"), {});
  await sync.syncOnce(opts(store, be));
  const row = submits(be)[0].tabs.find(t => t.kind === "main").rows[0];
  assert.equal("_received_at" in row, false);
  assert.equal("_received_date_ist" in row, false);
});

test("a replay of the same uuid is answered 'duplicate': dequeued, and nothing new is written", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1"), {});
  await sync.syncOnce(opts(store, be));
  await store.enqueue(sub("u1"), {});          // e.g. a resumed draft finished twice: same uuid
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.replayed, 1);
  assert.equal(r.uploaded, 0);
  assert.equal(await store.queueLength(), 0);
  assert.equal(be.rows("Bihar AMB", "visit").length, 1);
});

test("a lost reply, then a retry, sends the SAME uuid and makes one row", async () => {
  const be = world();
  const store = await ready(be);
  // The backend writes the row but the reply never reaches the phone.
  const real = be.fetchImpl;
  let dropped = false;
  const lossy = async (url, init) => {
    const res = await real(url, init);
    if (JSON.parse(init.body).action === "submit" && !dropped) { dropped = true; throw new TypeError("connection dropped"); }
    return res;
  };
  await store.enqueue(sub("u1"), {});
  const r = await sync.syncOnce(opts(store, be, { fetchImpl: lossy }));
  assert.equal(r.uploaded + r.replayed, 1);
  assert.equal(await store.queueLength(), 0);
  assert.equal(be.rows("Bihar AMB", "visit").length, 1);
  const sent = submits(be).map(c => c.uuid);
  assert.deepEqual(sent, ["u1", "u1"]);           // twice on the wire, never a new uuid
});

test("a failure keeps the record queued (network, busy, server_error, HTML page, quota text)", async () => {
  for (const fail of ["throw", "html",
    () => ({ ok: false, error: "busy", retry: true, retry_after_s: 60 }),
    () => ({ ok: false, error: "server_error", retry: true, retry_after_s: 120 }),
    () => ({ ok: false, error: "quota", message: "Service invoked too many times for one day", retry: false })]) {
    sync._resetSyncState();
    const be = world();
    const store = await ready(be);
    await store.enqueue(sub("u1"), { household_photo: photo("PIC") });
    be.fail.submit = typeof fail === "string" ? () => fail : fail;
    const r = await sync.syncOnce(opts(store, be));
    assert.equal(await store.queueLength(), 1, String(fail));
    assert.equal((await store.getMedia("u1")).length, 1);
    assert.equal(r.rejected, 0);
    assert.equal(r.failed, 1);
    assert.equal((await store.listRejected()).length, 0);
    assert.equal(be.rows("Bihar AMB", "visit").length, 0);
  }
});

test("a retryable refusal backs off with jitter and then succeeds; the same uuid is resent", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1"), {});
  be.fail.submit = n => (n <= 3 ? { ok: false, error: "busy", retry: true, retry_after_s: 60 } : undefined);
  const sleep = noSleep();
  const r = await sync.syncOnce(opts(store, be, { sleep }));
  assert.equal(r.uploaded, 1);
  assert.equal(sleep.waits.length, 3);
  assert.deepEqual(sleep.waits, [750, 1500, 3000]);       // 1s,2s,4s ceilings at random()=0.5 -> 75%
  assert.deepEqual(submits(be).map(c => c.uuid), ["u1", "u1", "u1", "u1"]);
});

test("jitter spreads the delay between half and the full backoff", async () => {
  const waits = [];
  for (const rnd of [0, 0.999]) {
    sync._resetSyncState();
    const be = world();
    const store = await ready(be);
    await store.enqueue(sub("u1"), {});
    be.fail.submit = n => (n === 1 ? { ok: false, error: "busy", retry: true } : undefined);
    const sleep = noSleep();
    await sync.syncOnce(opts(store, be, { sleep, random: () => rnd }));
    waits.push(sleep.waits[0]);
  }
  assert.equal(waits[0], 500);
  assert.ok(waits[1] > 990 && waits[1] <= 1000);
});

test("when the backend keeps saying retry, the run stops, the record stays, and the server's retry-after sets the next run", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1"), {});
  await store.enqueue(sub("u2"), {});
  be.fail.submit = () => ({ ok: false, error: "busy", retry: true, retry_after_s: 120 });
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(await store.queueLength(), 2);
  assert.equal(r.failed, 1);
  assert.equal(r.rejected, 0);
  assert.ok(r.retryInMs >= 120_000);
  assert.equal(submits(be).length, 5);          // MAX_ATTEMPTS on the first record, then it stopped
});

test("permanent refusals go to the rejected store with their photo, and the queue moves on", async () => {
  for (const code of ["bad_request", "too_large", "layout_mismatch"]) {
    sync._resetSyncState();
    const be = world();
    const store = await ready(be);
    await store.enqueue(sub("u1"), { household_photo: photo("PIC") });
    await store.enqueue(sub("u2"), {});
    be.fail.submit = (n, body) => (body.uuid === "u1" ? { ok: false, error: code, message: "no thanks", retry: false } : undefined);
    const r = await sync.syncOnce(opts(store, be));
    assert.equal(r.rejected, 1, code);
    assert.equal(r.uploaded, 1);
    assert.equal(await store.queueLength(), 0);
    const [rec] = await store.listRejected();
    assert.equal(rec.uuid, "u1");
    assert.equal(rec.code, code);
    assert.equal(rec.submission.data.asha_name, "सीता");
    assert.equal(await rec.media[0].blob.text(), "PIC");
    assert.deepEqual(be.rows("Bihar AMB", "visit").map(r => r.uuid), ["u2"]);
  }
});

test("an unknown refusal is NOT treated as a rejection: the record is kept", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1"), {});
  be.fail.submit = () => ({ ok: false, error: "something_new", message: "huh", retry: false });
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.rejected, 0);
  assert.equal(await store.queueLength(), 1);
});

test("a rejected submission can be put back on the queue with its photo", async () => {
  const be = world();
  const store = await ready(be);
  be.fail.submit = () => ({ ok: false, error: "layout_mismatch", retry: false });
  await store.enqueue(sub("u1"), { household_photo: photo("PIC") });
  await sync.syncOnce(opts(store, be));
  await sync.retryRejected("u1", { store });
  assert.equal(await store.queueLength(), 1);
  assert.equal((await store.getMedia("u1")).length, 1);
  assert.equal((await store.listRejected()).length, 0);
});

test("if the rejection cannot be recorded, the submission stays queued", async () => {
  const be = world();
  const store = await ready(be);
  store.putRejected = async () => { throw new Error("disk full"); };
  be.fail.submit = () => ({ ok: false, error: "bad_request", retry: false });
  await store.enqueue(sub("u1"), {});
  await sync.syncOnce(opts(store, be));
  assert.equal(await store.queueLength(), 1);
});

test("a photo goes up as base64 with its mime, and its own question's cell is sent empty", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1"), { household_photo: photo("PIC") });
  await sync.syncOnce(opts(store, be));
  const body = submits(be)[0];
  assert.equal(body.photos.length, 1);
  assert.equal(body.photos[0].question, "household_photo");
  assert.equal(body.photos[0].mime, "image/jpeg");
  assert.equal(Buffer.from(body.photos[0].data_base64, "base64").toString(), "PIC");
  assert.equal(body.tabs.find(t => t.kind === "main").rows[0].household_photo, "");
});

test("repeat rows go in their own tabs carrying the parent uuid and row indexes; the main tab is last", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1", "id-Bihar AMB::visit", { repeats: { children: [{ child_name: "Ravi", doses: [{ dose_ml: 1 }, { dose_ml: 2 }] }, { child_name: "Mina" }] } }), {});
  await sync.syncOnce(opts(store, be));
  const body = submits(be)[0];
  assert.deepEqual(body.tabs.map(t => t.name), ["visit_children", "visit_children_doses", "visit"]);
  const kids = body.tabs[0];
  assert.deepEqual(kids.key, ["parent_uuid", "row_index"]);
  assert.deepEqual(kids.rows.map(r => [r.parent_uuid, r.row_index, r.child_name]), [["u1", 1, "Ravi"], ["u1", 2, "Mina"]]);
  const doses = body.tabs[1];
  assert.deepEqual(doses.key, ["parent_uuid", "children_row_index", "row_index"]);
  assert.deepEqual(doses.rows.map(r => [r.children_row_index, r.row_index, r.dose_ml]), [[1, 1, 1], [1, 2, 2]]);
});

test("an answer starting with = is passed through as plain data", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1", "id-Bihar AMB::visit", { data: { asha_name: "=HYPERLINK(1)" } }), {});
  await sync.syncOnce(opts(store, be));
  assert.equal(be.rows("Bihar AMB", "visit")[0].asha_name, "=HYPERLINK(1)");
});

// ---- sessions, revocation, sign-out ------------------------------------------------------

test("an expired token (a 'session' reply) is renewed once from the stored code and the same submission is resent", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1"), {});
  be.tokens.clear();                          // the backend forgot every token
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.uploaded, 1);
  assert.equal(be.counts.open, 2);
  assert.equal(be.rows("Bihar AMB", "visit").length, 1);
});

test("when access is withdrawn the record stays queued, nothing is rejected, and the other project still sends", async () => {
  const be = world();
  const store = await ready(be, ["GAYA2026", "PATNA"]);
  await store.enqueue(sub("a1"), {});
  await store.enqueue(sub("p1", "id-Patna WIFS::visit", { data: { school_name: "S" } }), {});
  be.projects.GAYA2026.active = false;
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.authRequired, true);
  assert.deepEqual(r.lostProjects, ["id-Bihar AMB"]);
  assert.equal(r.rejected, 0);
  assert.equal(r.uploaded, 1);
  assert.equal(await store.queueLength(), 1);
  assert.equal((await store.peekQueue(1))[0].uuid, "a1");
  assert.equal((await store.listRejected()).length, 0);
  // the owner switches the project back on and the person types the code again: it drains
  be.projects.GAYA2026.active = true;
  await projects.openProject("GAYA2026", { store, fetchImpl: be.fetchImpl, url: URL_ });
  const r2 = await sync.syncOnce(opts(store, be));
  assert.equal(r2.uploaded, 1);
  assert.equal(await store.queueLength(), 0);
});

test("sign-out leaves the queue intact, sends nothing, and a later code entry drains it", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1"), { household_photo: photo("PIC") });
  await projects.signOut(undefined, { store });
  const before = be.calls.length;
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(be.calls.length, before);
  assert.equal(r.skipped, 1);
  assert.equal(await store.queueLength(), 1);
  assert.equal((await store.getMedia("u1")).length, 1);
  await projects.openProject("GAYA2026", { store, fetchImpl: be.fetchImpl, url: URL_ });
  const r2 = await sync.syncOnce(opts(store, be));
  assert.equal(r2.uploaded, 1);
  assert.equal(be.rows("Bihar AMB", "visit").length, 1);
});

test("a record filled in under one person's code waits when another person's code holds the project", async () => {
  const be = world();
  be.projects.GAYA2026.person = "Ram";
  const store = await ready(be);
  await store.enqueue(sub("u1"), {});          // person: Sita
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.skipped, 1);
  assert.equal(await store.queueLength(), 1);
  assert.equal(submits(be).length, 0);
});

test("the client never populates _submitted_by anywhere", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const f of ["../js/sync.js", "../js/app.js", "../js/projects.js"]) {
    const src = (await readFile(new URL(f, import.meta.url), "utf8")).replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /_submitted_by/, f);
  }
});

test("an empty queue is a no-op", async () => {
  const be = world();
  const store = await ready(be);
  const before = be.calls.length;
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.uploaded + r.failed + r.rejected, 0);
  assert.equal(be.calls.length, before);
});

test("uploads are strictly one at a time, oldest first", async () => {
  const be = world();
  const store = await ready(be);
  let inFlight = 0, peak = 0;
  const real = be.fetchImpl;
  const slow = async (url, init) => {
    if (JSON.parse(init.body).action !== "submit") return real(url, init);
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 3));
    inFlight--;
    return real(url, init);
  };
  for (const u of ["u1", "u2", "u3"]) await store.enqueue(sub(u), {});
  await sync.syncOnce(opts(store, be, { fetchImpl: slow }));
  assert.equal(peak, 1);
  assert.deepEqual(be.rows("Bihar AMB", "visit").map(r => r.uuid), ["u1", "u2", "u3"]);
});

test("two overlapping syncOnce calls share one run", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1"), {});
  const [a, b] = [sync.syncOnce(opts(store, be)), sync.syncOnce(opts(store, be))];
  assert.equal(a, b);
  await a;
  assert.equal(be.rows("Bihar AMB", "visit").length, 1);
});

test("a submission whose form was never stored is skipped and kept", async () => {
  const be = world();
  const store = await ready(be);
  await store.enqueue(sub("u1", "id-Bihar AMB::gone"), {});
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.skipped, 1);
  assert.equal(await store.queueLength(), 1);
  assert.equal(submits(be).length, 0);
});

test("the sync code never deletes a queued record except after a confirmed send or a recorded rejection", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = (await readFile(new URL("../js/sync.js", import.meta.url), "utf8")).replace(/\/\/.*$/gm, "");
  assert.equal([...src.matchAll(/store\.dequeue\(/g)].length, 2);
  assert.doesNotMatch(src, /localStorage|googleapis|drive\.js|googleauth/);
});

test("the service worker leaves cross-origin and /api/ requests alone, so backend calls are never cached", async () => {
  const { readFile } = await import("node:fs/promises");
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(sw, /url\.origin !== self\.location\.origin\) return/);
  assert.match(sw, /\/api\//);
  assert.match(sw, /req\.method !== 'GET'\) return/);
  assert.match(sw, /'js\/projects\.js'/);
});

// ---- same-name projects through the whole path ----------------------------------------------

test("two projects with the same name keep forms, queue and rows apart", async () => {
  const be = fakeBackend({
    ONE: { name: "Anaemia", id: "pid-one", forms: [FORM_A] },
    TWO: { name: "Anaemia", id: "pid-two", forms: [FORM_B] },
  });
  const store = await ready(be, ["ONE", "TWO"]);
  assert.deepEqual((await store.listForms()).map(f => f.form_id).sort(), ["pid-one::visit", "pid-two::visit"]);
  await store.enqueue(sub("a1", "pid-one::visit"), {});
  await store.enqueue(sub("b1", "pid-two::visit", { data: { school_name: "S" } }), {});
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.uploaded, 2);
  assert.deepEqual(be.rows("pid-one", "visit").map(x => x.uuid), ["a1"]);
  assert.deepEqual(be.rows("pid-two", "visit").map(x => x.uuid), ["b1"]);
});

test("a name-keyed phone is moved to ids on the next bootstrap, and its queued record then sends once, same uuid", async () => {
  const be = world();
  const store = memStore();
  await store.putSessionRecord({ id: "project:Bihar AMB", key: "Bihar AMB", name: "Bihar AMB", person: "Sita", code: "GAYA2026", token: "stale", expires_at: null, revoked: false, added_at: 1 });
  await store.putForm({ ...FORM_A, form_id: "Bihar AMB::visit", _form_id: "visit", _project: { id: "Bihar AMB", name: "Bihar AMB" } });
  await store.enqueue(sub("u1", "Bihar AMB::visit"), {});
  await sync.bootstrap(opts(store, be));
  assert.equal(await store.getSessionRecord("project:Bihar AMB"), undefined);
  assert.equal(store.queue[0].uuid, "u1");
  assert.equal(store.queue[0].form_id, "id-Bihar AMB::visit");
  assert.deepEqual((await store.listForms()).map(f => f.form_id), ["id-Bihar AMB::visit"]);   // no stray name-keyed copy
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.uploaded, 1);
  assert.equal(be.rows("Bihar AMB", "visit")[0].uuid, "u1");
  assert.equal(store.queue.length, 0);
});

test("a name-keyed phone not yet moved still sends its queue under the old key", async () => {
  const be = world();
  const store = memStore();
  await store.putSessionRecord({ id: "project:Bihar AMB", key: "Bihar AMB", name: "Bihar AMB", person: "Sita", code: "GAYA2026", token: null, expires_at: null, revoked: false, added_at: 1 });
  await store.putForm({ ...FORM_A, form_id: "Bihar AMB::visit", _form_id: "visit", _project: { id: "Bihar AMB", name: "Bihar AMB" } });
  await store.enqueue(sub("u1", "Bihar AMB::visit"), {});
  const r = await sync.syncOnce(opts(store, be));
  assert.equal(r.uploaded, 1);
});
