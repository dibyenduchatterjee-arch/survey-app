// Browser tests for js/sync.js, js/projects.js and sw.js, against REAL IndexedDB and a real service
// worker. They cover what the node tests (sync.test.js, projects.test.js) cannot: that the
// queue, media, sessions and the name-to-id migration behave in the browser's own database.
//
// The backend is the Apps Script Web App, stubbed: `fakeBackend` from _fakes.mjs answers open /
// forms / submit as a POST of text/plain and records what it "stored", so exactly-once can be asserted
// on its side. NO test here touches the network: every call goes through the stub fetch.
import * as db from '../js/db.js';
import * as sync from '../js/sync.js';
import * as projects from '../js/projects.js';
import { fakeBackend, URL_, FORM_A } from './_fakes.mjs';

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
  }
}
const ID = 'id-Bihar AMB';
const FID = ID + '::visit';
const sub = (uuid, extra = {}) => ({ uuid, form_id: FID, version: '2026103101', person: 'Sita', data: { asha_name: 'सीता' }, repeats: {}, ...extra });
const photo = text => new Blob([text], { type: 'image/jpeg' });
const world = (extra = {}) => fakeBackend({ GAYA2026: { name: 'Bihar AMB', forms: [FORM_A], ...extra } });
const opts = be => ({ fetchImpl: be.fetchImpl, url: URL_, sleep: async () => {}, random: () => 0.5 });
const offline = async () => { throw new TypeError('Failed to fetch'); };
const down = be => ({ ...opts(be), fetchImpl: offline });

// A clean database holding one opened project and its downloaded forms.
async function fresh(be = world()) {
  sync._resetSyncState();
  await db.deleteDB();
  await db.openDB();
  await projects.openProject('GAYA2026', opts(be));
  await sync.bootstrap(opts(be));
  return be;
}
const rows = (be) => be.rows(ID, 'visit');

export async function test_offline_fill_then_online_sync_arrives_exactly_once() {
  const be = await fresh();
  // Offline: two forms are filled; every sync attempt fails at the network. Nothing may leave the queue.
  await db.enqueue(sub('o1'), { household_photo: photo('PHOTO-1') });
  await db.enqueue(sub('o2'), { household_photo: photo('PHOTO-2') });
  await sync.syncOnce(down(be));
  eq(await db.queueLength(), 2, 'nothing may leave the queue while offline');
  eq((await db.getMedia('o1')).length, 1);

  // Online, but the first reply is lost on the way back: the backend has it, the client does not know.
  let lost = false;
  const lossy = { ...opts(be), fetchImpl: async (u, init) => {
    const res = await be.fetchImpl(u, init);
    if (!lost && JSON.parse(init.body).action === 'submit') { lost = true; throw new TypeError('Failed to fetch'); }
    return res;
  } };
  await sync.syncOnce(lossy);
  await sync.syncOnce(lossy);
  eq(await db.queueLength(), 0, 'after retries the queue is empty');
  // A deliberate second submit of the same uuid is a replay: nothing new is written.
  await db.enqueue(sub('o1'), { household_photo: photo('PHOTO-1') });
  const r3 = await sync.syncOnce(opts(be));
  eq(r3.uploaded, 0, 'a replay is not a new upload');
  eq(r3.replayed, 1);
  eq(rows(be).map(r => r.uuid).sort(), ['o1', 'o2'], 'exactly one row per uuid');
  eq(await db.queueLength(), 0);
  eq((await db.getMedia('o1')).length + (await db.getMedia('o2')).length, 0, 'media must leave with its submission');
  // Every attempt for a uuid carried that same uuid, and the phone never named a person.
  assert(be.calls.filter(c => c.action === 'submit').every(c => !JSON.stringify(c).includes('_submitted_by')), 'the phone must never send _submitted_by');
}

export async function test_an_html_error_page_and_a_quota_refusal_keep_the_record_queued() {
  const be = await fresh();
  await db.enqueue(sub('h1'), {});
  be.fail.submit = n => (n === 1 ? 'html' : n === 2 ? { ok: false, error: 'busy', message: 'Service invoked too many times for one day', retry: true } : undefined);
  const r1 = await sync.syncOnce({ ...opts(be), maxAttempts: 1 });
  eq(r1.rejected, 0, 'an HTML page is not a refusal');
  eq(await db.queueLength(), 1, 'the record must still be queued');
  eq((await db.listRejected()).length, 0);
  const r2 = await sync.syncOnce({ ...opts(be), maxAttempts: 1 });
  eq(r2.rejected, 0, 'a quota refusal is retryable');
  eq(await db.queueLength(), 1);
  const r3 = await sync.syncOnce(opts(be));
  eq(r3.uploaded, 1);
  eq(await db.queueLength(), 0);
  const uuids = be.calls.filter(c => c.action === 'submit').map(c => c.uuid);
  eq(uuids, ['h1', 'h1', 'h1'], 'a retry sends the SAME uuid');
}

