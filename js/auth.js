// Authentication for the enumerator app.
//
// Tokens live in IndexedDB (the `session` store, via db.js), never in localStorage.
//
// THE RULE THAT MATTERS MOST IN THIS FILE: refresh tokens rotate, and the server
// treats the reuse of a spent one as theft and revokes the user's whole chain.
// So the new refresh token is written to IndexedDB, and that write is awaited to
// its commit, BEFORE the old one is treated as spent and before any request is
// retried with the new access token. The old token is never deleted or
// overwritten until the replacement is safely on disk. See `renewAccess`.
//
// A second rule: nothing in this file ever touches the upload queue. Logging out
// or being forced to log in again must never cost an enumerator her unsent work.
//
// Every function takes `fetchImpl` and `store` as options so the logic can be
// tested in Node with a stub network and an in-memory store.

import * as defaultStore from './db.js';

const defaultFetch = () => globalThis.fetch.bind(globalThis);

// One refresh at a time per store. Concurrent 401s must share a single refresh:
// a second one would present the token the first has just spent.
const flights = new WeakMap();

function detailText(body, fallback) {
  const d = body && body.detail;
  if (typeof d === 'string') return d;
  if (d && typeof d.message === 'string') return d.message;
  return fallback;
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

export async function login(username, password, { fetchImpl = defaultFetch(), store = defaultStore } = {}) {
  const res = await fetchImpl('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await readJson(res);
  if (!res.ok) {
    const err = new Error(detailText(body, `Login failed (${res.status})`));
    err.status = res.status;
    throw err;
  }
  if (!body || !body.access_token || !body.refresh_token) throw new Error('Login reply was incomplete');
  // putSession replaces the whole record, which also clears any needs_login flag.
  await store.putSession({ access_token: body.access_token, refresh_token: body.refresh_token, user: body.user });
  return body.user;
}

// Signs out on this device. Best effort at the server (so the refresh token is
// revoked), certain locally. Deliberately does NOT touch the queue, the drafts
// or the downloaded forms: whatever is unsent stays unsent until it can go.
export async function logout({ fetchImpl = defaultFetch(), store = defaultStore } = {}) {
  let session;
  try { session = await store.getSession(); } catch { session = undefined; }
  if (session && session.refresh_token && !session.needs_login) {
    try {
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(5000);
      await fetchImpl('/api/auth/logout', init);
    } catch { /* offline: the token simply expires on its own */ }
  }
  await store.clearSession();
}

// Resolves to a usable access token, or null when none can be had (and the caller
// should hand back the original 401). Throws only if the new tokens could not be
// persisted: the caller must then stop, not carry on with tokens it cannot keep.
function renewAccess(fetchImpl, store, usedToken) {
  const running = flights.get(store);
  if (running) return running;
  const p = (async () => {
    const session = await store.getSession();
    if (!session || session.needs_login || !session.refresh_token) return null;
    // Another call refreshed while this request was in flight: just use that token.
    if (session.access_token !== usedToken) return session.access_token;

    let res;
    try {
      res = await fetchImpl('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
    } catch {
      return null; // offline: nothing was spent as far as we know; try again later
    }
    if (res.status === 401 || res.status === 403) {
      // The server says this refresh token is dead: only a fresh login helps.
      await store.putSession({ ...session, needs_login: true });
      return null;
    }
    if (!res.ok) return null; // 5xx, 429...: transient, session untouched

    const pair = await readJson(res);
    if (!pair || !pair.access_token || !pair.refresh_token) {
      // The server accepted and rotated, but we cannot read what it gave us. The old
      // token is now spent; replaying it would revoke the chain. Ask for a login.
      await store.putSession({ ...session, needs_login: true });
      return null;
    }

    // The user may have logged out while the request was in flight; do not resurrect them.
    const now = await store.getSession();
    if (!now || now.refresh_token !== session.refresh_token) return null;

    // PERSIST FIRST. Only when this write has committed is the old token treated as
    // spent, and only then is the new access token used. If it throws, the old
    // session is still exactly as it was and the error reaches the caller.
    await store.putSession({ ...session, access_token: pair.access_token, refresh_token: pair.refresh_token, needs_login: false });
    return pair.access_token;
  })().finally(() => { flights.delete(store); });
  flights.set(store, p);
  return p;
}

// Returns a fetch that adds the bearer token and, on a 401, refreshes ONCE and
// retries ONCE. A second 401 is returned to the caller as it is.
export function makeAuthFetch(fetchImpl, { store = defaultStore } = {}) {
  return async function authFetch(url, opts = {}) {
    const session = await store.getSession();
    if (!session || !session.access_token) return new Response(null, { status: 401 });
    const send = token => {
      const headers = new Headers(opts.headers || {});
      headers.set('Authorization', 'Bearer ' + token);
      return fetchImpl(url, { ...opts, headers });
    };
    const res = await send(session.access_token);
    if (res.status !== 401) return res;
    const token = await renewAccess(fetchImpl, store, session.access_token);
    if (!token) return res;
    return send(token);
  };
}

export function authFetch(url, opts) {
  return makeAuthFetch(defaultFetch())(url, opts);
}
