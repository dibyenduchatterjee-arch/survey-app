// Offline sync against the Apps Script backend: bootstrap (each held project's form specs down)
// and the upload queue (submissions up, one at a time). The Apps Script does the Drive and
// Sheets work; the phone never talks to Google directly.
//
// What this file guarantees, because an ASHA's day of household visits depends on it:
//
//   * A queued submission leaves the device in exactly two ways: the backend confirmed it
//     (`created`, or `duplicate` meaning its row is already there), or the backend definitively
//     refused it (bad_request, too_large, layout_mismatch) and the full refusal, answers and
//     photos were first written to the rejection record (db.js `rejected` store). Every other
//     outcome (busy, server_error, a quota refusal, an HTML error page, a dropped connection,
//     an expired or withdrawn project code, a failed local write) leaves it queued.
//   * Uploads are one at a time, oldest first, with jittered exponential backoff when the
//     backend says retry.
//   * Signing out of a project, or losing access to it, touches nothing in the queue. Nothing in
//     this file writes to the queue except dequeue-after-success.
//
// IDEMPOTENCY. The submission's uuid is minted once, when the form is finished, and travels
// with the queued record. Every retry sends THAT uuid, so the backend (which checks the uuid
// before appending, under a lock) answers `duplicate` instead of writing a second row. This
// file never mints a uuid.
//
// MORE THAN ONE PROJECT. Each stored form spec is tagged `_project: {id, name}` (id = the
// project's key on this phone) and its form_id is prefixed with that key, so the same form in
// two projects is two separate forms on the phone. A queued submission carries the prefixed
// form_id, which is how it finds its project, its token and nothing else.
//
// `store`, `fetchImpl`, `url`, `sleep` and `random` are parameters so the logic is testable in
// Node with no network.

import * as defaultStore from './db.js';
import { ApiError, callApi, listProjects, tokenFor } from './projects.js';

export const BACKOFF_BASE_MS = 5_000;       // between whole sync runs, after a failed run
export const BACKOFF_CAP_MS = 300_000;
export const SYNC_INTERVAL_MS = 60_000;
const RETRY_BASE_MS = 1_000;                // between attempts on one call
const RETRY_CAP_MS = 30_000;
const MAX_ATTEMPTS = 5;
const BATCH = 200;
const MAX_CONSECUTIVE_KEEPS = 3;
// The only replies that mean "the backend will never accept this", so retrying cannot help.
const REFUSALS = new Set(['bad_request', 'too_large', 'layout_mismatch']);
// A refusal that is really Google's rate limiter or quota talking.
const QUOTA_TEXT = /quota|rate.?limit|too many (times|requests|simultaneous)|exceeded|service invoked/i;

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

const normalise = a => (a && typeof a === 'object' ? a : {});

// Stored forms are namespaced by project: `<project key>::<form id>`.
const SEP = '::';
export const namespacedFormId = (projectKey, formId) => `${projectKey}${SEP}${formId}`;
export function splitFormId(id) {
  const s = String(id);
  const i = s.indexOf(SEP);
  return i < 0 ? { project: '', form: s } : { project: s.slice(0, i), form: s.slice(i + SEP.length) };
}

// ---- retry and error classification ----------------------------------------------

const isQuota = e => !!e && e instanceof ApiError && !REFUSALS.has(e.code) && QUOTA_TEXT.test(`${e.code} ${e.message}`);
const isTransient = e => !!e && (e.retry === true || isQuota(e));
const isRefusal = e => !!e && e instanceof ApiError && REFUSALS.has(e.code) && !e.retry;
const isAccessLost = e => !!e && (e.code === 'revoked');

class Exhausted extends Error {
  constructor(cause) { super('The server kept failing: ' + ((cause && cause.message) || cause)); this.cause = cause; this.exhausted = true; this.retryAfterMs = (cause && cause.retryAfterMs) || 0; }
}
class Skip extends Error {}

function makeRetry({ sleep, random, maxAttempts }) {
  return async fn => {
    let last;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try { return await fn(); } catch (e) {
        if (!isTransient(e)) throw e;
        last = e;
        if (attempt === maxAttempts) break;
        const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
        // Jitter: 76 phones must not retry in step. The server's own retry_after_s is a minute or
        // two; it is honoured between whole sync runs (see out.retryInMs), not by sleeping here.
        await sleep(ceiling * (0.5 + random() * 0.5));
      }
    }
    throw new Exhausted(last);
  };
}

