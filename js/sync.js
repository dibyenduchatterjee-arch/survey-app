// Offline sync: bootstrap (forms and datasets down) and the upload queue (answers up).
//
// What this file guarantees, because an ASHA's day of household visits depends on it:
//
//   * A queued submission leaves the device in exactly two ways: the server
//     confirmed it (200 or 201 with OUR uuid in the receipt), or the server
//     definitively refused it and the full refusal, answers and photos were first
//     written to the rejection record (REJECTED_STORE) where the app and a
//     supervisor can see it. Every other outcome, a 5xx, a timeout, a dropped
//     connection, a captive portal, a 401, a failed write, leaves it queued.
//   * Uploads are one at a time, oldest first, and one bad submission never
//     blocks the ones behind it.
//   * The client uuid is the idempotency key, so a reply lost in transit is
//     harmless: the next attempt returns 200 with the original receipt.
//
// `fetchImpl` and `store` are parameters so the logic is testable in Node.

import * as defaultStore from './db.js';
import { makeAuthFetch } from './auth.js';

// Where definitively-refused submissions are kept. db.js has no store for them and
// db.js is not ours to change, so they live in the `preload` store under a name no
// server dataset can have (dataset names never start with an underscore).
export const REJECTED_STORE = '_rejected_submissions';

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 300_000;
export const SYNC_INTERVAL_MS = 60_000;
const BATCH = 200;
const MAX_CONSECUTIVE_SERVER_ERRORS = 3;
const DATASET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,149}$/;
const RETRYABLE_4XX = new Set([408, 425, 429]);

const defaultFetch = () => globalThis.fetch.bind(globalThis);

// ---- shared state ----------------------------------------------------------------

const state = { failures: 0, running: null, active: false, timer: null, ticking: false, rerun: false, onOnline: null, bootstrapped: false };

export function _resetSyncState() {
  state.failures = 0;
  state.running = null;
  state.bootstrapped = false;
  stopSync();
}

export function backoffDelay(failures) {
  if (!(failures > 0)) return 0;
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
}

// ---- building the request --------------------------------------------------------

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'video/webm': 'webm' };

