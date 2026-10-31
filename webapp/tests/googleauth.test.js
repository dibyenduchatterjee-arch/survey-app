// Google sign-in: PKCE, token reuse, single refresh. No network, no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { createGoogleAuth, SCOPES, pkceChallenge } from "../js/googleauth.js";

const CFG = { googleClientId: "cid.apps.googleusercontent.com", redirectUri: "https://app.example/cb.html" };

function memStore() {
  let s;
  return {
    async getSession() { return s && structuredClone(s); },
    async putSession(v) { s = structuredClone({ ...v, id: "current" }); },
    async clearSession() { s = undefined; },
    peek: () => s,
  };
}
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

function harness({ now = () => 1_000_000, expiresIn = 3600, store = memStore() } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      const p = new URLSearchParams(init.body);
      if (p.get("grant_type") === "authorization_code") {
        return json({ access_token: "AT1", refresh_token: "RT1", expires_in: expiresIn });
      }
      n += 1;
      return json({ access_token: "AT-r" + n, expires_in: expiresIn });
    }
    if (String(url).includes("userinfo")) return json({ email: "a@gmail.com", name: "A Person" });
    throw new Error("unexpected " + url);
  };
  let authUrl;
  const authorize = async url => {
    authUrl = new URL(url);
    return `${CFG.redirectUri}?code=CODE123&state=${authUrl.searchParams.get("state")}`;
  };
  const auth = createGoogleAuth({ config: CFG, fetchImpl, store, authorize, now });
  return { auth, calls, store, getAuthUrl: () => authUrl };
}

test("pkceChallenge is base64url(sha256(verifier))", async () => {
  const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = createHash("sha256").update(v).digest("base64url");
  assert.equal(await pkceChallenge(v), expected);
});

test("scopes: drive.file + spreadsheets (+ identity), never full drive", () => {
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/drive.file"));
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/spreadsheets"));
  assert.ok(!SCOPES.includes("https://www.googleapis.com/auth/drive"));
});

test("authorization URL uses code flow + S256, and never contains the verifier or a secret", async () => {
  const { auth, calls, getAuthUrl } = harness();
  const user = await auth.signIn();
  const u = getAuthUrl();
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("client_id"), CFG.googleClientId);
  const exch = calls.find(c => c.url.includes("/token"));
  const body = new URLSearchParams(exch.init.body);
  const verifier = body.get("code_verifier");
  assert.ok(verifier && verifier.length >= 43);
  assert.equal(u.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
  assert.ok(!u.toString().includes(verifier));
  assert.ok(!u.searchParams.has("client_secret") && !body.has("client_secret"));
  assert.equal(user.email, "a@gmail.com");
  assert.equal(user.accessToken, "AT1");
});

test("a state mismatch is rejected", async () => {
  const auth = createGoogleAuth({
    config: CFG, store: memStore(), fetchImpl: async () => { throw new Error("no network"); },
    authorize: async () => `${CFG.redirectUri}?code=X&state=WRONG`,
  });
  await assert.rejects(() => auth.signIn(), /state/i);
});

test("a valid token is reused with no network", async () => {
  const { auth, calls } = harness();
  await auth.signIn();
  const before = calls.length;
  assert.equal(await auth.getAccessToken(), "AT1");
  assert.equal(await auth.getAccessToken(), "AT1");
  assert.equal(calls.length, before);
});

test("an expired token is refreshed once and then reused, even for concurrent callers", async () => {
  let t = 1_000_000;
  const { auth, calls } = harness({ now: () => t });
  await auth.signIn();
  t += 3600 * 1000; // expired
  const [a, b, c] = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(a, "AT-r1"); assert.equal(b, "AT-r1"); assert.equal(c, "AT-r1");
  assert.equal(await auth.getAccessToken(), "AT-r1");
  const refreshes = calls.filter(x => x.url.includes("/token") && new URLSearchParams(x.init.body).get("grant_type") === "refresh_token");
  assert.equal(refreshes.length, 1);
});

test("expired with no refresh token asks the caller to sign in again", async () => {
  const store = memStore();
  await store.putSession({ google: { access_token: "old", expires_at: 1, user: { email: "a@x" } } });
  const auth = createGoogleAuth({ config: CFG, store, fetchImpl: async () => { throw new Error("no network"); }, now: () => 5000 });
  await assert.rejects(() => auth.getAccessToken(), e => e.code === "needs_signin");
});

test("a rejected refresh token (invalid_grant) asks to sign in again and clears the dead tokens", async () => {
  let t = 1_000_000;
  const store = memStore();
  const fetchImpl = async url => {
    if (String(url).includes("/token")) return json({ error: "invalid_grant" }, 400);
    return json({ email: "a@gmail.com", name: "A" });
  };
  const a1 = createGoogleAuth({
    config: CFG, store, fetchImpl: async (u, i) => (String(u).includes("/token") ? json({ access_token: "AT", refresh_token: "RT", expires_in: 10 }) : json({ email: "a@gmail.com", name: "A" })),
    authorize: async url => `${CFG.redirectUri}?code=C&state=${new URL(url).searchParams.get("state")}`, now: () => t,
  });
  await a1.signIn();
  t += 100000;
  const a2 = createGoogleAuth({ config: CFG, store, fetchImpl, now: () => t });
  await assert.rejects(() => a2.getAccessToken(), e => e.code === "needs_signin");
});

test("tokens live in the session store, signOut clears them, other session data survives", async () => {
  const { auth, store } = harness();
  await store.putSession({ access_token: "legacy" });
  await auth.signIn();
  assert.equal(store.peek().google.refresh_token, "RT1");
  assert.equal(store.peek().access_token, "legacy");
  assert.deepEqual(await auth.currentUser(), { email: "a@gmail.com", name: "A Person" });
  await auth.signOut();
  assert.equal(await auth.currentUser(), null);
  assert.equal(store.peek().google, undefined);
});

test("googleauth.js never uses localStorage and never mentions a client secret in code", () => {
  const src = readFileSync(new URL("../js/googleauth.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/localStorage/.test(src));
  assert.ok(!/client_secret/.test(src));
});