export async function test_the_queue_is_intact_after_a_reload_mid_sync() {
  const be = await fresh();
  await db.enqueue(sub('m1'), { household_photo: photo('ONE') });
  await db.enqueue(sub('m2'), { household_photo: photo('TWO') });
  await db.enqueue(sub('m3'), {});

  // The upload of m1 starts and the page "dies" before any reply: the fetch never returns.
  let started;
  const sawFirst = new Promise(r => { started = r; });
  const hang = (u, init) => (JSON.parse(init.body).action === 'submit' ? (started(), new Promise(() => {})) : be.fetchImpl(u, init));
  sync.syncOnce({ ...opts(be), fetchImpl: hang });   // deliberately not awaited
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

  // After the reload the sync picks up where it left off; the backend saw none of them.
  sync._resetSyncState();
  await db.openDB();
  eq((await db.getMedia('m1')).length, 1, 'media of the in-flight submission must survive');
  const r = await sync.syncOnce(opts(be));
  eq(r.uploaded, 3);
  eq(await db.queueLength(), 0);
  eq(rows(be).map(x => x.uuid), ['m1', 'm2', 'm3']);
}

export async function test_a_refused_submission_is_kept_with_its_photo_and_survives_a_form_refresh() {
  const be = await fresh();
  await db.enqueue(sub('rj'), { household_photo: photo('KEEP') });
  be.fail.submit = () => ({ ok: false, error: 'layout_mismatch', message: 'The form changed.', retry: false });
  const r = await sync.syncOnce(opts(be));
  eq(r.rejected, 1);
  be.fail = {};
  await sync.bootstrap(opts(be));
  await sync.bootstrap(opts(be));      // a refresh of the forms must never touch a refused record
  const [rec] = await sync.listRejected();
  eq(rec.uuid, 'rj');
  eq(await rec.media[0].blob.text(), 'KEEP');
  await sync.retryRejected('rj');
  eq(await db.queueLength(), 1);
  eq((await db.listRejected()).length, 0);
  const r2 = await sync.syncOnce(opts(be));
  eq(r2.uploaded, 1);
  eq(rows(be).length, 1);
}

export async function test_a_draft_stays_on_the_form_version_it_started_on() {
  const be = await fresh();
  await db.saveDraft({ id: 'd1', form_id: FID, version: '2026103101', data: { asha_name: 'आधा' } });
  be.projects.GAYA2026.forms = [{ ...FORM_A, version: '2026113001' }];
  await sync.bootstrap(opts(be));
  eq((await db.listForms()).map(f => f.version).sort(), ['2026103101', '2026113001'], 'the new version sits beside the old');
  const d = await db.getDraft('d1');
  eq(d.version, '2026103101');
  assert(await db.getForm(d.form_id, d.version), 'the draft must still find the version it started on');
}

export async function test_tokens_and_codes_are_in_indexeddb_not_localstorage() {
  const be = await fresh();
  const rec = await db.getSessionRecord('project:' + ID);
  assert(rec && rec.token && rec.code === 'GAYA2026', 'the project record must hold the token and code in IndexedDB');
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    assert(!String(localStorage.getItem(k)).includes(rec.token) && !String(localStorage.getItem(k)).includes('GAYA2026'), 'localStorage holds a token or code under ' + k);
  }
  assert(be.calls.length > 0);
}

// What a phone from the previous build holds: everything keyed by the project NAME.
async function seedNameKeyed() {
  sync._resetSyncState();
  await db.deleteDB();
  await db.openDB();
  const NAME = 'Bihar AMB';
  await db.putSessionRecord({ id: 'project:' + NAME, key: NAME, name: NAME, person: 'Sita', code: 'GAYA2026', token: 'old', expires_at: null, revoked: false, added_at: 5 });
  await db.putSessionRecord({ id: 'active', key: NAME });
  for (const version of ['2026101001', '2026103101']) await db.putForm({ ...FORM_A, version, form_id: NAME + '::visit', _form_id: 'visit', _project: { id: NAME, name: NAME } });
  await db.putForm({ ...FORM_A, version: '2026103101', form_id: 'Other::visit', _project: { id: 'Other', name: 'Other' } });
  await db.saveDraft({ id: 'd1', form_id: NAME + '::visit', version: '2026101001', data: { asha_name: 'आधा' } });
  await db.enqueue(sub('q1', { form_id: NAME + '::visit' }), { household_photo: photo('PIC') });
  await db.putRejected({ uuid: 'r1', form_id: NAME + '::visit', version: '2026103101', submission: { uuid: 'r1', form_id: NAME + '::visit' }, media: [] });
}

