// Offline sync, Drive-only: bootstrap (form specs down from Drive) and the upload queue
// (answers up to Google Sheets, photos up to Drive). There is no server.
//
// What this file guarantees, because an ASHA's day of household visits depends on it:
//
//   * A queued submission leaves the device in exactly two ways: it is confirmed in the
//     project's spreadsheet (its row is there, or was already there), or Google
//     definitively refused it and the full refusal, answers and photos were first written
//     to the rejection record (db.js `rejected` store). Every other outcome (a 5xx, a 429
//     that outlasts the retries, a dropped connection, an expired sign-in, a failed local
//     write) leaves it queued.
//   * Uploads are one at a time, oldest first, with jittered exponential backoff on
//     429 and 5xx.
//   * A forced re-sign-in touches nothing in the queue. Nothing in this file writes to the
//     queue except dequeue-after-success.
//
// IDEMPOTENCY WITHOUT A SERVER. Appending to a sheet twice makes two rows, and a dropped
// connection mid-append is exactly when that happens. So:
//   1. Before appending, the tab's first column is read and the submission is skipped if its
//      uuid is already there.
//   2. The uuid is column 1 of every tab (`uuid`, or `parent_uuid` on a repeat tab), so a
//      duplicate that slips through is easy to find and delete later.
//   3. The ORDER makes a half-finished submission recoverable: photos, then repeat rows
//      (each checked on its own key: parent uuid + row indexes), and the main row LAST.
//      The main row's presence therefore means everything before it landed.
// Check-then-append still has a small race window (two devices syncing the same uuid in the
// same second, or a lost reply read before the row becomes visible). Column 1 is the safety
// net for that; it is not airtight.
//
// The Drive calls come from drive.js (readColumns, ensureColumns included).
// `drive`, `store`, `getUser`, `sleep` and `random` are parameters so the logic is testable
// in Node with no network.

import * as defaultStore from './db.js';
import * as driveModule from './drive.js';

export const BACKOFF_BASE_MS = 5_000;       // between whole sync runs, after a failed run
export const BACKOFF_CAP_MS = 300_000;
export const SYNC_INTERVAL_MS = 60_000;
const RETRY_BASE_MS = 1_000;                // between attempts on one Google call
const RETRY_CAP_MS = 30_000;
const MAX_ATTEMPTS = 5;
const BATCH = 200;
const MAX_CONSECUTIVE_KEEPS = 3;
// Statuses that mean "Google will never accept this", so retrying cannot help.
const REJECT_STATUSES = new Set([400, 403, 404, 413, 422]);
// A 403 with one of these reasons is Google's rate limiter, not a permission problem.
const QUOTA_403 = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded|RATE_LIMIT|RESOURCE_EXHAUSTED/i;

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

// Old call shape was fn(fetchImpl, {store}); the new one is fn({store, drive, ...}).
// A function or nothing in the first slot is the legacy fetchImpl: ignored.
function normalise(a, b) {
  const first = a && typeof a === 'object' ? a : null;
  return first || (b && typeof b === 'object' ? b : {});
}

// ---- the Drive layer -------------------------------------------------------------

const defaultDrive = () => ({
  listProjects: driveModule.listProjects,
  listForms: driveModule.listForms,
  readSpec: driveModule.readSpec,
  uploadMedia: driveModule.uploadMedia,
  findOrCreateSpreadsheet: driveModule.findOrCreateSpreadsheet,
  ensureTab: driveModule.ensureTab,
  appendRow: driveModule.appendRow,
  readColumns: driveModule.readColumns,
  ensureColumns: driveModule.ensureColumns,
  listProjectsIn: driveModule.listProjectsIn,
});

async function defaultGetUser() {
  return (await import('./googleauth.js')).currentUser();
}

async function defaultRootFolder() {
  try { return (await import('../config.js')).config.rootFolderId; } catch { return undefined; }
}

// ---- retry and error classification ----------------------------------------------

const isAuth = e => !!e && (e.code === 'needs_signin' || e.status === 401);
const isQuota403 = e => !!e && e.status === 403 && QUOTA_403.test(String(e.body || e.message || ''));
const isTransient = e => !!e && !isAuth(e) && (e.retryable === true || e.status === 429 || e.status >= 500 || isQuota403(e));
const isRefusal = e => !!e && !isAuth(e) && !isTransient(e) && REJECT_STATUSES.has(e.status);

class Exhausted extends Error {
  constructor(cause) { super('Google kept failing: ' + ((cause && cause.message) || cause)); this.cause = cause; this.exhausted = true; }
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
        let wait = ceiling * (0.5 + random() * 0.5);          // jitter: 76 phones must not retry in step
        if (e.retryAfterMs) wait = Math.max(wait, e.retryAfterMs);
        await sleep(wait);
      }
    }
    throw new Exhausted(last);
  };
}

