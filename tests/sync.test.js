// Queue logic, retry, backoff, de-duplication and the 401-refresh-once path.
//
// Runs under `node --test webapp/tests/` with no browser: sync.js and auth.js take
// their storage (`store`) and network (`fetchImpl`) as parameters, so the tests
// pass an in-memory store with db.js's exact interface and a scripted fetch.

import test from "node:test";
import assert from "node:assert/strict";

import * as auth from "../js/auth.js";
import * as sync from "../js/sync.js";

// ---- fakes -----------------------------------------------------------------------

function memStore(opts = {}) {
  const forms = new Map();
  const datasets = new Map();
  const rejected = new Map();
  const drafts = new Map();
  const media = new Map();
  let queue = [];
  let session;
  let seq = 0;
  const log = [];
  return {
    log,
    opts,
    async putForm(spec) { forms.set(`${spec.form_id}|${spec.version}`, structuredClone(spec)); },
    async getForm(id, v) { return forms.get(`${id}|${v}`); },
    async listForms() { return [...forms.values()]; },
    async putDataset(name, rows) { datasets.set(name, rows); },
    async putRejected(rec) {
      if (opts.failRejectedPut) throw new Error('disk full');
      rejected.set(rec.uuid, rec);
    },
    async listRejected() { return [...rejected.values()]; },
    async getRejected(uuid) { return rejected.get(uuid); },
    async deleteRejected(uuid) { rejected.delete(uuid); },
    async getDataset(name) { return datasets.get(name); },
    async saveDraft(d) { drafts.set(d.id, { ...d }); },
    async getDraft(id) { return drafts.get(id); },
    async listDrafts() { return [...drafts.values()]; },
    async deleteDraft(id) { drafts.delete(id); },
    async enqueue(sub, blobs) {
      queue = queue.filter(q => q.uuid !== sub.uuid);
      queue.push({ ...sub, queued_at: ++seq });
      media.set(sub.uuid, Object.entries(blobs || {}).map(([question, blob]) => ({ uuid: sub.uuid, question, blob })));
    },
    async peekQueue(n = 1) { return queue.slice(0, n); },
    async dequeue(uuid) {
      log.push(['dequeue', uuid]);
      queue = queue.filter(q => q.uuid !== uuid);
      media.delete(uuid);
    },
    async queueLength() { return queue.length; },
    async getMedia(uuid) { return media.get(uuid) || []; },
    async putSession(s) {
      log.push(['putSession', s.refresh_token]);
      if (opts.failPutSession) throw new Error('storage write failed');
      session = { ...s, id: 'current' };
    },
    async getSession() { return session; },
    async clearSession() { session = undefined; },
  };
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// routes: { 'POST /api/submissions': Response | fn(req) | [Response|fn, ...] (a sequence; the last repeats) }
function scriptedFetch(routes) {
  const calls = [];
  const counters = {};
  const fn = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const key = `${method} ${path}`;
    const headers = new Headers(init.headers || {});
    calls.push({ method, path, key, auth: headers.get('authorization'), body: init.body });
    let h = routes[key];
    if (h === undefined) return json(404, { detail: 'no route in test: ' + key });
    if (Array.isArray(h)) {
      const i = Math.min(counters[key] || 0, h.length - 1);
      counters[key] = (counters[key] || 0) + 1;
      h = h[i];
    }
    if (typeof h === 'function') h = await h({ url, init, headers, calls });
    if (h instanceof Error) throw h;
    return h.clone();
  };
  fn.calls = calls;
  fn.count = key => calls.filter(c => c.key === key).length;
  return fn;
}

const netError = () => new TypeError('Failed to fetch');
const receipt = uuid => ({ uuid, status: 'received', received_at: '2026-10-31T10:00:00Z', failures: [] });
const refusal = (status, code) => json(status, { detail: { code, message: code, retain_on_device: true } });
const wireUuid = init => JSON.parse(init.body.get('submission')).uuid;
const accept = ({ init }) => json(201, receipt(wireUuid(init)));

const sub = (uuid, extra = {}) => ({
  uuid, form_id: 'amb_asha_visit', version: '2026103101', data: { asha_name: 'सीता' }, repeats: {}, ...extra,
});
const photo = (text = 'JPEG') => new Blob([text], { type: 'image/jpeg' });

async function loggedIn(store, { access = 'A1', refresh = 'R1', user = { id: 7, role: 'enumerator' } } = {}) {
  await store.putSession({ access_token: access, refresh_token: refresh, user });
  store.log.length = 0;
}

const uploadedUuids = f => f.calls.filter(c => c.key === 'POST /api/submissions').map(c => wireUuid({ body: c.body }));

test.beforeEach(() => { sync._resetSyncState(); });

// ---- syncOnce --------------------------------------------------------------------

