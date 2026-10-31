// Access to the Apps Script backend: project-code login, and the one call every other module
// uses to talk to it. This replaces Google sign-in on the phone (auth.js stays for the old
// server-version supervisor console only).
//
// The model: a worker types a project's access code. The backend answers with that project's
// stable id, its name and a session token. All are kept in IndexedDB (db.js), never localStorage.
// A project is KEYED by the id the backend sends (`project_id`), never by its name: two projects
// can share a name, and then their forms and queued records would attach to each other. The name is
// only what is shown. A device
// can hold several projects at once; each is its own record and its own token, so entering a
// second code ADDS a project and never replaces the first.
//
// Rules in this file:
//   * A wrong code stores nothing.
//   * The code is kept (IndexedDB) because the token lapses after hours and the owner may
//     revoke: re-opening uses the stored code. If the backend then refuses it, the project is
//     marked `revoked`, its forms are hidden and its queue is NOT touched.
//   * Nothing here touches the queue, drafts, forms or rejected store.
//
// Wire format (see task-40-report): every call is a POST of a JSON string as text/plain, so
// it is a CORS "simple" request. The reply is JSON `{ok:true,...}` or `{ok:false,error,message,
// retry,retry_after_s}`; when Google itself fails the reply is an HTML page, which is treated
// exactly like `retry: true`.

import * as defaultStore from './db.js';

const PREFIX = 'project:';
const RENEW_MARGIN_MS = 60_000;   // renew a token that has less than a minute left

// An error from the backend or the network. `retry` says whether trying again can help.
export class ApiError extends Error {
  constructor(code, message, { retry = false, retryAfterMs = 0 } = {}) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.retry = retry;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function appsScriptUrl() {
  let url;
  try { url = (await import('../config.js')).config.appsScriptUrl; } catch { url = undefined; }
  if (!isUsableUrl(url)) throw new ApiError('not_configured', 'This app has not been set up yet: the web address of the survey server is still the placeholder in config.js.', { retry: false });
  return url;
}

// Has config.js been filled in? (Never throws.) The app asks this before anything else and says
// so in plain words when it has not, instead of letting a call fail with a network error.
export async function isConfigured() {
  try { await appsScriptUrl(); return true; } catch { return false; }
}

// True for a real https address, false for the placeholder in config.example.js or nothing at all.
export function isUsableUrl(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url) && !/PASTE/i.test(url);
}

// One POST. Always resolves to the parsed `{ok:true,...}` body or throws ApiError.
export async function callApi(body, { fetchImpl, url, timeoutMs = 60_000 } = {}) {
  const target = url || await appsScriptUrl();
  const send = fetchImpl || ((u, init) => globalThis.fetch(u, init));
  let text;
  try {
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // NOT application/json: no preflight
      body: JSON.stringify(body),
      redirect: 'follow',
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(timeoutMs);
    const res = await send(target, init);
    text = await res.text();
  } catch (e) {
    throw new ApiError('network', (e && e.message) || 'No connection', { retry: true });
  }
  let reply;
  try { reply = JSON.parse(text); } catch { reply = null; }
  if (!reply || typeof reply !== 'object') {
    // An HTML page: Google's own quota, outage or deployment error. Retry later.
    throw new ApiError('bad_reply', 'The server did not answer properly', { retry: true });
  }
  if (reply.ok !== true) {
    const retryAfterMs = Number.isFinite(reply.retry_after_s) ? reply.retry_after_s * 1000 : 0;
    throw new ApiError(String(reply.error || 'error'), reply.message || reply.error, { retry: reply.retry === true, retryAfterMs });
  }
  return reply;
}

// ---- projects held on this device -------------------------------------------------

const recordId = key => PREFIX + key;
// `legacy` appears only on a record from before ids existed (still keyed by name, not yet moved).
const publicView = r => ({ key: r.key, name: r.name, person: r.person || '', revoked: !!r.revoked, ...(r.by_id ? {} : { legacy: true }) });

// Every project this device holds, in the order they were added.
export async function listProjects({ store = defaultStore } = {}) {
  const all = await store.listProjectSessions();
  return all.sort((a, b) => (a.added_at || 0) - (b.added_at || 0)).map(publicView);
}

export async function currentProject({ store = defaultStore } = {}) {
  const held = await listProjects({ store });
  if (!held.length) return null;
  const active = await store.getSessionRecord('active');
  return held.find(p => active && p.key === active.key) || held[0];
}

export async function setActiveProject(key, { store = defaultStore } = {}) {
  await store.putSessionRecord({ id: 'active', key });
}

