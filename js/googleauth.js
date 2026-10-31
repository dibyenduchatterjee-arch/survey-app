// Google sign-in for the browser app: OAuth 2.0 authorization code flow with PKCE.
//
// Every person signs in as himself, so NO credential ships in the app. The OAuth client
// id (webapp/config.js) is configuration, not a secret. This file never handles a client
// secret, API key or embedded refresh token, and never uses the implicit flow.
//
// Scopes, and why they are this narrow:
//   drive.file     Access only to files this app creates, or that the user explicitly opens
//                  with it. Full `drive` would let a bug or a stolen token read the user's
//                  entire Drive; drive.file cannot. It also keeps the consent screen out of
//                  Google's "restricted scope" verification.
//   spreadsheets   Read and append rows in the data spreadsheet.
//   openid email profile   Needed only to learn who signed in (email, display name).
// KNOWN LIMIT: drive.file may not let the app list a folder that was merely shared WITH the
// user, because the app did not create it. See the task report; the scope is not widened here.
//
// Tokens are kept in IndexedDB (db.js session store, under the `google` key), never localStorage.

export const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
];

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const EXPIRY_MARGIN_MS = 60 * 1000;

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes = 32) {
  return b64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

// RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))).
export async function pkceChallenge(verifier) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

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

// Default interactive step: open Google's page in a popup and wait for it to come back to
// redirectUri (same origin as the app, so its location becomes readable). Injectable for tests.
function popupAuthorize(redirectUri) {
  return url => new Promise((resolve, reject) => {
    const w = window.open(url, 'evac-google-signin', 'width=500,height=650');
    if (!w) { reject(authError('popup_blocked', 'The sign-in window was blocked. Allow pop-ups and try again.')); return; }
    const timer = setInterval(() => {
      let href = '';
      try { href = w.location.href; } catch { return; } // still on accounts.google.com
      if (href.startsWith(redirectUri)) { clearInterval(timer); try { w.close(); } catch { /* ignore */ } resolve(href); }
      else if (w.closed) { clearInterval(timer); reject(authError('cancelled', 'Sign-in was cancelled.')); }
    }, 300);
  });
}

export function createGoogleAuth({ config, fetchImpl, store, authorize, now = () => Date.now() } = {}) {
  const f = (...a) => (fetchImpl || globalThis.fetch).apply(globalThis, a);
  const getConfig = async () => config || loadConfig();
  const getStore = async () => store || (await import('./db.js'));
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

  async function postToken(params) {
    const res = await f(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    let body = {};
    try { body = await res.json(); } catch { /* non-JSON error */ }
    return { ok: res.ok, status: res.status, body };
  }

  async function signIn() {
    const cfg = await getConfig();
    const verifier = randomString(48);          // 64 chars, stays in this closure only
    const state = randomString(16);
    const url = new URL(AUTH_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    }).toString();

    const back = await (authorize || popupAuthorize(cfg.redirectUri))(url.toString());
    const q = new URL(back).searchParams;
    if (q.get('error')) throw authError('denied', 'Google sign-in failed: ' + q.get('error'));
    if (q.get('state') !== state) throw authError('bad_state', 'Sign-in response had the wrong state; try again.');
    const code = q.get('code');
    if (!code) throw authError('no_code', 'Sign-in did not return a code.');

    const t = await postToken({
      grant_type: 'authorization_code',
      code,
      client_id: cfg.googleClientId,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
    });
    if (!t.ok) throw authError('token_failed', `Google refused the sign-in (${t.status} ${t.body.error || ''}).`);

    const info = await f(USERINFO_ENDPOINT, { headers: { Authorization: 'Bearer ' + t.body.access_token } });
    if (!info.ok) throw authError('userinfo_failed', 'Could not read the signed-in user.');
    const u = await info.json();
    const user = { email: u.email, name: u.name || u.email };
    await writeGoogle({
      access_token: t.body.access_token,
      refresh_token: t.body.refresh_token,
      expires_at: now() + (t.body.expires_in || 3600) * 1000,
      user,
    });
    return { email: user.email, name: user.name, accessToken: t.body.access_token };
  }

  async function refresh(g) {
    const cfg = await getConfig();
    const t = await postToken({ grant_type: 'refresh_token', refresh_token: g.refresh_token, client_id: cfg.googleClientId });
    if (!t.ok) {
      if (t.status === 400 || t.status === 401) {          // refresh token revoked or expired: permanent
        await writeGoogle(null);
        throw authError('needs_signin', 'Your Google sign-in has expired. Sign in again.');
      }
      throw authError('refresh_failed', `Could not refresh the Google sign-in (${t.status}). Try again.`);
    }
    const next = { ...g, access_token: t.body.access_token, expires_at: now() + (t.body.expires_in || 3600) * 1000 };
    if (t.body.refresh_token) next.refresh_token = t.body.refresh_token;
    await writeGoogle(next);
    return next.access_token;
  }

  async function getAccessToken() {
    const g = await readGoogle();
    if (!g) throw authError('needs_signin', 'Not signed in.');
    if (g.access_token && g.expires_at - EXPIRY_MARGIN_MS > now()) return g.access_token;
    if (!g.refresh_token) throw authError('needs_signin', 'Your Google sign-in has expired. Sign in again.');
    if (!refreshing) refreshing = refresh(g).finally(() => { refreshing = null; });
    return refreshing;
  }

  async function signOut() { await writeGoogle(null); }

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