export async function test_name_keyed_data_moves_to_the_id_in_real_indexeddb() {
  const be = world();
  await seedNameKeyed();
  await projects.openProject('GAYA2026', opts(be));
  eq(await db.getSessionRecord('project:Bihar AMB'), undefined, 'no record may stay under the name');
  const rec = await db.getSessionRecord('project:' + ID);
  eq([rec.key, rec.name, rec.added_at], [ID, 'Bihar AMB', 5]);
  eq((await db.getSessionRecord('active')).key, ID);
  const forms = (await db.listForms()).map(f => f.form_id + '@' + f.version).sort();
  eq(forms, ["Other::visit@2026103101", FID + "@2026101001", FID + "@2026103101"], 'both versions moved, another project untouched');
  const d = await db.getDraft('d1');
  eq([d.form_id, d.version], [FID, '2026101001'], 'the draft keeps its own version');
  assert(await db.getForm(d.form_id, d.version), 'and that version is still there');
  const [q] = await db.peekQueue(5);
  eq([q.uuid, q.form_id], ['q1', FID], 'the queued record keeps its uuid');
  eq((await db.getMedia('q1')).length, 1, 'and its photo');
  const [r] = await db.listRejected();
  eq([r.form_id, r.submission.form_id], [FID, FID]);
  // And it sends, once.
  await sync.syncOnce(opts(be));
  eq(await db.queueLength(), 0);
  eq(rows(be).map(x => x.uuid), ['q1']);
  // Running the move again changes nothing.
  await db.migrateProjectKey('Bihar AMB', ID, 'Bihar AMB');
  eq((await db.listForms()).length, 3);
}

export async function test_the_service_worker_serves_the_app_shell_with_the_network_disabled() {
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

    // Cut the network under the worker.
    eq((await tell({ type: 'test-offline', on: true })).ok, true);
    const shell = ['../js/db.js', '../js/sync.js', '../js/projects.js', '../js/projectkey.js', '../manifest.webmanifest'];
    for (const url of shell) {
      const res = await fetch(url);
      assert(res.ok, url + ' not served from the shell cache while offline: ' + res.status);
    }
    assert((await (await fetch('../js/sync.js')).text()).includes('syncOnce'), 'cached sync.js is not the real file');

    // Prove the switch is real: something that is not in the shell must fail now.
    let reached = true;
    try { const r = await fetch('../tests/browser.html?not-in-shell=' + Math.random()); reached = r.ok; } catch { reached = false; }
    assert(!reached, 'network was not actually disabled, so the cache hit proves nothing');
    await tell({ type: 'test-offline', on: false });
  } finally {
    try { navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage({ type: 'test-offline', on: false }); } catch { /* ignore */ }
    await reg.unregister();
    for (const name of await caches.keys()) await caches.delete(name);
  }
}

export async function test_upgrading_from_v1_carries_parked_rejections_into_the_rejected_store() {
  await db.deleteDB();
  // Build a genuine version-1 database holding what the earliest build parked in preload.
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('evac-survey', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('forms', { keyPath: ['form_id', 'version'] });
      d.createObjectStore('preload', { keyPath: 'name' });
      d.createObjectStore('drafts', { keyPath: 'id' }).createIndex('by_updated', 'updated_at');
      d.createObjectStore('queue', { keyPath: 'uuid' }).createIndex('by_queued', 'queued_at');
      d.createObjectStore('media', { keyPath: ['uuid', 'question'] });
      d.createObjectStore('session', { keyPath: 'id' });
      const tx = req.transaction;
      tx.objectStore('preload').put({ name: '_rejected_submissions', rows: [{ uuid: 'old1', status: 403, submission: { uuid: 'old1' }, media: [{ question: 'p', blob: photo('OLD') }] }] });
      tx.objectStore('preload').put({ name: 'blocks', rows: [{ a: 1 }] });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
  const list = await db.listRejected();
  eq(list.map(r => r.uuid), ['old1']);
  eq(await list[0].media[0].blob.text(), 'OLD');
  eq(await db.getDataset('_rejected_submissions'), undefined, 'legacy copy should be gone');
  eq(await db.getDataset('blocks'), [{ a: 1 }], 'real datasets must be untouched by the upgrade');
}