// Types a code and, if the backend accepts it, adds that project. Each code belongs to one
// person in one project; the backend names both and stamps every row with the person's name, so
// the phone never claims a name. Resolves to { key, name, person }. Throws ApiError: code 'refused' for a wrong, unknown or switched-off code
// (nothing stored), or a retryable one (network, busy, too_many_attempts) when it could not
// be asked. A second code for a different project adds it; a code for the same project again
// refreshes that project's code and token (one person per project per phone).
export async function openProject(code, { fetchImpl, store = defaultStore, url, now = Date.now } = {}) {
  const typed = String(code || '').trim();
  if (!typed) throw new ApiError('refused', 'Enter the project code', { retry: false });
  const reply = await callApi({ action: 'open', code: typed }, { fetchImpl, url });
  const { name, key } = identityOf(reply);
  if (typeof reply.token !== 'string' || !reply.token) {
    throw new ApiError('bad_reply', 'The server did not answer properly', { retry: true });
  }
  // Data stored by an older build under this project's NAME moves to its id first.
  const legacy = await store.getSessionRecord(recordId(name));
  const id = recordId(key);
  if (legacy && !legacy.by_id) await store.migrateProjectKey(name, key, name);
  const prev = (await store.getSessionRecord(id)) || legacy;
  const person = typeof reply.person === 'string' ? reply.person : '';
  await store.putSessionRecord({
    id, key, name, by_id: true, person, code: typed, token: reply.token,
    expires_at: reply.expires_at || null, revoked: false,
    added_at: prev && prev.added_at ? prev.added_at : now(),
  });
  await store.putSessionRecord({ id: 'active', key });
  return { key, name, person };
}

// { key, name } from an open reply. A reply with no project_id comes from a script deployed before
// ids existed: using the name instead would bring back the very collision ids prevent, so refuse
// plainly (not retryable: the owner must redeploy).
function identityOf(reply) {
  const name = typeof reply.project === 'string' ? reply.project.trim() : '';
  if (!name) throw new ApiError('bad_reply', 'The server did not answer properly', { retry: true });
  const key = typeof reply.project_id === 'string' ? reply.project_id.trim() : '';
  if (!key) throw new ApiError('server_outdated', 'The survey server is an old version. Ask the person who runs it to deploy the new version.', { retry: false });
  return { name, key };
}

// Phones that logged in before ids existed hold `project:<name>` records. Re-open each with its
// stored code to learn its id, then move everything stored under the name (see db.js
// migrateProjectKey). A project that cannot be asked right now (offline, refused) is left exactly
// as it is and tried again on the next call; its queue is never touched. Returns the names left.
export async function upgradeLegacyProjects({ fetchImpl, store = defaultStore, url } = {}) {
  const left = [];
  for (const rec of await store.listProjectSessions()) {
    if (rec.by_id) continue;
    try {
      if (!rec.code) throw new ApiError('refused', '', { retry: false });
      const reply = await callApi({ action: 'open', code: rec.code }, { fetchImpl, url });
      const { name, key } = identityOf(reply);
      await store.migrateProjectKey(rec.key, key, name);
      const cur = await store.getSessionRecord(recordId(key));
      if (cur && typeof reply.token === 'string' && reply.token) {
        await store.putSessionRecord({ ...cur, token: reply.token, expires_at: reply.expires_at || null, revoked: false, person: typeof reply.person === 'string' ? reply.person : cur.person });
      }
    } catch { left.push(rec.name || rec.key); }
  }
  return left;
}

// Forget ONE project on this device (or all of them with no key). The queue, drafts, forms
// and rejected store are left exactly as they are: unsent work stays unsent until the code is
// entered again.
export async function signOut(key, { store = defaultStore } = {}) {
  if (key === undefined || key === null) {
    for (const r of await store.listProjectSessions()) await store.deleteSessionRecord(r.id);
    await store.deleteSessionRecord('active');
    return;
  }
  await store.deleteSessionRecord(recordId(key));
  const active = await store.getSessionRecord('active');
  if (active && active.key === key) await store.deleteSessionRecord('active');
}

// A usable token for a held project. Re-opens with the stored code when the token is near its
// end, or when `force` says the backend just refused it. Throws ApiError('revoked') when the
// backend no longer accepts the code (the record is marked, nothing else changes), or the
// transient error if it could not be asked.
export async function tokenFor(key, { fetchImpl, store = defaultStore, url, force = false, now = Date.now } = {}) {
  const id = recordId(key);
  const rec = await store.getSessionRecord(id);
  if (!rec) throw new ApiError('no_project', 'This project is not open on this phone', { retry: false });
  if (rec.revoked && !force) throw new ApiError('revoked', 'Access to this project has been withdrawn', { retry: false });
  const left = rec.expires_at ? Date.parse(rec.expires_at) - now() : Infinity;
  if (!force && rec.token && !(left < RENEW_MARGIN_MS)) return rec.token;
  try {
    const reply = await callApi({ action: 'open', code: rec.code }, { fetchImpl, url });
    if (typeof reply.token !== 'string' || !reply.token) throw new ApiError('bad_reply', 'The server did not answer properly', { retry: true });
    // Re-read: the person may have signed out while we were waiting.
    const cur = await store.getSessionRecord(id);
    if (!cur) throw new ApiError('no_project', 'This project is not open on this phone', { retry: false });
    await store.putSessionRecord({ ...cur, name: typeof reply.project === 'string' && reply.project.trim() ? reply.project.trim() : cur.name, person: typeof reply.person === 'string' ? reply.person : cur.person, token: reply.token, expires_at: reply.expires_at || null, revoked: false });
    return reply.token;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'refused') {
      const cur = await store.getSessionRecord(id);
      if (cur) await store.putSessionRecord({ ...cur, revoked: true, token: null });
      throw new ApiError('revoked', 'Access to this project has been withdrawn', { retry: false });
    }
    throw e;
  }
}
