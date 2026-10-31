// Drive + Sheets wrapper: retry, permanence, tab creation, header-ordered append.
import test from "node:test";
import assert from "node:assert/strict";

import { createDrive, DriveError } from "../js/drive.js";

const res = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });

function rig(handler, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body };
    calls.push(call);
    return handler(call, calls.length);
  };
  const sleeps = [];
  const drive = createDrive({ fetchImpl, getToken: async () => "TOK", sleep: async ms => { sleeps.push(ms); }, maxRetries: 4, baseDelayMs: 100, ...extra });
  return { drive, calls, sleeps };
}

test("requests carry the bearer token", async () => {
  const { drive, calls } = rig(() => res({ files: [] }));
  await drive.listProjectsIn("ROOT");
  assert.equal(calls[0].headers.Authorization, "Bearer TOK");
});

test("listProjectsIn returns only folders inside the root", async () => {
  const { drive, calls } = rig(() => res({ files: [{ id: "p1", name: "Anaemia" }] }));
  const out = await drive.listProjectsIn("ROOT");
  assert.deepEqual(out, [{ id: "p1", name: "Anaemia" }]);
  const q = new URL(calls[0].url).searchParams.get("q");
  assert.match(q, /'ROOT' in parents/);
  assert.match(q, /mimeType = 'application\/vnd\.google-apps\.folder'/);
  assert.match(q, /trashed = false/);
});

test("listForms matches *.spec.json and follows pagination", async () => {
  const pages = [
    { files: [{ id: "f1", name: "a.spec.json" }], nextPageToken: "N" },
    { files: [{ id: "f2", name: "b.spec.json" }, { id: "x", name: "notes.txt" }] },
  ];
  const { drive } = rig((c, i) => res(pages[i - 1]));
  const out = await drive.listForms("P1");
  assert.deepEqual(out.map(f => f.id), ["f1", "f2"]);
});

test("a quote in a name or id cannot break out of the Drive query", async () => {
  const { drive, calls } = rig(() => res({ files: [] }));
  await drive.findOrCreateSpreadsheet("P1", "it's").catch(() => {});
  const q = new URL(calls[0].url).searchParams.get("q");
  assert.match(q, /name = 'it\\'s'/);
});

test("readSpec fetches alt=media and parses JSON", async () => {
  const { drive, calls } = rig(() => res({ form_id: "x", version: 1 }));
  assert.deepEqual(await drive.readSpec("FID"), { form_id: "x", version: 1 });
  assert.match(calls[0].url, /files\/FID\?.*alt=media/);
});

test("a 429 is retried with exponential backoff, then succeeds", async () => {
  const { drive, calls, sleeps } = rig((c, i) => (i < 3 ? res({ error: {} }, 429) : res({ files: [] })), { jitter: () => 1 });
  await drive.listProjectsIn("ROOT");
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] >= sleeps[0] * 1.5, `backoff should grow: ${sleeps}`);
});

test("5xx is retried, and gives up with a clear error after the limit", async () => {
  const { drive, calls } = rig(() => res({}, 503));
  await assert.rejects(() => drive.listProjectsIn("ROOT"), e => e instanceof DriveError && e.status === 503 && e.retryable === true);
  assert.equal(calls.length, 5); // 1 + 4 retries
});

test("a network failure is retried and then surfaced, not swallowed", async () => {
  let n = 0;
  const drive = createDrive({ fetchImpl: async () => { n++; throw new TypeError("Failed to fetch"); }, getToken: async () => "T", sleep: async () => {}, maxRetries: 2, baseDelayMs: 1 });
  await assert.rejects(() => drive.listProjectsIn("R"), e => e instanceof DriveError && e.retryable === true);
  assert.equal(n, 3);
});

test("403 is permanent: one call, no retry, error carries status", async () => {
  const { drive, calls, sleeps } = rig(() => res({ error: { message: "no access" } }, 403));
  await assert.rejects(() => drive.readSpec("F"), e => e.status === 403 && e.retryable === false);
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
});

test("uploadMedia is a multipart upload into the folder and returns id + link", async () => {
  const { drive, calls } = rig(() => res({ id: "M1", webViewLink: "https://drive.google.com/file/d/M1/view" }));
  const out = await drive.uploadMedia("P1", "a.jpg", new Blob(["xx"], { type: "image/jpeg" }));
  assert.deepEqual(out, { id: "M1", link: "https://drive.google.com/file/d/M1/view" });
  assert.match(calls[0].url, /upload\/drive\/v3\/files\?uploadType=multipart/);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].headers["Content-Type"], /^multipart\/related; boundary=/);
  const text = Buffer.from(await new Blob([calls[0].body]).arrayBuffer()).toString("latin1");
  assert.match(text, /"parents":\["P1"\]/);
  assert.match(text, /"name":"a\.jpg"/);
});

test("findOrCreateSpreadsheet reuses an existing one", async () => {
  const { drive, calls } = rig(() => res({ files: [{ id: "S1", name: "Data" }] }));
  assert.equal(await drive.findOrCreateSpreadsheet("P1", "Data"), "S1");
  assert.equal(calls.length, 1);
});

test("findOrCreateSpreadsheet creates one in the project folder when absent", async () => {
  const { drive, calls } = rig((c) => (c.method === "GET" ? res({ files: [] }) : res({ id: "S2" })));
  assert.equal(await drive.findOrCreateSpreadsheet("P1", "Data"), "S2");
  const body = JSON.parse(calls[1].body);
  assert.deepEqual(body.parents, ["P1"]);
  assert.equal(body.mimeType, "application/vnd.google-apps.spreadsheet");
});

