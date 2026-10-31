// Google sign-in (Identity Services token model): token reuse, single silent renewal,
// no secret, no localStorage. No network, no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createGoogleAuth, SCOPES } from "../js/googleauth.js";

const CFG = { googleClientId: "cid.apps.googleusercontent.com" };

function memStore() {
  let s;
  return {
    async getSession() { return s && structuredClone(s); },
    async putSession(v) { s = structuredClone({ ...v, id: "current" }); },
    async clearSession() { s = undefined; },
    peek: () => s,
  };
}

function harness({ now = () => 1_000_000, store = memStore(), failSilent = false } = {}) {
  const prompts = [];
  let n = 0;
  const requestToken = async ({ prompt }) => {
    prompts.push(prompt);
    if (prompt === "") {
      if (failSilent) { const e = new Error("popup"); e.code = "needs_signin"; throw e; }
      n += 1;
      return { access_token: "AT-r" + n, expires_in: 3600 };
    }
    return { access_token: "AT1", expires_in: 3600 };
  };
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ email: "a@gmail.com", name: "A Person" }) };
  };
  return { auth: createGoogleAuth({ config: CFG, fetchImpl, store, requestToken, now }), prompts, calls, store };
}

test("scopes: drive.file + spreadsheets (+ identity), never full drive or readonly", () => {
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/drive.file"));
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/spreadsheets"));
  assert.ok(!SCOPES.includes("https://www.googleapis.com/auth/drive"));
  assert.ok(!SCOPES.includes("https://www.googleapis.com/auth/drive.readonly"));
});

test("signIn asks for consent and returns email and token", async () => {
  const { auth, prompts } = harness();
  const u = await auth.signIn();
  assert.deepEqual(prompts, ["consent"]);
  assert.equal(u.email, "a@gmail.com");
  assert.equal(u.accessToken, "AT1");
});

test("a valid token is reused with no request at all", async () => {
  const { auth, prompts } = harness();
  await auth.signIn();
  assert.equal(await auth.getAccessToken(), "AT1");
  assert.equal(await auth.getAccessToken(), "AT1");
  assert.equal(prompts.length, 1);
});

test("an expired token is renewed silently once and reused, even for concurrent callers", async () => {
  let t = 1_000_000;
  const { auth, prompts } = harness({ now: () => t });
  await auth.signIn();
  t += 3600 * 1000;
  const r = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.deepEqual(r, ["AT-r1", "AT-r1", "AT-r1"]);
  assert.equal(await auth.getAccessToken(), "AT-r1");
  assert.deepEqual(prompts, ["consent", ""]);
});

test("when silent renewal is impossible, the caller gets needs_signin and the session record survives", async () => {
  let t = 1_000_000;
  const store = memStore();
  const ok = harness({ now: () => t, store });
  await ok.auth.signIn();
  await store.putSession({ ...store.peek(), keep: "queue-marker" });
  t += 3600 * 1000;
  const h = harness({ now: () => t, store, failSilent: true });
  await assert.rejects(() => h.auth.getAccessToken(), e => e.code === "needs_signin");
  assert.equal(store.peek().keep, "queue-marker");
});

test("not signed in is needs_signin", async () => {
  const { auth } = harness();
  await assert.rejects(() => auth.getAccessToken(), e => e.code === "needs_signin");
});

test("tokens live in the session store, signOut clears them, other session data survives", async () => {
  const { auth, store } = harness();
  await store.putSession({ access_token: "legacy" });
  await auth.signIn();
  assert.equal(store.peek().google.access_token, "AT1");
  assert.equal(store.peek().google.refresh_token, undefined);
  assert.equal(store.peek().access_token, "legacy");
  assert.deepEqual(await auth.currentUser(), { email: "a@gmail.com", name: "A Person" });
  await auth.signOut();
  assert.equal(await auth.currentUser(), null);
  assert.equal(store.peek().google, undefined);
  assert.equal(store.peek().access_token, "legacy");
});

test("googleauth.js never uses localStorage and never handles a client secret", () => {
  const src = readFileSync(new URL("../js/googleauth.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/localStorage/.test(src));
  assert.ok(!/client_secret/.test(src));
});