test("syncOnce uploads queued submissions oldest first", async () => {
  const store = memStore();
  await loggedIn(store);
  for (const u of ['u1', 'u2', 'u3']) await store.enqueue(sub(u), {});
  const f = scriptedFetch({ 'POST /api/submissions': accept });
  const r = await sync.syncOnce(f, { store });
  assert.deepEqual(uploadedUuids(f), ['u1', 'u2', 'u3']);
  assert.equal(r.uploaded, 3);
  assert.equal(r.failed, 0);
  assert.equal(r.remaining, 0);
  assert.equal(f.calls[0].auth, 'Bearer A1');
});

test("uploads are strictly one at a time", async () => {
  const store = memStore();
  await loggedIn(store);
  for (const u of ['u1', 'u2', 'u3']) await store.enqueue(sub(u), {});
  let inFlight = 0, peak = 0;
  const f = scriptedFetch({
    'POST /api/submissions': async ({ init }) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return json(201, receipt(wireUuid(init)));
    },
  });
  await sync.syncOnce(f, { store });
  assert.equal(peak, 1);
});

test("the request carries the media under the question name and no local-only fields", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), { household_photo: photo('PIXELS') });
  const f = scriptedFetch({ 'POST /api/submissions': json(201, receipt('u1')) });
  await sync.syncOnce(f, { store });
  const body = f.calls[0].body;
  assert.ok(body instanceof FormData);
  const wire = JSON.parse(body.get('submission'));
  assert.equal(wire.queued_at, undefined);
  assert.equal(wire.data.asha_name, 'सीता');
  const file = body.get('household_photo');
  assert.equal(await file.text(), 'PIXELS');
  assert.equal(file.type, 'image/jpeg');
});

test("a 200 replay response dequeues without counting a new upload", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const f = scriptedFetch({ 'POST /api/submissions': json(200, receipt('u1')) });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.uploaded, 0);
  assert.equal(r.replayed, 1);
  assert.equal(r.remaining, 0);
  assert.equal(await store.queueLength(), 0);
});

test("a response lost in transit is retried and arrives exactly once", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), { p: photo() });
  let stored = 0;
  const f = scriptedFetch({
    'POST /api/submissions': [
      () => { stored++; return netError(); },   // the server got it, the client never heard
      () => json(200, receipt('u1')),            // the replay
    ],
  });
  const first = await sync.syncOnce(f, { store });
  assert.equal(first.remaining, 1);
  assert.equal(first.failed, 1);
  assert.equal((await store.getMedia('u1')).length, 1, 'media must survive a failed attempt');
  const second = await sync.syncOnce(f, { store });
  assert.equal(second.remaining, 0);
  assert.equal(second.uploaded, 0);
  assert.equal(second.replayed, 1);
  assert.equal(stored, 1);
});

test("a 5xx leaves the submission queued for the next run", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), { p: photo() });
  const f = scriptedFetch({ 'POST /api/submissions': json(503, { detail: 'down' }) });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.failed, 1);
  assert.equal(r.remaining, 1);
  assert.deepEqual(store.log.filter(l => l[0] === 'dequeue'), []);
  assert.equal((await store.getMedia('u1')).length, 1);
});

test("a network error leaves the queue intact and stops the run", async () => {
  const store = memStore();
  await loggedIn(store);
  for (const u of ['u1', 'u2', 'u3']) await store.enqueue(sub(u), {});
  const f = scriptedFetch({ 'POST /api/submissions': () => netError() });
  const r = await sync.syncOnce(f, { store });
  assert.equal(f.count('POST /api/submissions'), 1, 'no point hammering a dead network');
  assert.equal(r.remaining, 3);
});

test("a 202 (attachments outstanding) stays queued", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), { p: photo() });
  const f = scriptedFetch({ 'POST /api/submissions': json(202, receipt('u1')) });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.remaining, 1);
  assert.equal(r.uploaded, 0);
});

test("a success-looking response that is not our receipt never dequeues (captive portal)", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const html = new Response('<html>Please sign in to the wifi</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const r = await sync.syncOnce(scriptedFetch({ 'POST /api/submissions': html }), { store });
  assert.equal(r.remaining, 1);
  const wrong = scriptedFetch({ 'POST /api/submissions': json(201, receipt('someone-else')) });
  const r2 = await sync.syncOnce(wrong, { store });
  assert.equal(r2.remaining, 1);
});

test("a 413 removes the submission from the queue and records it as rejected", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('big'), { household_photo: photo('HUGE') });
  const f = scriptedFetch({ 'POST /api/submissions': refusal(413, 'file_too_large') });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.rejected, 1);
  assert.equal(r.remaining, 0);
  const rejected = await sync.listRejected({ store });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].uuid, 'big');
  assert.equal(rejected[0].status, 413);
  assert.equal(rejected[0].code, 'file_too_large');
  assert.ok(rejected[0].message);
  // The work itself must still be recoverable, answers and photo both.
  assert.equal(rejected[0].submission.data.asha_name, 'सीता');
  assert.equal(await rejected[0].media[0].blob.text(), 'HUGE');
});