function config(o) {
  return {
    store: o.store || defaultStore,
    fetchImpl: o.fetchImpl,
    url: o.url,
    retry: makeRetry({
      sleep: o.sleep || (ms => new Promise(r => setTimeout(r, ms))),
      random: o.random || Math.random,
      maxAttempts: o.maxAttempts || MAX_ATTEMPTS,
    }),
  };
}

// Calls the backend for one project with its token. A `session` reply means the token lapsed or
// was revoked: re-open once with the stored code and send again. If the backend then refuses the
// code, access has been withdrawn (ApiError 'revoked'): the caller keeps the queue as it is.
async function projectCall(ctx, key, body) {
  const { store, fetchImpl, url } = ctx;
  let token = await tokenFor(key, { fetchImpl, store, url });
  try {
    return await callApi({ ...body, token }, { fetchImpl, url });
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'session') throw e;
    token = await tokenFor(key, { fetchImpl, store, url, force: true });
    try {
      return await callApi({ ...body, token }, { fetchImpl, url });
    } catch (e2) {
      // Still "session" straight after a good re-open: treat as a hiccup and try again later.
      if (e2 instanceof ApiError && e2.code === 'session') throw new ApiError('session', e2.message, { retry: true });
      throw e2;
    }
  }
}

// ---- layout of the spreadsheet ---------------------------------------------------

// No _submitted_by: the backend stamps the person's name from their code.
const META = ['_gps', '_started_at', '_finished_at', '_device_id', '_form_version'];

// Questions that become columns: groups are transparent; repeats and notes are not columns.
function questions(nodes) {
  const out = [];
  for (const n of nodes || []) {
    if (n.type === 'group') out.push(...questions(n.children));
    else if (n.type !== 'repeat' && n.type !== 'note') out.push(n);
  }
  return out;
}

// Every repeat, nested ones included: [{ path: ['children','doses'], node }].
function repeats(nodes, path = []) {
  const out = [];
  for (const n of nodes || []) {
    if (n.type === 'group') out.push(...repeats(n.children, path));
    else if (n.type === 'repeat') {
      out.push({ path: [...path, n.name], node: n });
      out.push(...repeats(n.children, [...path, n.name]));
    }
  }
  return out;
}

// Tab names: [A-Za-z0-9_-], at most 100 characters (the backend refuses anything else).
const tabName = (formId, path = []) => [formId, ...path].join('_').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);

// Rows of the repeat at `path` for one submission: [{ keys: [outer idx..., idx], data }].
function repeatRows(sub, path) {
  let level = (Array.isArray(sub.repeats && sub.repeats[path[0]]) ? sub.repeats[path[0]] : [])
    .map((data, i) => ({ keys: [i + 1], data: data || {} }));
  for (const name of path.slice(1)) {
    const next = [];
    for (const { keys, data } of level) {
      const inner = data[name];
      if (Array.isArray(inner)) inner.forEach((d, i) => next.push({ keys: [...keys, i + 1], data: d || {} }));
    }
    level = next;
  }
  return level;
}

// Cells must be string, number, boolean or empty; lists and objects are flattened.
function cell(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(String).join(' ');
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number' && !Number.isFinite(v)) return '';
  return v;
}

function gpsCell(item) {
  return Number.isFinite(item.gps_lat) && Number.isFinite(item.gps_lon) ? `${item.gps_lat} ${item.gps_lon}` : '';
}