function config(o) {
  return {
    store: o.store || defaultStore,
    drive: o.drive || defaultDrive(),
    getUser: o.getUser || defaultGetUser,
    retry: makeRetry({
      sleep: o.sleep || (ms => new Promise(r => setTimeout(r, ms))),
      random: o.random || Math.random,
      maxAttempts: o.maxAttempts || MAX_ATTEMPTS,
    }),
  };
}

// ---- layout of the spreadsheet ---------------------------------------------------

const META = ['_gps', '_started_at', '_finished_at', '_device_id', '_submitted_by', '_form_version'];

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

// Tab names: Sheets forbids [ ] * ? : / \ and caps at 100 characters.
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

function cell(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(String).join(' ');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function gpsCell(item) {
  return Number.isFinite(item.gps_lat) && Number.isFinite(item.gps_lon) ? `${item.gps_lat} ${item.gps_lon}` : '';
}

const keyOf = cells => cells.map(c => String(c).trim().toLowerCase()).join('|');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'video/webm': 'webm' };

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
    status: err.status,
    code: null,
    message: String(err.message || '').slice(0, 500),
    rejected_at: new Date().toISOString(),
    submission,
    media: media.map(m => ({ question: m.question, blob: m.blob })),
  });
}

// Puts a refused submission back on the queue, answers and photos included, for
// when the cause has been fixed (access granted, folder restored).
export async function retryRejected(uuid, { store = defaultStore } = {}) {
  const rec = await store.getRejected(uuid);
  if (!rec) throw new Error('No rejected submission with that id');
  const blobs = {};
  for (const m of rec.media || []) blobs[m.question] = m.blob;
  await store.enqueue(rec.submission, blobs);   // back on the queue first...
  await store.deleteRejected(uuid);             // ...then off the record
}

// ---- uploading -------------------------------------------------------------------

// One submission, start to finish. Throws on any failure; returns 'created' or 'replay'.
async function sendOne(item, spec, media, user, ctx, sheets) {
  const { drive, retry } = ctx;
  const project = spec._project;
  const ssKey = project.id;
  if (!sheets.has(ssKey)) {
    sheets.set(ssKey, await retry(() => drive.findOrCreateSpreadsheet(project.id, `${project.name} - data`)));
  }
  const ss = sheets.get(ssKey);

  // Main tab first: uuid is column 1.
  const qs = questions(spec.nodes);
  const mainTab = tabName(spec.form_id);
  const mainHeader = ['uuid', ...qs.map(q => q.name), ...META];
  await retry(() => drive.ensureTab(ss, mainTab, mainHeader));
  // A newer form version may carry questions the tab has no column for. Add them (at the right-hand
  // end; columns are never reordered or removed) BEFORE writing, so no answer is ever dropped.
  await retry(() => drive.ensureColumns(ss, mainTab, mainHeader));
  const seen = await retry(() => drive.readColumns(ss, mainTab, 1));
  const uuidKey = keyOf([item.uuid]);
  if (seen.some(r => keyOf([r[0] ?? '']) === uuidKey)) return 'replay';

  // 1. photos
  const links = {};
  for (const m of media) {
    const ext = EXT[m.blob && m.blob.type] || 'bin';
    const up = await retry(() => drive.uploadMedia(project.id, `${item.uuid}_${m.question}.${ext}`, m.blob));
    links[m.question] = up.link;
  }
  const answer = (data, name) => (name in links ? links[name] : cell(data[name]));

  // 2. repeat rows, each checked on its own key so a half-written set is completed, not repeated
  for (const { path, node } of repeats(spec.nodes)) {
    const rows = repeatRows(item, path);
    if (!rows.length) continue;
    const rqs = questions(node.children);
    const keyCols = ['parent_uuid', ...path.slice(0, -1).map(p => `${p}_row_index`), 'row_index'];
    const tab = tabName(spec.form_id, path);
    const repHeader = [...keyCols, ...rqs.map(q => q.name)];
    await retry(() => drive.ensureTab(ss, tab, repHeader));
    await retry(() => drive.ensureColumns(ss, tab, repHeader));
    const have = new Set((await retry(() => drive.readColumns(ss, tab, keyCols.length))).map(r => keyOf(r.slice(0, keyCols.length))));
    for (const { keys, data } of rows) {
      if (have.has(keyOf([item.uuid, ...keys]))) continue;
      const row = { parent_uuid: item.uuid, row_index: keys[keys.length - 1] };
      path.slice(0, -1).forEach((p, i) => { row[`${p}_row_index`] = keys[i]; });
      for (const q of rqs) row[q.name] = answer(data, q.name);
      await retry(() => drive.appendRow(ss, tab, row));
    }
  }

  // 3. the main row, last
  const row = { uuid: item.uuid };
  for (const q of qs) row[q.name] = answer(item.data || {}, q.name);
  Object.assign(row, {
    _gps: gpsCell(item),
    _started_at: item.started_at || '',
    _finished_at: item.finished_at || '',
    _device_id: item.device_id || '',
    _submitted_by: (typeof item.user_id === 'string' && item.user_id.includes('@') ? item.user_id : user.email) || '',
    _form_version: String(item.version || spec.version),
  });
  await retry(() => drive.appendRow(ss, mainTab, row));
  return 'created';
}

