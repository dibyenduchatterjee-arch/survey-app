// Sync against Google Drive and Sheets, with the Drive layer stubbed: no test here touches
// the network. `memStore` has db.js's exact interface; `fakeDrive` is an in-memory
// spreadsheet that can be told to fail at a named call.

import test from "node:test";
import assert from "node:assert/strict";

import * as sync from "../js/sync.js";
import { DriveError } from "../js/drive.js";

// ---- fakes -----------------------------------------------------------------------

function memStore() {
  const forms = new Map();
  const rejected = new Map();
  const media = new Map();
  let queue = [];
  let seq = 0;
  return {
    async putForm(spec) { forms.set(`${spec.form_id}|${spec.version}`, structuredClone(spec)); },
    async getForm(id, v) { return forms.get(`${id}|${v}`); },
    async listForms() { return [...forms.values()]; },
    async putRejected(rec) { rejected.set(rec.uuid, rec); },
    async listRejected() { return [...rejected.values()]; },
    async getRejected(uuid) { return rejected.get(uuid); },
    async deleteRejected(uuid) { rejected.delete(uuid); },
    async enqueue(sub, blobs) {
      queue = queue.filter(q => q.uuid !== sub.uuid);
      queue.push({ ...sub, queued_at: ++seq });
      media.set(sub.uuid, Object.entries(blobs || {}).map(([question, blob]) => ({ uuid: sub.uuid, question, blob })));
    },
    async peekQueue(n = 1) { return queue.slice(0, n); },
    async dequeue(uuid) { queue = queue.filter(q => q.uuid !== uuid); media.delete(uuid); },
    async queueLength() { return queue.length; },
    async getMedia(uuid) { return media.get(uuid) || []; },
  };
}

const SPEC = {
  form_id: "visit", version: "2026103101",
  nodes: [
    { type: "text", name: "asha_name" },
    { type: "group", name: "g", children: [{ type: "integer", name: "household_children" }] },
    { type: "image", name: "household_photo" },
    { type: "note", name: "n1" },
    { type: "repeat", name: "children", children: [
      { type: "text", name: "child_name" },
      { type: "repeat", name: "doses", children: [{ type: "integer", name: "dose_ml" }] },
    ] },
  ],
};
const PROJECT = { id: "P1", name: "AMB" };

async function readyStore(spec = SPEC) {
  const store = memStore();
  await store.putForm({ ...spec, _project: PROJECT });
  return store;
}

const sub = (uuid, extra = {}) => ({
  uuid, form_id: "visit", version: "2026103101", user_id: "asha@x.org",
  data: { asha_name: "सीता", household_children: 2 }, repeats: {},
  device_id: "dev-1", started_at: "2026-10-31T09:00:00Z", finished_at: "2026-10-31T09:05:00Z",
  gps_lat: 25.5, gps_lon: 85.1, ...extra,
});
const photo = (t = "JPEG") => new Blob([t], { type: "image/jpeg" });
const err = (status, retryable = status === 429 || status >= 500, body = "") =>
  new DriveError(`Google ${status}`, { status, retryable, body });

// An in-memory Drive. `fail[name]` is a function(callNumber, args) that may throw.
function fakeDrive(fail = {}) {
  const tabs = new Map();           // tab name -> array of rows; row 0 is the header
  const calls = [];
  const counts = {};
  const uploads = [];
  const hit = (name, args) => {
    calls.push(name);
    counts[name] = (counts[name] || 0) + 1;
    if (fail[name]) fail[name](counts[name], args);
  };
  const d = {
    tabs, calls, uploads,
    rows: tab => (tabs.get(tab) || []).slice(1),
    async listProjects() { hit("listProjects"); return d.projects || [PROJECT]; },
    async listForms(id) { hit("listForms", id); return (d.files || {})[id] || []; },
    async readSpec(fid) { hit("readSpec", fid); d.read = [...(d.read || []), fid]; return structuredClone(d.specs[fid]); },
    async uploadMedia(folder, name) {
      hit("uploadMedia", name);
      uploads.push({ folder, name });
      return { id: "f" + uploads.length, link: `https://drive.example/${name}` };
    },
    async findOrCreateSpreadsheet(folder, name) { hit("findOrCreateSpreadsheet"); return "SS:" + folder + ":" + name; },
    async ensureTab(ss, tab, header) {
      hit("ensureTab");
      if (!tabs.has(tab)) tabs.set(tab, [header.slice()]);
    },
    async readColumns(ss, tab, n) {
      hit("readColumns");
      return (tabs.get(tab) || []).map(r => r.slice(0, n).map(String));
    },
    async appendRow(ss, tab, values) {
      hit("appendRow", { tab, values });
      const t = tabs.get(tab);
      const row = Array.isArray(values) ? values : t[0].map(k => (values[k] ?? ""));
      t.push(row);
    },
  };
  return d;
}