test("a refusal with a plain-string detail is also recorded, with the text as its message", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const f = scriptedFetch({ 'POST /api/submissions': json(422, { detail: 'The submission part is missing' }) });
  await sync.syncOnce(f, { store });
  const [rec] = await sync.listRejected({ store });
  assert.equal(rec.code, null);
  assert.equal(rec.message, 'The submission part is missing');
});

test("the rejection is written before the submission leaves the queue", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const order = [];
  const origPut = store.putRejected.bind(store);
  const origDeq = store.dequeue.bind(store);
  store.putRejected = async r => { order.push('record'); return origPut(r); };
  store.dequeue = async u => { order.push('dequeue'); return origDeq(u); };
  await sync.syncOnce(scriptedFetch({ 'POST /api/submissions': refusal(403, 'not_assigned') }), { store });
  assert.deepEqual(order, ['record', 'dequeue']);
});

test("if the rejection cannot be recorded the submission stays queued", async () => {
  const store = memStore({ failRejectedPut: true });
  await loggedIn(store);
  await store.enqueue(sub('u1'), { p: photo() });
  const f = scriptedFetch({ 'POST /api/submissions': refusal(404, 'form_version_unknown') });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.remaining, 1);
  assert.equal(r.failed, 1);
  assert.equal((await store.getMedia('u1')).length, 1);
});

test("a 4xx with no server-shaped body (proxy, captive portal) is kept, not rejected", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const f = scriptedFetch({ 'POST /api/submissions': new Response('<h1>Forbidden</h1>', { status: 403 }) });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.remaining, 1);
  assert.equal(r.rejected, 0);
  assert.deepEqual(await sync.listRejected({ store }), []);
});

test("a 429 is retried later, not rejected", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const f = scriptedFetch({ 'POST /api/submissions': json(429, { detail: 'slow down' }) });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.remaining, 1);
  assert.equal(r.rejected, 0);
});

test("a rejected submission can be put back on the queue with its photos", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), { p: photo('PX') });
  await sync.syncOnce(scriptedFetch({ 'POST /api/submissions': refusal(403, 'not_assigned') }), { store });
  assert.equal(await store.queueLength(), 0);
  await sync.retryRejected('u1', { store });
  assert.equal(await store.queueLength(), 1);
  assert.equal(await (await store.getMedia('u1'))[0].blob.text(), 'PX');
  assert.deepEqual(await sync.listRejected({ store }), []);
});

test("one rejected submission does not block the rest of the queue", async () => {
  const store = memStore();
  await loggedIn(store);
  for (const u of ['u1', 'u2', 'u3']) await store.enqueue(sub(u), {});
  const f = scriptedFetch({
    'POST /api/submissions': ({ init }) => (wireUuid(init) === 'u1' ? refusal(422, 'bad_uuid') : json(201, receipt(wireUuid(init)))),
  });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.rejected, 1);
  assert.equal(r.uploaded, 2);
  assert.equal(r.remaining, 0);
});

test("one failing submission (5xx) does not starve the ones behind it", async () => {
  const store = memStore();
  await loggedIn(store);
  for (const u of ['poison', 'u2', 'u3']) await store.enqueue(sub(u), {});
  const f = scriptedFetch({
    'POST /api/submissions': ({ init }) => (wireUuid(init) === 'poison' ? json(500, { detail: 'boom' }) : json(201, receipt(wireUuid(init)))),
  });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.uploaded, 2);
  assert.equal(r.remaining, 1);
  assert.equal((await store.peekQueue(5))[0].uuid, 'poison');
});

test("concurrent syncOnce calls share one run, so nothing is sent twice", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const f = scriptedFetch({ 'POST /api/submissions': async () => { await new Promise(r => setTimeout(r, 10)); return json(201, receipt('u1')); } });
  await Promise.all([sync.syncOnce(f, { store }), sync.syncOnce(f, { store })]);
  assert.equal(f.count('POST /api/submissions'), 1);
});

test("a submission stamped for another user is left alone", async () => {
  const store = memStore();
  await loggedIn(store, { user: { id: 7 } });
  await store.enqueue(sub('theirs', { user_id: 99 }), {});
  await store.enqueue(sub('mine', { user_id: 7 }), {});
  const f = scriptedFetch({ 'POST /api/submissions': accept });
  const r = await sync.syncOnce(f, { store });
  assert.deepEqual(uploadedUuids(f), ['mine']);
  assert.equal(r.remaining, 1);
});

test("with no session nothing is sent and nothing is lost", async () => {
  const store = memStore();
  await store.enqueue(sub('u1'), {});
  const f = scriptedFetch({ 'POST /api/submissions': accept });
  const r = await sync.syncOnce(f, { store });
  assert.equal(f.calls.length, 0);
  assert.equal(r.authRequired, true);
  assert.equal(r.remaining, 1);
});

// ---- 401 and refresh -------------------------------------------------------------