async function run(ctx) {
  const { store, getUser } = ctx;
  const out = { uploaded: 0, replayed: 0, failed: 0, rejected: 0, skipped: 0, remaining: 0, authRequired: false, retryInMs: 0 };
  const items = await store.peekQueue(BATCH);
  if (!items.length) return out;                       // an empty queue touches nothing

  const user = await getUser().catch(() => null);
  if (!user || !user.email) {
    out.authRequired = true;
    out.remaining = await store.queueLength();
    return out;
  }
  const me = String(user.email).toLowerCase();
  const sheets = new Map();
  let keeps = 0;
  let hadFailure = false;

  for (const item of items) {
    // A submission stamped with another person's email must not go up under this login.
    if (typeof item.user_id === 'string' && item.user_id.includes('@') && item.user_id.toLowerCase() !== me) { out.skipped++; continue; }

    let media = [];
    try {
      const spec = await store.getForm(item.form_id, String(item.version));
      if (!spec || !spec._project || !spec._project.id) throw new Skip();   // cannot route it yet: keep it
      media = await store.getMedia(item.uuid);
      const verdict = await sendOne(item, spec, media, user, ctx, sheets);
      await store.dequeue(item.uuid);                  // only after the row is confirmed
      keeps = 0;
      if (verdict === 'created') out.uploaded++; else out.replayed++;
    } catch (e) {
      if (e instanceof Skip) { out.skipped++; continue; }
      if (isAuth(e)) { out.authRequired = true; break; }        // only a new sign-in helps; queue untouched
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
      if (e && e.exhausted) break;                     // Google is throttling or down: stop for now
      if (++keeps >= MAX_CONSECUTIVE_KEEPS) break;     // a local error or an odd one: keep, move on, cap
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
export function syncOnce(a, b) {
  if (state.running) return state.running;
  const p = run(config(normalise(a, b))).finally(() => { if (state.running === p) state.running = null; });
  state.running = p;
  return p;
}

// ---- bootstrap -------------------------------------------------------------------

// Reads every granted project's *.spec.json and stores each (form_id, version) it has not
// seen. A stored version is NEVER replaced: a draft in progress finishes on the version it
// started on, and a new version sits beside the old one. Each stored spec is tagged with
// `_project: {id, name}`, which is how a queued submission finds its spreadsheet.
// Returns { forms, datasets, config, errors } (datasets and config kept empty for callers
// that still read them). Throws only if the project list itself cannot be read.
export async function bootstrap(a, b) {
  const o = normalise(a, b);
  const { store, drive, retry } = config(o);
  const rootFolderId = o.rootFolderId || await defaultRootFolder();
  const out = { forms: [], datasets: [], config: {}, errors: [] };

  // Projects the person added through the folder chooser, plus (best effort) folders inside the
  // configured main folder, which under drive.file only lists what this app can see.
  const projects = await retry(() => drive.listProjects());
  if (!Array.isArray(projects)) throw new Error('Project list was not a list');
  if (rootFolderId && drive.listProjectsIn) {
    try {
      for (const p of await retry(() => drive.listProjectsIn(rootFolderId))) {
        if (!projects.some(x => x.id === p.id)) projects.push(p);
      }
    } catch (e) { if (isAuth(e)) throw e; /* the chosen projects still work */ }
  }

  for (const project of projects) {
    let files;
    try {
      files = await retry(() => drive.listForms(project.id));
    } catch (e) {
      out.errors.push({ project: project.name, error: String((e && e.message) || e) });
      continue;
    }
    for (const file of files) {
      if (!/\.spec\.json$/i.test(file.name || '')) continue;
      try {
        const spec = await retry(() => drive.readSpec(file.id));
        if (!spec || typeof spec.form_id !== 'string' || !spec.version || !Array.isArray(spec.nodes)) {
          throw new Error('not a form spec');
        }
        const version = String(spec.version);
        const have = await store.getForm(spec.form_id, version);
        if (!have) await store.putForm({ ...spec, version, _project: { id: project.id, name: project.name } });
        out.forms.push({ form_id: spec.form_id, version, project: project.name, downloaded: !have });
      } catch (e) {
        out.errors.push({ project: project.name, file: file.name, error: String((e && e.message) || e) });
      }
    }
  }
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
        if ((reconnected || !state.bootstrapped) && !r.authRequired) {
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