const noSleep = () => { const s = async ms => { s.waits.push(ms); }; s.waits = []; return s; };
const opts = (store, drive, extra = {}) => ({
  store, drive, sleep: noSleep(), random: () => 0.5, getUser: async () => ({ email: "asha@x.org" }), ...extra,
});

test.beforeEach(() => { sync._resetSyncState(); });

// ---- the required behaviours -------------------------------------------------------

test("a submission appends exactly one row, uuid first, answers in header order, metadata after", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  await store.enqueue(sub("u1"), {});
  const r = await sync.syncOnce(opts(store, drive));
  assert.equal(r.uploaded, 1);
  assert.equal(r.remaining, 0);
  assert.deepEqual(drive.tabs.get("visit")[0], [
    "uuid", "asha_name", "household_children", "household_photo",
    "_gps", "_started_at", "_finished_at", "_device_id", "_submitted_by", "_form_version",
  ]);
  assert.deepEqual(drive.rows("visit"), [[
    "u1", "सीता", 2, "", "25.5 85.1", "2026-10-31T09:00:00Z", "2026-10-31T09:05:00Z", "dev-1", "asha@x.org", "2026103101",
  ]]);
  assert.equal(await store.queueLength(), 0);
});

test("a replay of the same uuid appends nothing and still dequeues", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  await store.enqueue(sub("u1"), { household_photo: photo() });
  await sync.syncOnce(opts(store, drive));
  await store.enqueue(sub("u1"), { household_photo: photo() });   // the same submission comes back
  const r = await sync.syncOnce(opts(store, drive));
  assert.equal(drive.rows("visit").length, 1);
  assert.equal(drive.uploads.length, 1, "no second photo upload for a replay");
  assert.equal(r.replayed, 1);
  assert.equal(await store.queueLength(), 0);
});

test("a dropped connection after the append, then a retry, never makes a second row", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  const realAppend = drive.appendRow;
  let lost = false;
  drive.appendRow = async (...a) => {
    await realAppend(...a);
    if (!lost) { lost = true; throw err(0, false); }     // the row landed, the reply did not
  };
  await store.enqueue(sub("u1"), {});
  await sync.syncOnce(opts(store, drive));
  assert.equal(await store.queueLength(), 1, "still queued: we cannot know it landed");
  await sync.syncOnce(opts(store, drive));
  assert.equal(drive.rows("visit").length, 1);
  assert.equal(await store.queueLength(), 0);
});

test("a failed photo upload leaves the submission queued and appends nothing", async () => {
  const store = await readyStore();
  const drive = fakeDrive({ uploadMedia: () => { throw err(500); } });
  await store.enqueue(sub("u1"), { household_photo: photo() });
  const r = await sync.syncOnce(opts(store, drive, { maxAttempts: 2 }));
  assert.equal(await store.queueLength(), 1);
  assert.equal(drive.rows("visit").length, 0);
  assert.equal(r.uploaded, 0);
  assert.ok(r.retryInMs > 0);
  assert.equal((await store.listRejected()).length, 0);
});

test("photo link goes in the question's own column", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  await store.enqueue(sub("u1"), { household_photo: photo() });
  await sync.syncOnce(opts(store, drive));
  assert.equal(drive.uploads[0].folder, "P1");
  assert.equal(drive.rows("visit")[0][3], "https://drive.example/u1_household_photo.jpg");
});

test("a 429 retries with jittered exponential backoff, then succeeds", async () => {
  const store = await readyStore();
  let n = 0;
  const drive = fakeDrive({ appendRow: () => { if (++n <= 2) throw err(429); } });
  const sleep = noSleep();
  await store.enqueue(sub("u1"), {});
  const r = await sync.syncOnce(opts(store, drive, { sleep, random: () => 1 }));
  assert.equal(r.uploaded, 1);
  // The fake throws BEFORE writing, so exactly one row exists after two failures.
  assert.equal(drive.rows("visit").length, 1);
  assert.equal(sleep.waits.length, 2);
  assert.ok(sleep.waits[1] > sleep.waits[0], "exponential");
  assert.ok(sleep.waits[0] > 0);
});