test("a 401 triggers exactly one refresh then one retry", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const f = scriptedFetch({
    'POST /api/submissions': [json(401, { detail: 'expired' }), json(201, receipt('u1'))],
    'POST /api/auth/refresh': json(200, { access_token: 'A2', refresh_token: 'R2' }),
  });
  const r = await sync.syncOnce(f, { store });
  assert.equal(f.count('POST /api/auth/refresh'), 1);
  assert.equal(f.count('POST /api/submissions'), 2);
  assert.equal(f.calls.at(-1).auth, 'Bearer A2');
  assert.equal(r.uploaded, 1);
});

test("a second 401 after the refresh is not refreshed again and deletes nothing", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const f = scriptedFetch({
    'POST /api/submissions': json(401, { detail: 'nope' }),
    'POST /api/auth/refresh': json(200, { access_token: 'A2', refresh_token: 'R2' }),
  });
  const r = await sync.syncOnce(f, { store });
  assert.equal(f.count('POST /api/auth/refresh'), 1);
  assert.equal(f.count('POST /api/submissions'), 2);
  assert.equal(r.authRequired, true);
  assert.equal(r.remaining, 1);
  assert.deepEqual(await sync.listRejected({ store }), []);
});

test("the new refresh token is persisted before the retry is sent", async () => {
  const store = memStore();
  await loggedIn(store);
  const order = [];
  const origPut = store.putSession.bind(store);
  store.putSession = async s => { order.push('persist:' + s.refresh_token); return origPut(s); };
  const f = scriptedFetch({
    'GET /api/forms': [() => { order.push('first'); return json(401, {}); }, () => { order.push('retry'); return json(200, []); }],
    'POST /api/auth/refresh': () => { order.push('refresh'); return json(200, { access_token: 'A2', refresh_token: 'R2' }); },
  });
  const res = await auth.makeAuthFetch(f, { store })('/api/forms');
  assert.equal(res.status, 200);
  assert.deepEqual(order, ['first', 'refresh', 'persist:R2', 'retry']);
});

test("if the new token cannot be written the old session is left as it was and nothing is retried", async () => {
  const store = memStore();
  await loggedIn(store);
  store.opts.failPutSession = true;
  const f = scriptedFetch({
    'GET /api/forms': json(401, {}),
    'POST /api/auth/refresh': json(200, { access_token: 'A2', refresh_token: 'R2' }),
  });
  await assert.rejects(auth.makeAuthFetch(f, { store })('/api/forms'));
  const kept = await store.getSession();
  assert.equal(kept.refresh_token, 'R1');
  assert.equal(kept.access_token, 'A1');
  assert.equal(f.count('GET /api/forms'), 1, 'must not carry on with a token it could not save');
});

test("a refresh reply that cannot be read forces a re-login rather than replaying the spent token", async () => {
  const store = memStore();
  await loggedIn(store);
  const f = scriptedFetch({
    'GET /api/forms': json(401, {}),
    'POST /api/auth/refresh': new Response('{"access_tok', { status: 200 }),
  });
  const res = await auth.makeAuthFetch(f, { store })('/api/forms');
  assert.equal(res.status, 401);
  assert.equal((await store.getSession()).needs_login, true);
  // Subsequent calls must not send the (probably spent) refresh token again.
  await auth.makeAuthFetch(f, { store })('/api/forms');
  assert.equal(f.count('POST /api/auth/refresh'), 1);
});

test("a network failure during refresh keeps the session so the refresh can be tried later", async () => {
  const store = memStore();
  await loggedIn(store);
  const f = scriptedFetch({ 'GET /api/forms': json(401, {}), 'POST /api/auth/refresh': () => netError() });
  const res = await auth.makeAuthFetch(f, { store })('/api/forms');
  assert.equal(res.status, 401);
  const s = await store.getSession();
  assert.equal(s.refresh_token, 'R1');
  assert.ok(!s.needs_login);
});

test("concurrent 401s share a single refresh (a replayed token would revoke the chain)", async () => {
  const store = memStore();
  await loggedIn(store);
  const f = scriptedFetch({
    'GET /api/forms': ({ headers }) => (headers.get('authorization') === 'Bearer A2' ? json(200, []) : json(401, {})),
    'POST /api/auth/refresh': async () => { await new Promise(r => setTimeout(r, 10)); return json(200, { access_token: 'A2', refresh_token: 'R2' }); },
  });
  const af = auth.makeAuthFetch(f, { store });
  const rs = await Promise.all([af('/api/forms'), af('/api/forms'), af('/api/forms')]);
  assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
  assert.equal(f.count('POST /api/auth/refresh'), 1);
});