const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'audio/webm', 'audio/mpeg', 'audio/mp4']);
const mimeOf = blob => String((blob && blob.type) || '').split(';')[0].trim().toLowerCase();

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// The request body for one queued submission. Pure apart from reading the photos.
// Repeat tabs first, the main tab last (the backend writes in that order anyway).
export async function buildSubmitBody(item, spec, media) {
  const formName = spec._form_id || splitFormId(spec.form_id).form;
  const qs = questions(spec.nodes);
  const tabs = [];
  const tabQuestions = new Map();     // tab name -> question names it holds
  for (const { path, node } of repeats(spec.nodes)) {
    const rows = repeatRows(item, path);
    if (!rows.length) continue;
    const rqs = questions(node.children);
    const keyCols = ['parent_uuid', ...path.slice(0, -1).map(p => `${p}_row_index`), 'row_index'];
    const name = tabName(formName, path);
    tabs.push({
      name, kind: 'repeat', key: keyCols,
      rows: rows.map(({ keys, data }) => {
        const row = { parent_uuid: item.uuid, row_index: keys[keys.length - 1] };
        path.slice(0, -1).forEach((p, i) => { row[`${p}_row_index`] = keys[i]; });
        for (const q of rqs) row[q.name] = cell(data[q.name]);
        return row;
      }),
    });
    tabQuestions.set(name, new Set(rqs.map(q => q.name)));
  }
  const mainName = tabName(formName);
  const main = { uuid: item.uuid };
  for (const q of qs) main[q.name] = cell((item.data || {})[q.name]);
  Object.assign(main, {
    _gps: gpsCell(item),
    _started_at: item.started_at || '',
    _finished_at: item.finished_at || '',
    _device_id: item.device_id || '',
    _form_version: String(item.version || spec.version),
  });
  tabs.push({ name: mainName, kind: 'main', key: ['uuid'], rows: [main] });
  tabQuestions.set(mainName, new Set(qs.map(q => q.name)));

  // Photos: the backend puts the Drive link in the named cell, so that cell is sent empty (it is,
  // since a photo question has no typed answer).
  const photos = [];
  for (const m of media) {
    const mime = mimeOf(m.blob);
    const where = [mainName, ...[...tabQuestions.keys()].filter(n => n !== mainName)].find(n => tabQuestions.get(n).has(m.question));
    if (!where) continue;                              // a photo for a question no tab holds
    const p = { question: m.question, mime: MIME.has(mime) ? mime : (mime || 'application/octet-stream'), data_base64: await toBase64(m.blob) };
    if (where !== mainName) { p.tab = where; p.row = 0; }
    photos.push(p);
  }
  return { action: 'submit', uuid: item.uuid, tabs, photos };
}

// ---- the rejection record --------------------------------------------------------

export function listRejected({ store = defaultStore } = {}) {
  return store.listRejected();
}

function recordRejection(store, item, media, err) {
  const { queued_at, ...submission } = item; // eslint-disable-line no-unused-vars
  return store.putRejected({            // resolves after the commit
    uuid: item.uuid,
    form_id: item.form_id,
    version: item.version,
    status: null,
    code: err.code,
    message: String(err.message || '').slice(0, 500),
    rejected_at: new Date().toISOString(),
    submission,
    media: media.map(m => ({ question: m.question, blob: m.blob })),
  });
}

// Puts a refused submission back on the queue, answers and photos included, for
// when the cause has been fixed (a layout repaired, a form corrected).
export async function retryRejected(uuid, { store = defaultStore } = {}) {
  const rec = await store.getRejected(uuid);
  if (!rec) throw new Error('No rejected submission with that id');
  const blobs = {};
  for (const m of rec.media || []) blobs[m.question] = m.blob;
  await store.enqueue(rec.submission, blobs);   // back on the queue first...
  await store.deleteRejected(uuid);             // ...then off the record
}

// ---- uploading -------------------------------------------------------------------

// One submission, start to finish. Throws on any failure; returns 'created' or 'duplicate'.
async function sendOne(item, spec, media, ctx) {
  const body = await buildSubmitBody(item, spec, media);
  const reply = await ctx.retry(() => projectCall(ctx, spec._project.id, body));
  return reply.status === 'duplicate' ? 'duplicate' : 'created';
}

async function run(ctx) {
  const { store } = ctx;
  const out = { uploaded: 0, replayed: 0, failed: 0, rejected: 0, skipped: 0, remaining: 0, authRequired: false, lostProjects: [], retryInMs: 0 };
  const items = await store.peekQueue(BATCH);
  if (!items.length) return out;                       // an empty queue touches nothing

  let keeps = 0;
  let hadFailure = false;
  let retryAfter = 0;
  const lost = new Set();

  for (const item of items) {
    let media = [];
    try {
      const spec = await store.getForm(item.form_id, String(item.version));
      if (!spec || !spec._project || !spec._project.id) throw new Skip();   // cannot route it yet: keep it
      if (lost.has(spec._project.id)) throw new Skip();
      const held = await store.getSessionRecord('project:' + spec._project.id);
      if (!held) throw new Skip();                     // signed out of that project: keep it
      // Rows are stamped with the NAME of whoever's code sends them. A record filled in under one
      // person's code must not go up under another's: it waits for its own person to enter their code.
      if (item.person && held.person && item.person !== held.person) throw new Skip();
      media = await store.getMedia(item.uuid);
      const verdict = await sendOne(item, spec, media, ctx);
      await store.dequeue(item.uuid);                  // only after the backend confirmed it
      keeps = 0;
      if (verdict === 'created') out.uploaded++; else out.replayed++;
    } catch (e) {
      if (e instanceof Skip) { out.skipped++; continue; }
      if (isAccessLost(e)) {                           // only a new code helps; queue untouched
        out.authRequired = true;
        const spec = await store.getForm(item.form_id, String(item.version)).catch(() => null);
        const id = spec && spec._project && spec._project.id;
        if (id) { lost.add(id); if (!out.lostProjects.includes(id)) out.lostProjects.push(id); }
        out.skipped++;
        continue;                                      // other projects can still go
      }
      if (isRefusal(e)) {
        try {
          // The record is committed BEFORE the queue entry goes. If it cannot be written, the
          // submission stays where it is.
          await recordRejection(store, item, media, e);
          await store.dequeue(item.uuid);
          out.rejected++;
        } catch { out.failed++; hadFailure = true; }
        continue;
      }
      out.failed++; hadFailure = true;
      if (e && e.retryAfterMs) retryAfter = Math.max(retryAfter, e.retryAfterMs);
      if (e && e.exhausted) break;                     // the backend is throttling or down: stop for now
      if (++keeps >= MAX_CONSECUTIVE_KEEPS) break;     // a local error or an odd one: keep, move on, cap
    }
  }

  out.remaining = await store.queueLength();
  if (hadFailure) {
    state.failures++;
    out.retryInMs = Math.max(backoffDelay(state.failures), retryAfter);
  } else if (!out.authRequired) {
    state.failures = 0;
  }
  return out;
}