test("jitter spreads the delay between half and the full backoff", async () => {
  const waits = [];
  for (const random of [0, 0.999]) {
    sync._resetSyncState();
    const store = await readyStore();
    let n = 0;
    const drive = fakeDrive({ appendRow: () => { if (++n <= 1) throw err(503); } });
    const sleep = noSleep();
    await store.enqueue(sub("u1"), {});
    await sync.syncOnce(opts(store, drive, { sleep, random: () => random }));
    waits.push(sleep.waits[0]);
  }
  assert.ok(waits[0] < waits[1]);
  assert.ok(waits[0] >= waits[1] / 2 - 1);
});

test("a Google quota 403 is retried, not rejected", async () => {
  const store = await readyStore();
  let n = 0;
  const drive = fakeDrive({ appendRow: () => { if (++n === 1) throw err(403, false, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}'); } });
  await store.enqueue(sub("u1"), {});
  const r = await sync.syncOnce(opts(store, drive));
  assert.equal(r.uploaded, 1);
  assert.equal(r.rejected, 0);
});

test("a 403 moves the submission to rejected with its media, and the queue moves on", async () => {
  const store = await readyStore();
  const drive = fakeDrive({ uploadMedia: (c, a) => { if (/u1_/.test(a)) throw err(403, false, "forbidden"); } });
  await store.enqueue(sub("u1"), { household_photo: photo("PIC") });
  await store.enqueue(sub("u2"), {});
  const r = await sync.syncOnce(opts(store, drive));
  assert.equal(r.rejected, 1);
  assert.equal(r.uploaded, 1);
  assert.equal(await store.queueLength(), 0);
  const [rec] = await store.listRejected();
  assert.equal(rec.uuid, "u1");
  assert.equal(rec.status, 403);
  assert.equal(rec.submission.data.asha_name, "सीता");
  assert.equal(rec.media.length, 1);
  assert.equal(await rec.media[0].blob.text(), "PIC");
  assert.deepEqual(drive.rows("visit").map(r => r[0]), ["u2"]);
});

test("a rejected submission can be put back on the queue with its photo", async () => {
  const store = await readyStore();
  const drive = fakeDrive({ appendRow: () => { throw err(403, false, "forbidden"); } });
  await store.enqueue(sub("u1"), { household_photo: photo("PIC") });
  await sync.syncOnce(opts(store, drive));
  await sync.retryRejected("u1", { store });
  assert.equal(await store.queueLength(), 1);
  assert.equal((await store.getMedia("u1")).length, 1);
  assert.equal((await store.listRejected()).length, 0);
});

test("if the rejection cannot be recorded, the submission stays queued", async () => {
  const store = await readyStore();
  store.putRejected = async () => { throw new Error("disk full"); };
  const drive = fakeDrive({ appendRow: () => { throw err(403, false, "forbidden"); } });
  await store.enqueue(sub("u1"), {});
  await sync.syncOnce(opts(store, drive));
  assert.equal(await store.queueLength(), 1);
});

test("repeat rows land in their own tab, each carrying the parent uuid and its row index", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  await store.enqueue(sub("u1", { repeats: {
    children: [
      { child_name: "Anu", doses: [{ dose_ml: 5 }, { dose_ml: 5 }] },
      { child_name: "Ravi" },
    ],
  } }), {});
  await sync.syncOnce(opts(store, drive));
  assert.deepEqual(drive.tabs.get("visit_children")[0], ["parent_uuid", "row_index", "child_name"]);
  assert.deepEqual(drive.rows("visit_children"), [["u1", 1, "Anu"], ["u1", 2, "Ravi"]]);
  assert.deepEqual(drive.tabs.get("visit_children_doses")[0], ["parent_uuid", "children_row_index", "row_index", "dose_ml"]);
  assert.deepEqual(drive.rows("visit_children_doses"), [["u1", 1, 1, 5], ["u1", 1, 2, 5]]);
  assert.equal(drive.rows("visit").length, 1);
});

test("a crash midway through repeat rows is finished by the retry, with no duplicate rows", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  const real = drive.appendRow;
  let n = 0;
  drive.appendRow = async (...a) => { if (++n === 2) throw err(0, false); return real(...a); };
  await store.enqueue(sub("u1", { repeats: { children: [{ child_name: "A" }, { child_name: "B" }, { child_name: "C" }] } }), {});
  await sync.syncOnce(opts(store, drive));
  assert.equal(await store.queueLength(), 1);
  await sync.syncOnce(opts(store, drive));
  assert.deepEqual(drive.rows("visit_children").map(r => r[2]), ["A", "B", "C"]);
  assert.equal(drive.rows("visit").length, 1);
  assert.equal(await store.queueLength(), 0);
});

test("the main row is written last, so its presence means everything else landed", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  const order = [];
  const real = drive.appendRow;
  drive.appendRow = async (ss, tab, v) => { order.push(tab); return real(ss, tab, v); };
  await store.enqueue(sub("u1", { repeats: { children: [{ child_name: "A" }] } }), { household_photo: photo() });
  await sync.syncOnce(opts(store, drive));
  assert.deepEqual(order, ["visit_children", "visit"]);
  assert.ok(drive.calls.indexOf("uploadMedia") < drive.calls.indexOf("appendRow"));
});