test("a call that lost a race to a refresh retries with the new token instead of refreshing again", async () => {
  const store = memStore();
  await loggedIn(store);
  const bearer = h => h.get('authorization');
  const f = scriptedFetch({
    // A slow request goes out on A1 and only hears its 401 after another call has refreshed.
    'GET /api/slow': async ({ headers }) => {
      if (bearer(headers) === 'Bearer A1') { await new Promise(r => setTimeout(r, 30)); return json(401, {}); }
      return json(200, []);
    },
    'GET /api/forms': ({ headers }) => json(bearer(headers) === 'Bearer A1' ? 401 : 200, []),
    'POST /api/auth/refresh': json(200, { access_token: 'A2', refresh_token: 'R2' }),
  });
  const af = auth.makeAuthFetch(f, { store });
  const [slow, quick] = await Promise.all([af('/api/slow'), af('/api/forms')]);
  assert.equal(slow.status, 200);
  assert.equal(quick.status, 200);
  assert.equal(f.count('POST /api/auth/refresh'), 1, 'a second refresh would replay a spent token');
});

// A second "tab": same IndexedDB, but its own module state (its own flights map).
const otherTab = store => ({ ...store });

test("two tabs refreshing at once present the refresh token only once", async () => {
  const store = memStore();
  await loggedIn(store);
  let spent = false;
  const f = scriptedFetch({
    'GET /api/forms': ({ headers }) => (headers.get('authorization') === 'Bearer A2' ? json(200, []) : json(401, {})),
    'POST /api/auth/refresh': async ({ init }) => {
      await new Promise(r => setTimeout(r, 10));
      if (JSON.parse(init.body).refresh_token !== 'R1' || spent) return json(401, { detail: 'reuse: chain revoked' });
      spent = true;
      return json(200, { access_token: 'A2', refresh_token: 'R2' });
    },
  });
  const tabA = auth.makeAuthFetch(f, { store });
  const tabB = auth.makeAuthFetch(f, { store: otherTab(store) });
  const [a, b] = await Promise.all([tabA('/api/forms'), tabB('/api/forms')]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(f.count('POST /api/auth/refresh'), 1);
  const s = await store.getSession();
  assert.equal(s.refresh_token, 'R2');
  assert.ok(!s.needs_login);
});

test("a stale refusal never overwrites tokens another tab stored meanwhile", async () => {
  const store = memStore();
  await loggedIn(store);
  const f = scriptedFetch({
    'GET /api/forms': ({ headers }) => (headers.get('authorization') === 'Bearer A2' ? json(200, []) : json(401, {})),
    // While this tab's refresh is in flight, the other tab stores R2/A2; the server then refuses R1.
    'POST /api/auth/refresh': async () => {
      await store.putSession({ access_token: 'A2', refresh_token: 'R2', user: { id: 7 } });
      return json(401, { detail: 'Invalid refresh token' });
    },
  });
  const res = await auth.makeAuthFetch(f, { store })('/api/forms');
  assert.equal(res.status, 200, 'should carry on with the other tab\'s new token');
  const s = await store.getSession();
  assert.equal(s.refresh_token, 'R2');
  assert.equal(s.access_token, 'A2');
  assert.ok(!s.needs_login, 'must not flag a session whose token the server never refused');
});

test("needs_login is set only when the stored token is the one the server refused", async () => {
  const store = memStore();
  await loggedIn(store);
  const f = scriptedFetch({ 'GET /api/forms': json(401, {}), 'POST /api/auth/refresh': json(401, {}) });
  await auth.makeAuthFetch(f, { store })('/api/forms');
  assert.equal((await store.getSession()).needs_login, true);
});

test("an upper-case client uuid still matches its (lower-cased) receipt and is dequeued", async () => {
  const store = memStore();
  await loggedIn(store);
  const up = '3F2A9C10-AAAA-4BBB-8CCC-0123456789AB';
  await store.enqueue(sub(up), {});
  const f = scriptedFetch({ 'POST /api/submissions': json(201, receipt(up.toLowerCase())) });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.uploaded, 1);
  assert.equal(r.remaining, 0);
});

test("when the refresh token is refused the session is flagged and the queue is untouched", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), { p: photo() });
  const f = scriptedFetch({
    'POST /api/submissions': json(401, { detail: 'expired' }),
    'POST /api/auth/refresh': json(401, { detail: 'Invalid refresh token' }),
  });
  const r = await sync.syncOnce(f, { store });
  assert.equal(r.authRequired, true);
  assert.equal(r.remaining, 1);
  assert.equal((await store.getSession()).needs_login, true);
  assert.equal((await store.getMedia('u1')).length, 1);
});

test("a forced re-login leaves the queue untouched", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), { p: photo() });
  await store.enqueue(sub('u2'), {});
  const before = JSON.stringify(await store.peekQueue(10));
  const f = scriptedFetch({
    'POST /api/submissions': json(401, {}),
    'POST /api/auth/refresh': json(401, {}),
    'POST /api/auth/logout': new Response(null, { status: 204 }),
    'POST /api/auth/login': json(200, { access_token: 'B1', refresh_token: 'S1', user: { id: 7, role: 'enumerator' } }),
  });
  await sync.syncOnce(f, { store });
  await auth.logout({ fetchImpl: f, store });
  assert.equal(await store.getSession(), undefined);
  await auth.login('asha1', 'pw', { fetchImpl: f, store });
  assert.equal((await store.getSession()).access_token, 'B1');
  assert.equal(JSON.stringify(await store.peekQueue(10)), before);
  assert.equal((await store.getMedia('u1')).length, 1);
  assert.deepEqual(store.log.filter(l => l[0] === 'dequeue'), []);
});