function buildBody(item, media) {
  // queued_at and user_id are the device's own bookkeeping; the server has no use for them.
  const { queued_at, user_id, ...wire } = item; // eslint-disable-line no-unused-vars
  const fd = new FormData();
  fd.set('submission', JSON.stringify(wire));
  for (const m of media) {
    const ext = EXT[m.blob && m.blob.type] || 'bin';
    fd.set(m.question, m.blob, `${m.question}.${ext}`);
  }
  return fd;
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

function describeDetail(detail) {
  if (typeof detail === 'string') return { code: null, message: detail };
  if (Array.isArray(detail)) {
    return { code: null, message: detail.map(d => (d && d.msg) || JSON.stringify(d)).join('; ') };
  }
  if (detail && typeof detail === 'object') {
    return { code: detail.code || null, message: detail.message || JSON.stringify(detail) };
  }
  return { code: null, message: '' };
}

// ---- the rejection record --------------------------------------------------------

// Read-modify-write on one array, so writers go through one queue.
let recordChain = Promise.resolve();
function withRecord(fn) {
  const p = recordChain.then(fn, fn);
  recordChain = p.catch(() => {});
  return p;
}

export function listRejected({ store = defaultStore } = {}) {
  return store.getDataset(REJECTED_STORE).then(rows => rows || []);
}

function recordRejection(store, item, media, status, detail) {
  return withRecord(async () => {
    const { queued_at, ...submission } = item; // eslint-disable-line no-unused-vars
    const { code, message } = describeDetail(detail);
    const rows = (await store.getDataset(REJECTED_STORE)) || [];
    const next = rows.filter(r => r.uuid !== item.uuid);
    next.push({
      uuid: item.uuid,
      form_id: item.form_id,
      version: item.version,
      status,
      code,
      message,
      rejected_at: new Date().toISOString(),
      submission,
      media: media.map(m => ({ question: m.question, blob: m.blob })),
    });
    await store.putDataset(REJECTED_STORE, next);   // resolves after the commit
  });
}

// Puts a refused submission back on the queue, answers and photos included, for
// when the cause has been fixed (an assignment added, a form version restored).
export function retryRejected(uuid, { store = defaultStore } = {}) {
  return withRecord(async () => {
    const rows = (await store.getDataset(REJECTED_STORE)) || [];
    const rec = rows.find(r => r.uuid === uuid);
    if (!rec) throw new Error('No rejected submission with that id');
    const blobs = {};
    for (const m of rec.media || []) blobs[m.question] = m.blob;
    await store.enqueue(rec.submission, blobs);                 // back on the queue first...
    await store.putDataset(REJECTED_STORE, rows.filter(r => r.uuid !== uuid)); // ...then off the record
  });
}

// ---- uploading -------------------------------------------------------------------

function classify(res, body, uuid) {
  const s = res.status;
  if (s === 200 || s === 201) {
    // A captive portal or proxy can answer 200 with a page. Only OUR receipt counts.
    return body && body.uuid === uuid ? (s === 201 ? 'created' : 'replay') : 'retry';
  }
  if (s === 401) return 'auth';
  if (s === 202) return 'retry';                       // attachments still outstanding
  if (s === 429) return 'throttled';
  if (s >= 500) return 'server';
  if (s >= 400 && !RETRYABLE_4XX.has(s)) {
    // Only a refusal in the server's own shape is a refusal. A bare 403 from a
    // captive portal or proxy says nothing about this submission.
    return body && body.detail !== undefined ? 'reject' : 'retry';
  }
  return 'retry';
}

async function run(fetchImpl, store) {
  const out = { uploaded: 0, replayed: 0, failed: 0, rejected: 0, skipped: 0, remaining: 0, authRequired: false, retryInMs: 0 };
  const session = await store.getSession();
  if (!session || session.needs_login || !session.access_token) {
    out.authRequired = true;
    out.remaining = await store.queueLength();
    return out;
  }
  const authed = makeAuthFetch(fetchImpl, { store });
  const items = await store.peekQueue(BATCH);
  let serverErrors = 0;
  let hadFailure = false;

  for (const item of items) {
    // A submission stamped for another user must not go up under this user's token.
    if (item.user_id !== undefined && session.user && item.user_id !== session.user.id) { out.skipped++; continue; }

    let media, res, body;
    try {
      media = await store.getMedia(item.uuid);
      res = await authed('/api/submissions', { method: 'POST', body: buildBody(item, media) });
      body = await readJson(res);
    } catch {
      // No network, a stalled connection, or a local read/write error. Whatever it
      // was, the submission is still queued. Stop: the next item would fail the same way.
      out.failed++; hadFailure = true;
      break;
    }

    const verdict = classify(res, body, item.uuid);
    if (verdict === 'created' || verdict === 'replay') {
      try {
        await store.dequeue(item.uuid);
      } catch {
        // Still queued; the next run replays it, the server answers 200, and it goes then.
        out.failed++; hadFailure = true;
        break;
      }
      serverErrors = 0;
      if (verdict === 'created') out.uploaded++; else out.replayed++;
    } else if (verdict === 'reject') {
      try {
        // The record is committed BEFORE the queue entry is removed. If it cannot be
        // written, the submission stays where it is.
        await recordRejection(store, item, media, res.status, body.detail);
        await store.dequeue(item.uuid);
        out.rejected++;
      } catch {
        out.failed++; hadFailure = true;
      }
    } else if (verdict === 'auth') {
      out.authRequired = true;       // refreshed once already; only a new login helps
      break;
    } else if (verdict === 'throttled') {
      out.failed++; hadFailure = true;
      break;
    } else if (verdict === 'server') {
      out.failed++; hadFailure = true;
      // One poisoned submission must not starve the rest, but a server that is
      // truly down should not be hammered either.
      if (++serverErrors >= MAX_CONSECUTIVE_SERVER_ERRORS) break;
    } else {
      out.failed++; hadFailure = true;
    }
  }

  out.remaining = await store.queueLength();
  if (hadFailure) {
    state.failures++;
    out.retryInMs = backoffDelay(state.failures);
  } else if (!out.authRequired) {
    state.failures = 0;
  }
  return out;
}

// Uploads what is queued. Concurrent callers (an `online` event racing the timer)
// share one run, so one submission is never in flight twice.
export function syncOnce(fetchImpl = defaultFetch(), { store = defaultStore } = {}) {
  if (state.running) return state.running;
  const p = run(fetchImpl, store).finally(() => { if (state.running === p) state.running = null; });
  state.running = p;
  return p;
}

// ---- bootstrap -------------------------------------------------------------------

// Names of the datasets a spec uses: `pulldata('name', ...)` in any expression, a
// `dataset` property on a node, or a top-level `datasets` / `preload` list.
export function datasetNames(spec) {
  const names = new Set();
  const add = n => { if (typeof n === 'string' && DATASET_NAME.test(n)) names.add(n); };
  for (const key of ['datasets', 'preload']) if (Array.isArray(spec && spec[key])) spec[key].forEach(add);
  const re = /pulldata\(\s*(['"])([^'"]+)\1/g;
  const walk = v => {
    if (typeof v === 'string') { for (const m of v.matchAll(re)) add(m[2]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) { if (k === 'dataset') add(x); walk(x); }
    }
  };
  walk(spec);
  return names;
}

const enc = encodeURIComponent;

// Downloads the caller's assigned forms and every dataset they use. Each form
// version is stored under its own [form_id, version] key and nothing is ever
// deleted or replaced, so a draft in progress finishes on the version it started
// on. Drafts are not read or written here at all.
export async function bootstrap(fetchImpl = defaultFetch(), { store = defaultStore } = {}) {
  const authed = makeAuthFetch(fetchImpl, { store });
  const out = { forms: [], datasets: [], errors: [] };

  const listRes = await authed('/api/forms');
  if (!listRes.ok) throw new Error(`Could not list forms (${listRes.status})`);
  const list = await listRes.json();
  if (!Array.isArray(list)) throw new Error('Form list was not a list');

  const specs = [];
  for (const f of list) {
    if (!f || !f.current_version) continue; // nothing published yet
    const version = String(f.current_version);
    try {
      let spec = await store.getForm(f.form_id, version);
      let downloaded = false;
      if (!spec) {
        const res = await authed(`/api/forms/${enc(f.form_id)}/versions/${enc(version)}/spec`);
        if (!res.ok) throw new Error(`spec download failed (${res.status})`);
        spec = await res.json();
        if (!spec || spec.form_id !== f.form_id || String(spec.version) !== version) {
          throw new Error('spec does not match the form list entry');
        }
        await store.putForm(spec);
        downloaded = true;
      }
      out.forms.push({ form_id: f.form_id, version, downloaded });
      specs.push(spec);
    } catch (e) {
      out.errors.push({ form_id: f.form_id, version, error: String((e && e.message) || e) });
    }
  }

  const wanted = new Set();
  for (const spec of specs) for (const n of datasetNames(spec)) if (!n.startsWith('_')) wanted.add(n);
  for (const name of wanted) {
    try {
      const res = await authed(`/api/datasets/${enc(name)}`);
      if (!res.ok) throw new Error(`dataset download failed (${res.status})`);
      const data = await res.json();
      if (!data || !Array.isArray(data.rows)) throw new Error('dataset had no rows');
      await store.putDataset(name, data.rows);
      out.datasets.push(name);
    } catch (e) {
      out.errors.push({ dataset: name, error: String((e && e.message) || e) });  // the old copy stays
    }
  }
  return out;
}

// ---- the background loop ---------------------------------------------------------

export function startSync({ fetchImpl = defaultFetch(), store = defaultStore, intervalMs = SYNC_INTERVAL_MS } = {}) {
  if (state.active) return;
  state.active = true;

  const tick = async reconnected => {
    if (!state.active) return;
    if (state.ticking) { if (reconnected) state.rerun = true; return; }
    state.ticking = true;
    let delay = intervalMs;
    try {
      if (globalThis.navigator && globalThis.navigator.onLine === false) {
        // wait for the `online` event; the timer below is only a safety net
      } else {
        // Upload first: getting the day's work off the phone matters more than new forms.
        const r = await syncOnce(fetchImpl, { store });
        if (r.retryInMs) delay = r.retryInMs;
        if ((reconnected || !state.bootstrapped) && !r.authRequired) {
          try { await bootstrap(fetchImpl, { store }); state.bootstrapped = true; } catch { /* next time */ }
        }
      }
    } catch { /* never let the loop die */ }
    state.ticking = false;
    if (!state.active) return;
    if (state.rerun) { state.rerun = false; delay = 0; }
    state.timer = setTimeout(() => tick(false), delay * (0.8 + Math.random() * 0.4));
  };

  state.onOnline = () => {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    tick(true);
  };
  if (globalThis.addEventListener) globalThis.addEventListener('online', state.onOnline);
  tick(true);
}

export function stopSync() {
  state.active = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.onOnline && globalThis.removeEventListener) globalThis.removeEventListener('online', state.onOnline);
  state.onOnline = null;
  state.ticking = false;
  state.rerun = false;
}