test("a forced re-authentication leaves the queue completely untouched, and a later sign-in drains it", async () => {
  const store = await readyStore();
  let signedIn = false;
  const drive = fakeDrive({
    findOrCreateSpreadsheet: () => {
      if (!signedIn) { const e = new Error("Your Google sign-in has expired."); e.code = "needs_signin"; throw e; }
    },
  });
  for (const u of ["u1", "u2"]) await store.enqueue(sub(u), { household_photo: photo() });
  const r = await sync.syncOnce(opts(store, drive));
  assert.equal(r.authRequired, true);
  assert.equal(r.remaining, 2);
  assert.equal(await store.queueLength(), 2);
  assert.equal((await store.getMedia("u1")).length, 1);
  assert.equal((await store.listRejected()).length, 0);
  assert.equal(drive.rows("visit").length, 0);
  signedIn = true;
  const r2 = await sync.syncOnce(opts(store, drive));
  assert.equal(r2.uploaded, 2);
  assert.equal(await store.queueLength(), 0);
});

test("no signed-in user means authRequired and no Drive calls", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  await store.enqueue(sub("u1"), {});
  const r = await sync.syncOnce(opts(store, drive, { getUser: async () => null }));
  assert.equal(r.authRequired, true);
  assert.equal(drive.calls.length, 0);
  assert.equal(await store.queueLength(), 1);
});

test("a 401 mid-run is an auth problem, not a rejection", async () => {
  const store = await readyStore();
  const drive = fakeDrive({ appendRow: () => { throw err(401, false); } });
  await store.enqueue(sub("u1"), {});
  const r = await sync.syncOnce(opts(store, drive));
  assert.equal(r.authRequired, true);
  assert.equal(await store.queueLength(), 1);
  assert.equal((await store.listRejected()).length, 0);
});

test("an empty queue is a no-op", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  const r = await sync.syncOnce(opts(store, drive));
  assert.deepEqual([r.uploaded, r.replayed, r.failed, r.rejected, r.remaining, r.authRequired], [0, 0, 0, 0, 0, false]);
  assert.equal(drive.calls.length, 0);
});

// ---- other rules that must hold ------------------------------------------------------

test("uploads are strictly one at a time, oldest first", async () => {
  const store = await readyStore();
  let inFlight = 0, peak = 0;
  const drive = fakeDrive();
  const real = drive.appendRow;
  drive.appendRow = async (...a) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 3));
    inFlight--;
    return real(...a);
  };
  for (const u of ["u1", "u2", "u3"]) await store.enqueue(sub(u), {});
  await sync.syncOnce(opts(store, drive));
  assert.equal(peak, 1);
  assert.deepEqual(drive.rows("visit").map(r => r[0]), ["u1", "u2", "u3"]);
});

test("two overlapping syncOnce calls share one run", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  await store.enqueue(sub("u1"), {});
  const [a, b] = [sync.syncOnce(opts(store, drive)), sync.syncOnce(opts(store, drive))];
  assert.equal(a, b);
  await a;
  assert.equal(drive.rows("visit").length, 1);
});

test("an answer starting with = is passed through as plain data", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  await store.enqueue(sub("u1", { data: { asha_name: "=HYPERLINK(\"x\")" } }), {});
  await sync.syncOnce(opts(store, drive));
  assert.equal(drive.rows("visit")[0][1], '=HYPERLINK("x")');   // drive.appendRow writes RAW
});

test("a submission whose form was never stored is skipped and kept", async () => {
  const store = memStore();
  const drive = fakeDrive();
  await store.enqueue(sub("u1"), {});
  const r = await sync.syncOnce(opts(store, drive));
  assert.equal(r.skipped, 1);
  assert.equal(await store.queueLength(), 1);
});