test("logout revokes the refresh token on the server but never clears the queue", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const f = scriptedFetch({ 'POST /api/auth/logout': new Response(null, { status: 204 }) });
  await auth.logout({ fetchImpl: f, store });
  assert.equal(f.count('POST /api/auth/logout'), 1);
  assert.equal(await store.queueLength(), 1);
  assert.equal(await store.getSession(), undefined);
});

test("logout still signs out locally when the network is down", async () => {
  const store = memStore();
  await loggedIn(store);
  await auth.logout({ fetchImpl: scriptedFetch({ 'POST /api/auth/logout': () => netError() }), store });
  assert.equal(await store.getSession(), undefined);
});

test("login stores both tokens in the session store and returns the user", async () => {
  const store = memStore();
  const f = scriptedFetch({
    'POST /api/auth/login': ({ init }) => {
      assert.deepEqual(JSON.parse(init.body), { username: 'asha1', password: 'pw' });
      return json(200, { access_token: 'A', refresh_token: 'R', user: { id: 3, username: 'asha1', role: 'enumerator' } });
    },
  });
  const user = await auth.login('asha1', 'pw', { fetchImpl: f, store });
  assert.equal(user.id, 3);
  const s = await store.getSession();
  assert.equal(s.access_token, 'A');
  assert.equal(s.refresh_token, 'R');
  assert.equal(s.user.id, 3);
});

test("a failed login throws and leaves any existing session alone", async () => {
  const store = memStore();
  await loggedIn(store);
  const f = scriptedFetch({ 'POST /api/auth/login': json(401, { detail: 'Invalid username or password' }) });
  await assert.rejects(auth.login('x', 'y', { fetchImpl: f, store }), /Invalid username or password/);
  assert.equal((await store.getSession()).access_token, 'A1');
});

// ---- backoff ---------------------------------------------------------------------

test("backoff grows between consecutive failures", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  const f = scriptedFetch({ 'POST /api/submissions': json(503, { detail: 'down' }) });
  const delays = [];
  for (let i = 0; i < 4; i++) delays.push((await sync.syncOnce(f, { store })).retryInMs);
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i] > delays[i - 1], `delays ${delays}`);
  assert.ok(delays[0] > 0);
});

test("backoff is capped and resets after a clean run", async () => {
  assert.ok(sync.backoffDelay(50) <= sync.BACKOFF_CAP_MS);
  assert.equal(sync.backoffDelay(0), 0);
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('u1'), {});
  await sync.syncOnce(scriptedFetch({ 'POST /api/submissions': json(503, {}) }), { store });
  const r = await sync.syncOnce(scriptedFetch({ 'POST /api/submissions': json(201, receipt('u1')) }), { store });
  assert.equal(r.retryInMs, 0);
  await store.enqueue(sub('u2'), {});
  const again = await sync.syncOnce(scriptedFetch({ 'POST /api/submissions': json(503, {}) }), { store });
  assert.equal(again.retryInMs, sync.backoffDelay(1));
});

// ---- bootstrap -------------------------------------------------------------------

const SPEC_V1 = {
  form_id: 'amb_asha_visit', version: '2026103101', languages: ['hi'], default_language: 'hi',
  nodes: [
  ],
  choices: {},
};
const SPEC_V2 = { ...SPEC_V1, version: '2026110201' };
const SPEC_F2 = { form_id: 'anganwadi', version: '2026103001', nodes: [{ type: 'text', name: 'q', dataset: 'centres' }], choices: {} };

function bootstrapRoutes(extra = {}) {
  return {
    'GET /api/forms': json(200, [
      { form_id: 'amb_asha_visit', title: 'AMB', current_version: '2026103101' },
      { form_id: 'anganwadi', title: 'AWC', current_version: '2026103001' },
      { form_id: 'draftonly', title: 'Unpublished', current_version: null },
    ]),
    'GET /api/forms/amb_asha_visit/versions/2026103101/spec': json(200, SPEC_V1),
    'GET /api/forms/anganwadi/versions/2026103001/spec': json(200, SPEC_F2),
    'GET /api/config': json(200, { max_media_bytes: 1048576 }),
    'GET /api/datasets': json(200, [
      { name: 'asha_list', version: 1, project_id: 1 }, { name: 'blocks', version: 1, project_id: 1 }, { name: 'centres', version: 3, project_id: 2 },
    ]),
    'GET /api/datasets/1/asha_list': json(200, { name: 'asha_list', version: 1, project_id: 1, rows: [{ id: '1', name: 'सीता' }] }),
    'GET /api/datasets/1/blocks': json(200, { name: 'blocks', version: 1, project_id: 1, rows: [{ a: '1' }] }),
    'GET /api/datasets/2/centres': json(200, { name: 'centres', version: 3, project_id: 2, rows: [{ c: 'x' }] }),
    ...extra,
  };
}
const V2_LIST = {
  'GET /api/forms': json(200, [{ form_id: 'amb_asha_visit', title: 'AMB', current_version: '2026110201' }]),
  'GET /api/forms/amb_asha_visit/versions/2026110201/spec': json(200, SPEC_V2),
};

