// Browser tests for js/sync.js, js/auth.js and sw.js, against real IndexedDB and a
// real service worker. The network is a stub fetch standing in for the server,
// which records what it "stored" so exactly-once can be asserted on its side.
import * as db from '../js/db.js';
import * as sync from '../js/sync.js';

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
  }
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sub = (uuid, extra = {}) => ({ uuid, form_id: 'hh', version: '2026103101', data: { name: 'सीता' }, repeats: {}, ...extra });
const photo = text => new Blob([text], { type: 'image/jpeg' });

async function fresh() {
  sync._resetSyncState();
  await db.deleteDB();
  await db.openDB();
  await db.putSession({ access_token: 'A1', refresh_token: 'R1', user: { id: 1, role: 'enumerator' } });
}

// A server stand-in with the real contract: 201 on first sight of a uuid, 200 for a replay.
function fakeServer({ loseFirstReply = false } = {}) {
  const stored = new Map();   // uuid -> times received
  let lost = false;
  const fn = async (url, init = {}) => {
    if (String(url).endsWith('/api/submissions')) {
      const uuid = JSON.parse(init.body.get('submission')).uuid;
      const seen = stored.get(uuid) || 0;
      if (!seen) stored.set(uuid, { n: 1, photo: init.body.get('p') ? await init.body.get('p').text() : null });
      const first = !seen;
      if (loseFirstReply && !lost) { lost = true; throw new TypeError('Failed to fetch'); }
      return json(first ? 201 : 200, { uuid, status: 'received', received_at: new Date().toISOString(), failures: [] });
    }
    return json(404, { detail: 'not in fake' });
  };
  fn.stored = stored;
  return fn;
}
const offline = async () => { throw new TypeError('Failed to fetch'); };

export async function test_offline_fill_then_online_sync_arrives_exactly_once() {
  await fresh();
  // Offline: an enumerator fills two forms; every sync attempt fails at the network.
  await db.enqueue(sub('o1'), { p: photo('PHOTO-1') });
  await db.enqueue(sub('o2'), { p: photo('PHOTO-2') });
  const r0 = await sync.syncOnce(offline);
  eq(r0.remaining, 2, 'nothing may leave the queue while offline');
  eq((await db.getMedia('o1')).length, 1);

  // Online, but the first reply is lost on the way back: the server has it, the client does not know.
  const server = fakeServer({ loseFirstReply: true });
  const r1 = await sync.syncOnce(server);
  eq(r1.remaining, 2 - r1.uploaded - r1.replayed, 'remaining must equal what was not confirmed');
  const r2 = await sync.syncOnce(server);
  eq(r2.remaining, 0);
  // A further run, and a deliberate second submit of the same uuid, must change nothing.
  await db.enqueue(sub('o1'), { p: photo('PHOTO-1') });
  const r3 = await sync.syncOnce(server);
  eq(r3.uploaded, 0, 'a replay is not a new upload');
  eq(r3.replayed, 1);

  eq([...server.stored.keys()].sort(), ['o1', 'o2']);
  for (const v of server.stored.values()) eq(v.n, 1, 'server created a record more than once');
  eq(server.stored.get('o2').photo, 'PHOTO-2');
  eq(await db.queueLength(), 0);
  eq((await db.getMedia('o1')).length + (await db.getMedia('o2')).length, 0, 'media must leave with its submission');
}

export async function test_the_queue_is_intact_after_a_reload_mid_sync() {
  await fresh();
  await db.enqueue(sub('m1'), { p: photo('ONE') });
  await db.enqueue(sub('m2'), { p: photo('TWO') });
  await db.enqueue(sub('m3'), {});

  // The upload of m1 starts and the page "dies" before any reply: the fetch never returns.
  let started;
  const sawFirst = new Promise(r => { started = r; });
  const hang = () => { started(); return new Promise(() => {}); };
  sync.syncOnce(hang);   // deliberately not awaited
  await sawFirst;
  await db.closeDB();    // what a reload does to this document's connection

  // A brand-new document, with fresh module state, reads the same database.
  const reply = await new Promise((resolve, reject) => {
    const f = document.createElement('iframe');
    const timer = setTimeout(() => reject(new Error('probe timed out')), 8000);
    window.addEventListener('message', function h(e) {
      if (e.data && e.data.probe === 'queue') { clearTimeout(timer); window.removeEventListener('message', h); f.remove(); resolve(e.data); }
    });
    f.src = 'browser.html?probe=queue';
    document.body.appendChild(f);
  });
  eq(reply.n, 3, 'the in-flight submission must still be queued');
  eq(reply.uuids, ['m1', 'm2', 'm3']);

  // After the reload the sync picks up where it left off; the server already had m1.
  sync._resetSyncState();
  await db.openDB();
  eq((await db.getMedia('m1')).length, 1, 'media of the in-flight submission must survive');
  const server = fakeServer();
  await server('/api/submissions', { body: (() => { const fd = new FormData(); fd.set('submission', JSON.stringify({ uuid: 'm1' })); return fd; })() });
  const r = await sync.syncOnce(server);
  eq(r.remaining, 0);
  eq(r.uploaded, 2);
  eq(r.replayed, 1);
  eq([...server.stored.values()].map(v => v.n), [1, 1, 1]);
}

export async function test_the_app_shell_loads_with_the_network_disabled() {
  assert('serviceWorker' in navigator, 'service workers unavailable');
  const reg = await navigator.serviceWorker.register('../sw.js');
  try {
    await navigator.serviceWorker.ready;
    // Wait until this page is controlled (the worker claims clients on activate).
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('worker never took control')), 8000);
        navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
    const tell = (msg) => new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = e => resolve(e.data);
      navigator.serviceWorker.controller.postMessage(msg, [ch.port2]);
    });

    // Touch an API URL while online: whatever the server says, it must never be cached.
    await fetch('/api/forms').catch(() => {});

    // Cut the network under the worker.
    eq((await tell({ type: 'test-offline', on: true })).ok, true);
    const shell = ['../js/db.js', '../js/sync.js', '../js/auth.js', '../manifest.webmanifest'];
    for (const url of shell) {
      const res = await fetch(url);
      assert(res.ok, url + ' not served from the shell cache while offline: ' + res.status);
    }
    assert((await (await fetch('../js/sync.js')).text()).includes('syncOnce'), 'cached sync.js is not the real file');

    // Prove the switch is real: something that is not in the shell must fail now.
    let reached = true;
    try { const r = await fetch('../tests/browser.html?not-in-shell=' + Math.random()); reached = r.ok; } catch { reached = false; }
    assert(!reached, 'network was not actually disabled, so the cache hit proves nothing');
    // An API call goes to the network (and fails): it is never answered from cache.
    let apiAnswered = true;
    try { const r = await fetch('/api/forms'); apiAnswered = r.ok; } catch { apiAnswered = false; }
    assert(!apiAnswered, 'an API call was answered while offline');

    await tell({ type: 'test-offline', on: false });
    const cached = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) cached.push(req.url);
    assert(cached.length > 0, 'nothing was cached');
    assert(!cached.some(u => new URL(u).pathname.startsWith('/api/')), 'an API response was cached: ' + cached.filter(u => u.includes('/api/')));
  } finally {
    try { navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage({ type: 'test-offline', on: false }); } catch { /* ignore */ }
    await reg.unregister();
    for (const name of await caches.keys()) await caches.delete(name);
  }
}