test("a queued submission stamped with another person's email is not sent under this login", async () => {
  const store = await readyStore();
  const drive = fakeDrive();
  await store.enqueue(sub("u1", { user_id: "other@x.org" }), {});
  const r = await sync.syncOnce(opts(store, drive));
  assert.equal(r.skipped, 1);
  assert.equal(drive.rows("visit").length, 0);
  assert.equal(await store.queueLength(), 1);
});

test("the service worker leaves cross-origin and /api/ requests alone, so Google calls are never cached", async () => {
  const { readFile } = await import("node:fs/promises");
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(sw, /url\.origin !== self\.location\.origin\) return/);
  assert.match(sw, /\/api\//);
  assert.match(sw, /req\.method !== 'GET'\) return/);
});

// ---- bootstrap -----------------------------------------------------------------------

function bootDrive(specs) {
  const d = fakeDrive();
  d.projects = [PROJECT, { id: "P2", name: "WIFS" }];
  d.files = { P1: [{ id: "a", name: "visit.spec.json" }, { id: "x", name: "visit.xlsx" }], P2: [{ id: "b", name: "other.spec.json" }] };
  d.specs = specs;
  return d;
}

test("bootstrap stores each project's form specs, tagged with their project", async () => {
  const store = memStore();
  const drive = bootDrive({ a: SPEC, b: { ...SPEC, form_id: "other" } });
  const r = await sync.bootstrap({ store, drive, rootFolderId: "ROOT" });
  assert.deepEqual(r.errors, []);
  assert.equal(r.forms.length, 2);
  assert.equal((await store.getForm("visit", "2026103101"))._project.id, "P1");
  assert.equal((await store.getForm("other", "2026103101"))._project.name, "WIFS");
  assert.ok(!drive.read.includes("x"), "only *.spec.json files are read");
});

test("a new form version is stored alongside the old one, never replacing it", async () => {
  const store = memStore();
  await sync.bootstrap({ store, drive: bootDrive({ a: SPEC, b: { ...SPEC, form_id: "other" } }), rootFolderId: "R" });
  const v2 = { ...SPEC, version: "2026110101", nodes: [...SPEC.nodes, { type: "text", name: "extra" }] };
  await sync.bootstrap({ store, drive: bootDrive({ a: v2, b: { ...SPEC, form_id: "other" } }), rootFolderId: "R" });
  assert.ok(await store.getForm("visit", "2026103101"));
  assert.ok(await store.getForm("visit", "2026110101"));
  assert.equal((await store.getForm("visit", "2026103101")).nodes.length, SPEC.nodes.length);
});

test("an already-stored version is left exactly as it was", async () => {
  const store = memStore();
  await sync.bootstrap({ store, drive: bootDrive({ a: SPEC, b: { ...SPEC, form_id: "other" } }), rootFolderId: "R" });
  const changed = { ...SPEC, title: "edited in place" };
  const r = await sync.bootstrap({ store, drive: bootDrive({ a: changed, b: { ...SPEC, form_id: "other" } }), rootFolderId: "R" });
  assert.equal((await store.getForm("visit", "2026103101")).title, undefined);
  assert.equal(r.forms.find(f => f.form_id === "visit").downloaded, false);
});

test("one bad spec or project does not stop the others", async () => {
  const store = memStore();
  const drive = bootDrive({ a: { nope: true }, b: { ...SPEC, form_id: "other" } });
  const r = await sync.bootstrap({ store, drive, rootFolderId: "R" });
  assert.equal(r.errors.length, 1);
  assert.ok(await store.getForm("other", "2026103101"));
  const drive2 = bootDrive({ a: SPEC, b: { ...SPEC, form_id: "other" } });
  drive2.listForms = async id => { if (id === "P1") throw err(500); return drive2.files[id]; };
  const store2 = memStore();
  const r2 = await sync.bootstrap({ store: store2, drive: drive2, rootFolderId: "R", sleep: noSleep(), maxAttempts: 1 });
  assert.equal(r2.errors.length, 1);
  assert.ok(await store2.getForm("other", "2026103101"));
});

test("bootstrap throws when the project list itself cannot be read", async () => {
  const drive = bootDrive({});
  drive.listProjects = async () => { throw err(500); };
  await assert.rejects(sync.bootstrap({ store: memStore(), drive, rootFolderId: "R", sleep: noSleep(), maxAttempts: 1 }));
});