test("ensureTab creates a missing tab and writes the header row", async () => {
  const { drive, calls } = rig((c) => {
    if (c.method === "GET") return res({ sheets: [{ properties: { title: "Other" } }] });
    return res({});
  });
  await drive.ensureTab("S1", "form_a", ["uuid", "age"]);
  const batch = calls.find(c => c.url.includes(":batchUpdate"));
  assert.equal(JSON.parse(batch.body).requests[0].addSheet.properties.title, "form_a");
  const put = calls.find(c => c.method === "PUT");
  assert.match(decodeURIComponent(put.url), /values\/form_a!A1/);
  assert.deepEqual(JSON.parse(put.body).values, [["uuid", "age"]]);
});

test("ensureTab reuses an existing tab: no create, no header rewrite", async () => {
  const { drive, calls } = rig(() => res({ sheets: [{ properties: { title: "form_a" } }] }));
  await drive.ensureTab("S1", "form_a", ["uuid"]);
  assert.equal(calls.length, 1);
});

test("ensureTab treats 'already exists' from a racing client as success", async () => {
  const { drive, calls } = rig((c) => {
    if (c.method === "GET") return res({ sheets: [] });
    if (c.url.includes(":batchUpdate")) return res({ error: { message: "A sheet with the name \"t\" already exists." } }, 400);
    return res({});
  });
  await drive.ensureTab("S1", "t", ["a"]);
  assert.ok(!calls.some(c => c.method === "PUT"), "the loser must not rewrite the header");
});

test("appendRow sends values in the tab's header order", async () => {
  const { drive, calls } = rig((c) => {
    if (decodeURIComponent(c.url).includes("/values/form_a!1:1")) return res({ values: [["uuid", "age", "name"]] });
    return res({ updates: {} });
  });
  await drive.appendRow("S1", "form_a", { name: "Sita", uuid: "u1", age: 7, extra: "ignored" });
  const app = calls.find(c => c.url.includes(":append"));
  assert.equal(app.method, "POST");
  assert.match(app.url, /valueInputOption=RAW/);
  assert.match(app.url, /insertDataOption=INSERT_ROWS/);
  assert.deepEqual(JSON.parse(app.body).values, [["u1", 7, "Sita"]]);
});

test("appendRow accepts an array and sends it as-is", async () => {
  const { drive, calls } = rig(() => res({}));
  await drive.appendRow("S1", "t", ["a", 1]);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body).values, [["a", 1]]);
});

test("appendRow failure propagates so the caller keeps the submission", async () => {
  const { drive } = rig((c) => (decodeURIComponent(c.url).includes("!1:1") ? res({ values: [["a"]] }) : res({}, 400)));
  await assert.rejects(() => drive.appendRow("S1", "t", { a: 1 }), e => e.status === 400 && e.retryable === false);
});

test("values starting with = are kept literal (RAW input, no formula injection)", async () => {
  const { drive, calls } = rig(() => res({}));
  await drive.appendRow("S1", "t", ["=HYPERLINK(\"x\")"]);
  assert.match(calls[0].url, /valueInputOption=RAW/);
});

// ---- Picker-granted projects -------------------------------------------------------

function memStore(initial) {
  let s = initial;
  return {
    async getSession() { return s && structuredClone(s); },
    async putSession(v) { s = structuredClone({ ...v, id: "current" }); },
    peek: () => s,
  };
}

test("addProject records the picked folder; listProjects then shows it; sign-in data is untouched", async () => {
  const store = memStore({ google: { access_token: "x" } });
  const drive = createDrive({ fetchImpl: async () => { throw new Error("no network"); }, getToken: async () => "TOK", store, pickFolder: async tok => { assert.equal(tok, "TOK"); return { id: "F1", name: "Anaemia" }; } });
  assert.deepEqual(await drive.listProjects(), []);
  assert.deepEqual(await drive.addProject(), { id: "F1", name: "Anaemia" });
  assert.deepEqual(await drive.listProjects(), [{ id: "F1", name: "Anaemia" }]);
  assert.equal(store.peek().google.access_token, "x");
});

test("picking the same folder twice lists it once; cancel adds nothing; remove works", async () => {
  const store = memStore();
  let next = { id: "F1", name: "A" };
  const drive = createDrive({ getToken: async () => "T", store, pickFolder: async () => next });
  await drive.addProject(); await drive.addProject();
  assert.equal((await drive.listProjects()).length, 1);
  next = null;
  assert.equal(await drive.addProject(), null);
  assert.equal((await drive.listProjects()).length, 1);
  await drive.removeProject("F1");
  assert.deepEqual(await drive.listProjects(), []);
});

test("a Picker failure is thrown, not swallowed, and records nothing", async () => {
  const store = memStore();
  const drive = createDrive({ getToken: async () => "T", store, pickFolder: async () => { throw new DriveError("offline", { retryable: true }); } });
  await assert.rejects(() => drive.addProject(), /offline/);
  assert.deepEqual(await drive.listProjects(), []);
});

test("findOrCreateSpreadsheet: if a racing phone also created one, the oldest wins", async () => {
  let gets = 0;
  const { drive, calls } = rig((c) => {
    if (c.method === "GET") { gets++; return gets === 1 ? res({ files: [] }) : res({ files: [{ id: "OLD" }, { id: "MINE" }] }); }
    return res({ id: "MINE" });
  });
  assert.equal(await drive.findOrCreateSpreadsheet("P1", "Data"), "OLD");
  assert.match(decodeURIComponent(calls[0].url), /orderBy=createdTime/);
});
