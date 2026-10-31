// Google sign-in for the browser app, using Google Identity Services (GIS), token model.
//
// Why GIS and not an authorization-code exchange: Google's token endpoint demands a client
// secret from "Web application" clients, and a secret cannot ship in a browser app. The GIS
// token model hands a browser client an access token with no secret at all. Every person
// signs in as himself; the OAuth client id (webapp/config.js) is configuration, not a secret.
//
// CONSEQUENCE: there is NO refresh token. An access token lasts about an hour. When it has
// expired, getAccessToken() asks GIS for a new one silently (works while the Google session
// and prior consent still exist); if that is not possible, e.g. after a long offline stretch,
// it throws an Error with code 'needs_signin' and the app asks the person to sign in again.
// Nothing queued is touched by this: callers must keep submissions until a send succeeds.
//
// Scopes, and why they are this narrow:
//   drive.file     Only files the app creates, or folders/files the user explicitly picks
//                  with the Google Picker. Full `drive` or `drive.readonly` would expose a
//                  person's whole personal Drive; drive.file cannot.
//   spreadsheets   Read and append rows in the data spreadsheet.
//   openid email profile   Only to learn who signed in.
//
// Tokens are kept in IndexedDB (db.js session store, under the `google` key), never localStorage.

export const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
];

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const EXPIRY_MARGIN_MS = 60 * 1000;

function authError(code, message, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

async function loadConfig() {
  try {
    return (await import('../config.js')).config;
  } catch (e) {
    throw authError('no_config', 'webapp/config.js is missing. Copy config.example.js to config.js and fill it in.', e);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(authError('no_browser', 'Google sign-in needs a browser.')); return; }
    if (document.querySelector(`script[src="${src}"]`) && globalThis.google && globalThis.google.accounts) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(authError('offline', 'Could not reach Google. Check the connection and try again.'));
    document.head.appendChild(s);
  });
}

// Default token request: GIS popup. prompt '' = silent when consent already exists, 'consent' = ask.
// Resolves {access_token, expires_in}. Injectable for tests.
function gisRequestToken(cfg) {
  return async ({ prompt }) => {
    await loadScript(GIS_SRC);
    return new Promise((resolve, reject) => {
      const client = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: cfg.googleClientId,
        scope: SCOPES.join(' '),
        callback: r => (r.error ? reject(authError(r.error === 'access_denied' ? 'denied' : 'needs_signin', 'Google sign-in failed: ' + r.error)) : resolve(r)),
        error_callback: e => reject(authError('needs_signin', 'Google sign-in needs you: ' + (e && e.type || 'popup closed'))),
      });
      client.requestAccessToken({ prompt });
    });
  };
}

export function createGoogleAuth({ config, fetchImpl, store, requestToken, now = () => Date.now() } = {}) {
  const f = (...a) => (fetchImpl || globalThis.fetch).apply(globalThis, a);
  const getConfig = async () => config || loadConfig();
  const getStore = async () => store || (await import('./db.js'));
  const request = async opts => (requestToken || gisRequestToken(await getConfig()))(opts);
  let refreshing = null;

  async function readGoogle() {
    const s = await getStore();
    let rec; try { rec = await s.getSession(); } catch { rec = undefined; }
    return rec && rec.google ? rec.google : null;
  }
  async function writeGoogle(google) {
    const s = await getStore();
    let rec; try { rec = (await s.getSession()) || {}; } catch { rec = {}; }
    const next = { ...rec };
    if (google) next.google = google; else delete next.google;
    await s.putSession(next);
  }

  async function signIn() {
    const t = await request({ prompt: 'consent' });
    if (!t || !t.access_token) throw authError('token_failed', 'Google did not return a token.');
    const info = await f(USERINFO_ENDPOINT, { headers: { Authorization: 'Bearer ' + t.access_token } });
    if (!info.ok) throw authError('userinfo_failed', 'Could not read the signed-in user.');
    const u = await info.json();
    const user = { email: u.email, name: u.name || u.email };
    await writeGoogle({ access_token: t.access_token, expires_at: now() + Number(t.expires_in || 3600) * 1000, user });
    return { email: user.email, name: user.name, accessToken: t.access_token };
  }

  async function renew(g) {
    let t;
    try { t = await request({ prompt: '' }); }
    catch (e) {
      if (e && e.code) throw e;
      throw authError('needs_signin', 'Your Google sign-in has expired. Sign in again.', e);
    }
    if (!t || !t.access_token) throw authError('needs_signin', 'Your Google sign-in has expired. Sign in again.');
    await writeGoogle({ ...g, access_token: t.access_token, expires_at: now() + Number(t.expires_in || 3600) * 1000 });
    return t.access_token;
  }

  async function getAccessToken() {
    const g = await readGoogle();
    if (!g) throw authError('needs_signin', 'Not signed in.');
    if (g.access_token && g.expires_at - EXPIRY_MARGIN_MS > now()) return g.access_token;
    if (!refreshing) refreshing = renew(g).finally(() => { refreshing = null; });
    return refreshing;
  }

  // Forgets the token and user but keeps everything else in the session record.
  async function signOut() {
    const g = await readGoogle();
    if (g && g.access_token) {
      try { globalThis.google && globalThis.google.accounts.oauth2.revoke(g.access_token, () => {}); } catch { /* best effort */ }
    }
    await writeGoogle(null);
  }

  async function currentUser() {
    const g = await readGoogle();
    return g && g.user ? { email: g.user.email, name: g.user.name } : null;
  }

  return { signIn, getAccessToken, signOut, currentUser };
}

// Default instance wired to config.js, the global fetch and db.js. Built lazily so importing
// this module never needs a browser or config.js.
let shared;
const inst = () => (shared ||= createGoogleAuth());
export const signIn = () => inst().signIn();
export const getAccessToken = () => inst().getAccessToken();
export const signOut = () => inst().signOut();
export const currentUser = () => inst().currentUser();