// Uploads what is queued. Concurrent callers (an `online` event racing the timer)
// share one run, so one submission is never in flight twice.
export function syncOnce(options) {
  if (state.running) return state.running;
  const p = run(config(normalise(options))).finally(() => { if (state.running === p) state.running = null; });
  state.running = p;
  return p;
}

// ---- bootstrap -------------------------------------------------------------------

// Asks the backend for the form specs of EVERY project held on this phone and stores each
// (form_id, version) it has not seen. A stored version is NEVER replaced: a draft in progress
// finishes on the version it started on, and a new version sits beside the old one. Each stored
// spec is tagged `_project: {id, name}` and its form_id prefixed with the project key, so two
// projects never share or overwrite a form.
// Returns { forms, datasets, config, errors } (datasets and config kept empty for callers that
// still read them). Throws only if projects are held and none of them could be asked.
export async function bootstrap(options) {
  const o = normalise(options);
  const ctx = config(o);
  const { store, retry } = ctx;
  const out = { forms: [], datasets: [], config: {}, errors: [] };

  const projects = (await listProjects({ store })).filter(p => !p.revoked);
  let asked = 0;
  let unreachable = null;
  for (const project of projects) {
    let reply;
    try {
      reply = await retry(() => projectCall(ctx, project.key, { action: 'forms' }));
      asked++;
    } catch (e) {
      const text = isAccessLost(e) ? 'access withdrawn' : String((e && e.message) || e);
      out.errors.push({ project: project.name, error: text });
      if (isTransient(e) || (e && e.exhausted)) unreachable = e;
      continue;
    }
    const specs = Array.isArray(reply.forms) ? reply.forms : [];
    for (const name of Array.isArray(reply.skipped) ? reply.skipped : []) {
      out.errors.push({ project: project.name, file: String(name), error: 'not a readable form' });
    }
    for (const spec of specs) {
      try {
        if (!spec || typeof spec.form_id !== 'string' || !spec.version || !Array.isArray(spec.nodes)) throw new Error('not a form spec');
        const version = String(spec.version);
        const id = namespacedFormId(project.key, spec.form_id);
        const have = await store.getForm(id, version);
        if (!have) {
          await store.putForm({ ...spec, form_id: id, _form_id: spec.form_id, version, _project: { id: project.key, name: project.name } });
        }
        out.forms.push({ form_id: spec.form_id, version, project: project.name, downloaded: !have });
      } catch (e) {
        out.errors.push({ project: project.name, form_id: spec && spec.form_id, error: String((e && e.message) || e) });
      }
    }
  }
  if (projects.length && !asked && unreachable) throw unreachable;
  return out;
}

// ---- the background loop ---------------------------------------------------------

export function startSync(options = {}) {
  if (state.active) return;
  state.active = true;
  const o = normalise(options);
  const intervalMs = o.intervalMs || SYNC_INTERVAL_MS;

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
        const r = await syncOnce(o);
        if (r.retryInMs) delay = r.retryInMs;
        if (reconnected || !state.bootstrapped) {
          try { await bootstrap(o); state.bootstrapped = true; } catch { /* next time */ }
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