test("bootstrap stores every assigned form spec and its referenced datasets", async () => {
  const store = memStore();
  await loggedIn(store);
  const r = await sync.bootstrap(scriptedFetch(bootstrapRoutes()), { store });
  assert.ok(await store.getForm('amb_asha_visit', '2026103101'));
  assert.ok(await store.getForm('anganwadi', '2026103001'));
  assert.equal((await store.listForms()).length, 2, 'an unpublished form is not stored');
  assert.equal((await store.getDataset(sync.datasetKey(1, 'asha_list')))[0].name, 'सीता');
  assert.ok(await store.getDataset(sync.datasetKey(1, 'blocks')));
  assert.ok(await store.getDataset(sync.datasetKey(2, 'centres')));
  assert.equal(r.forms.length, 2);
  assert.deepEqual([...r.datasets].sort(), ['1/asha_list', '1/blocks', '2/centres']);
  assert.deepEqual(r.errors, []);
});

test("bootstrap downloads a newer published version without touching open drafts", async () => {
  const store = memStore();
  await loggedIn(store);
  await sync.bootstrap(scriptedFetch(bootstrapRoutes()), { store });
  await store.saveDraft({ id: 'd1', form_id: 'amb_asha_visit', version: '2026103101', answers: { asha_name: 'x' } });
  const draftBefore = JSON.stringify(await store.getDraft('d1'));
  const r = await sync.bootstrap(scriptedFetch(bootstrapRoutes(V2_LIST)), { store });
  assert.ok(await store.getForm('amb_asha_visit', '2026110201'), 'new version stored');
  assert.ok(await store.getForm('amb_asha_visit', '2026103101'), 'old version must be kept beside it');
  assert.equal(JSON.stringify(await store.getDraft('d1')), draftBefore);
  assert.equal(r.forms.find(x => x.version === '2026110201').downloaded, true);
});

test("bootstrap does not re-download a version it already has", async () => {
  const store = memStore();
  await loggedIn(store);
  await sync.bootstrap(scriptedFetch(bootstrapRoutes()), { store });
  const f = scriptedFetch(bootstrapRoutes());
  await sync.bootstrap(f, { store });
  assert.equal(f.calls.filter(c => c.path.endsWith('/spec')).length, 0);
});

test("a draft started on an old version still reports that version on submit", async () => {
  const store = memStore();
  await loggedIn(store);
  await sync.bootstrap(scriptedFetch(bootstrapRoutes()), { store });
  await store.saveDraft({ id: 'd1', form_id: 'amb_asha_visit', version: '2026103101', answers: {} });
  await sync.bootstrap(scriptedFetch(bootstrapRoutes(V2_LIST)), { store });
  const draft = await store.getDraft('d1');
  assert.equal(draft.version, '2026103101');
  const spec = await store.getForm(draft.form_id, draft.version);
  assert.equal(spec.version, '2026103101', 'the draft resolves to the spec it started on');
  // ...and what goes on the queue carries that version to the server.
  await store.enqueue({ uuid: 'u1', form_id: draft.form_id, version: draft.version, data: {} }, {});
  const f = scriptedFetch({ 'POST /api/submissions': accept });
  await sync.syncOnce(f, { store });
  assert.equal(JSON.parse(f.calls[0].body.get('submission')).version, '2026103101');
});

test("one failing dataset does not abort the rest and keeps the copy already on the device", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.putDataset(sync.datasetKey(1, 'blocks'), [{ a: 'old' }]);
  const f = scriptedFetch(bootstrapRoutes({ 'GET /api/datasets/1/blocks': json(500, { detail: 'x' }) }));
  const r = await sync.bootstrap(f, { store });
  assert.deepEqual(await store.getDataset(sync.datasetKey(1, 'blocks')), [{ a: 'old' }]);
  assert.ok(await store.getDataset(sync.datasetKey(1, 'asha_list')));
  assert.equal(r.errors.length, 1);
});

test("a spec whose identity disagrees with the form list is not stored", async () => {
  const store = memStore();
  await loggedIn(store);
  const f = scriptedFetch(bootstrapRoutes({
    'GET /api/forms/anganwadi/versions/2026103001/spec': json(200, { ...SPEC_F2, version: '1999' }),
  }));
  const r = await sync.bootstrap(f, { store });
  assert.equal(await store.getForm('anganwadi', '2026103001'), undefined);
  assert.equal(await store.getForm('anganwadi', '1999'), undefined);
  assert.equal(r.errors.length, 1);
});

