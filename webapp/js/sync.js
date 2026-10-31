// Offline sync: bootstrap (forms and datasets down) and the upload queue (answers up).
//
// What this file guarantees, because an ASHA's day of household visits depends on it:
//
//   * A queued submission leaves the device in exactly two ways: the server
//     confirmed it (200 or 201 with OUR uuid in the receipt), or the server
//     definitively refused it and the full refusal, answers and photos were first
//     written to the rejection record (db.js `rejected` store) where the app and a
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

// Definitively-refused submissions go to db.js's own `rejected` store, which no
// dataset refresh ever writes to.

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 300_000;
export const SYNC_INTERVAL_MS = 60_000;
const BATCH = 200;
const MAX_CONSECUTIVE_SERVER_ERRORS = 3;
const DATASET_NAME = /^[A-Za-z0-9_-]{1,150}$/;
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

export function listRejected({ store = defaultStore } = {}) {
  return store.listRejected();
}

function recordRejection(store, item, media, status, detail) {
  const { queued_at, ...submission } = item; // eslint-disable-line no-unused-vars
  const { code, message } = describeDetail(detail);
  return store.putRejected({            // resolves after the commit
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
}

// Puts a refused submission back on the queue, answers and photos included, for
// when the cause has been fixed (an assignment added, a form version restored).
export async function retryRejected(uuid, { store = defaultStore } = {}) {
  const rec = await store.getRejected(uuid);
  if (!rec) throw new Error('No rejected submission with that id');
  const blobs = {};
  for (const m of rec.media || []) blobs[m.question] = m.blob;
  await store.enqueue(rec.submission, blobs);   // back on the queue first...
  await store.deleteRejected(uuid);             // ...then off the record
}

// ---- uploading -------------------------------------------------------------------

function classify(res, body, uuid) {
  const s = res.status;
  if (s === 200 || s === 201) {
    // A captive portal or proxy can answer 200 with a page. Only OUR receipt counts.
    // The server canonicalises uuids to lower case, so compare that way.
    return body && typeof body.uuid === 'string' && body.uuid.toLowerCase() === String(uuid).toLowerCase()
      ? (s === 201 ? 'created' : 'replay') : 'retry';
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

const enc = encodeURIComponent;

// Downloads the caller's assigned forms, every dataset they can see and the client
// config. Returns { forms, datasets, config, errors }; config is {} if it failed. Each form
// version is stored under its own [form_id, version] key and nothing is ever
// deleted or replaced, so a draft in progress finishes on the version it started
// on. Drafts are not read or written here at all.
export async function bootstrap(fetchImpl = defaultFetch(), { store = defaultStore } = {}) {
  const authed = makeAuthFetch(fetchImpl, { store });
  const out = { forms: [], datasets: [], config: {}, errors: [] };

  const listRes = await authed('/api/forms');
  if (!listRes.ok) throw new Error(`Could not list forms (${listRes.status})`);
  const list = await listRes.json();
  if (!Array.isArray(list)) throw new Error('Form list was not a list');

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
    } catch (e) {
      out.errors.push({ form_id: f.form_id, version, error: String((e && e.message) || e) });
    }
  }

  // Client settings (max_media_bytes, the one media size cap). Forms work without
  // it, so a failure is recorded and bootstrap carries on.
  try {
    const res = await authed('/api/config');
    if (!res.ok) throw new Error(`config download failed (${res.status})`);
    const cfg = await res.json();
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('config was not an object');
    out.config = cfg;
  } catch (e) {
    out.errors.push({ config: true, error: String((e && e.message) || e) });
  }

  // Phase 1 has no pulldata-style external lookups (a Phase 2 item), so nothing in
  // a spec says which datasets it needs. Take every dataset the caller can see.
  let names = [];
  try {
    const res = await authed('/api/datasets');
    if (res.status === 404 || res.status === 405) {
      out.errors.push({ dataset: '*', error: 'server has no dataset listing (GET /api/datasets)' });
    } else if (!res.ok) {
      throw new Error(`dataset list failed (${res.status})`);
    } else {
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error('dataset list was not a list');
      names = body.map(d => (typeof d === 'string' ? d : d && d.name)).filter(n => typeof n === 'string' && DATASET_NAME.test(n));
    }
  } catch (e) {
    out.errors.push({ dataset: '*', error: String((e && e.message) || e) });
  }
  for (const name of names) {
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
