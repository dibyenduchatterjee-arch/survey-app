// Access to the Apps Script backend: project-code login, and the one call every other module
// uses to talk to it. This replaces Google sign-in on the phone (auth.js stays for the old
// server-version supervisor console only).
//
// The model: a worker types a project's access code. The backend answers with that project's
// name and a session token. Both are kept in IndexedDB (db.js), never localStorage. A device
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
  if (!isUsableUrl(url)) throw new ApiError('not_configured', 'The Apps Script URL is not set in config.js', { retry: false });
  return url;
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
const publicView = r => ({ key: r.key, name: r.name, person: r.person || '', revoked: !!r.revoked });

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
  const name = typeof reply.project === 'string' ? reply.project.trim() : '';
  if (!name || typeof reply.token !== 'string' || !reply.token) {
    throw new ApiError('bad_reply', 'The server did not answer properly', { retry: true });
  }
  const id = recordId(name);
  const prev = await store.getSessionRecord(id);
  await store.putSessionRecord({
    id, key: name, name, person: typeof reply.person === 'string' ? reply.person : '', code: typed, token: reply.token,
    expires_at: reply.expires_at || null, revoked: false,
    added_at: prev && prev.added_at ? prev.added_at : now(),
  });
  await store.putSessionRecord({ id: 'active', key: name });
  return { key: name, name, person: typeof reply.person === 'string' ? reply.person : '' };
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
    await store.putSessionRecord({ ...cur, person: typeof reply.person === 'string' ? reply.person : cur.person, token: reply.token, expires_at: reply.expires_at || null, revoked: false });
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