test("a bootstrap dataset refresh leaves rejected records untouched", async () => {
  const store = memStore();
  await loggedIn(store);
  await store.enqueue(sub('r1'), { p: photo('KEEP') });
  await sync.syncOnce(scriptedFetch({ 'POST /api/submissions': refusal(403, 'not_assigned') }), { store });
  const snap = async () => JSON.stringify((await sync.listRejected({ store })).map(r => ({ ...r, media: r.media.length })));
  const before = await snap();
  await sync.bootstrap(scriptedFetch(bootstrapRoutes()), { store });
  await sync.bootstrap(scriptedFetch(bootstrapRoutes({ 'GET /api/datasets': json(200, []) })), { store });
  assert.equal(await snap(), before);
  assert.equal(await (await sync.listRejected({ store }))[0].media[0].blob.text(), 'KEEP');
});

test("bootstrap downloads every dataset the server lists, whatever the specs say", async () => {
  const store = memStore();
  await loggedIn(store);
  const r = await sync.bootstrap(scriptedFetch(bootstrapRoutes({
    'GET /api/datasets': json(200, [{ name: 'only_listed', version: 1, project_id: 4 }]),
    'GET /api/datasets/4/only_listed': json(200, { name: 'only_listed', version: 1, project_id: 4, rows: [{ k: 'v' }] }),
  })), { store });
  assert.deepEqual(r.datasets, ['4/only_listed']);
  assert.deepEqual(await store.getDataset(sync.datasetKey(4, 'only_listed')), [{ k: 'v' }]);
});

test("two projects' datasets with the same name coexist on one device", async () => {
  const store = memStore();
  await loggedIn(store);
  const f = scriptedFetch(bootstrapRoutes({
    'GET /api/datasets': json(200, [
      { name: 'villages', version: 1, project_id: 3 }, { name: 'villages', version: 7, project_id: 9 },
    ]),
    'GET /api/datasets/3/villages': json(200, { name: 'villages', version: 1, project_id: 3, rows: [{ v: 'three' }] }),
    'GET /api/datasets/9/villages': json(200, { name: 'villages', version: 7, project_id: 9, rows: [{ v: 'nine' }] }),
  }));
  const r = await sync.bootstrap(f, { store });
  assert.deepEqual(r.errors, []);
  assert.deepEqual([...r.datasets].sort(), ['3/villages', '9/villages']);
  assert.deepEqual(await store.getDataset(sync.datasetKey(3, 'villages')), [{ v: 'three' }]);
  assert.deepEqual(await store.getDataset(sync.datasetKey(9, 'villages')), [{ v: 'nine' }]);
});

test("a listed dataset with no usable project is skipped and reported, never fetched by name alone", async () => {
  const store = memStore();
  await loggedIn(store);
  const r = await sync.bootstrap(scriptedFetch(bootstrapRoutes({
    'GET /api/datasets': json(200, [{ name: 'villages', version: 1 }, { name: 'blocks', version: 1, project_id: 'x' }]),
  })), { store });
  assert.deepEqual(r.datasets, []);
  assert.equal(r.errors.filter(e => e.dataset).length, 2);
});

test("a server with no dataset listing is reported, not fatal, and forms still download", async () => {
  const store = memStore();
  await loggedIn(store);
  const routes = bootstrapRoutes();
  delete routes['GET /api/datasets'];
  const r = await sync.bootstrap(scriptedFetch(routes), { store });
  assert.equal(r.forms.length, 2);
  assert.ok(r.errors.some(e => e.dataset === '*'));
});

test("bootstrap returns the client config, so the renderer can size photos to the cap", async () => {
  const store = memStore();
  await loggedIn(store);
  const r = await sync.bootstrap(scriptedFetch(bootstrapRoutes()), { store });
  assert.equal(r.config.max_media_bytes, 1048576);
  assert.deepEqual(r.errors, []);
});

test("a config fetch failure is recorded and bootstrap carries on", async () => {
  for (const bad of [json(500, { detail: 'x' }), () => netError(), new Response('<html>', { status: 200 })]) {
    const store = memStore();
    await loggedIn(store);
    const r = await sync.bootstrap(scriptedFetch(bootstrapRoutes({ 'GET /api/config': bad })), { store });
    assert.deepEqual(r.config, {});
    assert.ok(r.errors.some(e => e.config), 'config error should be recorded');
    assert.equal(r.forms.length, 2, 'forms must still download');
    assert.ok(await store.getDataset(sync.datasetKey(1, 'asha_list')), 'datasets must still download');
  }
});

test("bootstrap throws when the form list cannot be fetched, leaving the device as it was", async () => {
  const store = memStore();
  await loggedIn(store);
  await sync.bootstrap(scriptedFetch(bootstrapRoutes()), { store });
  await assert.rejects(sync.bootstrap(scriptedFetch({ 'GET /api/forms': () => netError() }), { store }));
  assert.ok(await store.getForm('amb_asha_visit', '2026103101'));
});
