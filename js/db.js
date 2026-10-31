// IndexedDB storage layer for the enumerator app.
//
// Everything an enumerator enters lives ONLY here until a connection appears,
// so durability is the first requirement of this file.
//
// Database "evac-survey", version 2. Stores and keys (Task 20 depends on these):
//   forms    keyPath [form_id, version]
//   preload  keyPath name                     { name, rows }
//   drafts   keyPath id                       index by_updated(updated_at)
//   queue    keyPath uuid                     index by_queued(queued_at)
//   media    keyPath [uuid, question]         { uuid, question, blob }
//   session  keyPath id                       singleton, id 'current'
//   rejected keyPath uuid                     submissions the server definitively refused (v2)
//                                             kept with answers and photos so they can be retried;
//                                             never touched by dataset refreshes
//
// Invariant: a queue record and its media records are written, and removed,
// inside ONE transaction. A crash or error can never leave media without a
// submission, or a submission pointing at media that was never stored.

export const DB_NAME = 'evac-survey';
export const DB_VERSION = 2;
const LEGACY_REJECTED = '_rejected_submissions'; // v1 builds kept these in preload
const SESSION_ID = 'current';

let dbPromise = null;
let seq = 0;

function onUpgrade(db, tx, oldVersion) {
  if (oldVersion < 1) {
    db.createObjectStore('forms', { keyPath: ['form_id', 'version'] });
    db.createObjectStore('preload', { keyPath: 'name' });
    const drafts = db.createObjectStore('drafts', { keyPath: 'id' });
    drafts.createIndex('by_updated', 'updated_at');
    const queue = db.createObjectStore('queue', { keyPath: 'uuid' });
    queue.createIndex('by_queued', 'queued_at');
    db.createObjectStore('media', { keyPath: ['uuid', 'question'] });
    db.createObjectStore('session', { keyPath: 'id' });
  }
  if (oldVersion < 2) {
    const rejected = db.createObjectStore('rejected', { keyPath: 'uuid' });
    if (oldVersion >= 1) {
      // Carry across anything an earlier build parked in preload, inside this same
      // upgrade transaction: if anything fails, the whole upgrade rolls back.
      const preload = tx.objectStore('preload');
      const get = preload.get(LEGACY_REJECTED);
      get.onsuccess = () => {
        const rec = get.result;
        if (rec && Array.isArray(rec.rows)) for (const row of rec.rows) if (row && row.uuid) rejected.put(row);
        if (rec) preload.delete(LEGACY_REJECTED);
      };
    }
  }
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => onUpgrade(req.result, req.transaction, e.oldVersion);
    req.onblocked = () => reject(new Error('Database is blocked by another open tab'));
    req.onerror = () => reject(classifyError(req.error));
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading, or the browser evicting the connection: drop the
      // cached handle so the next call reopens instead of failing forever.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
  }).catch(e => { dbPromise = null; throw e; });
  // Ask the browser not to evict our data under storage pressure. Best effort.
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => {}); } catch { /* ignore */ }
  return dbPromise;
}

export async function closeDB() {
  if (!dbPromise) return;
  const p = dbPromise;
  dbPromise = null;
  try { (await p).close(); } catch { /* never opened */ }
}

// Test and logout-wipe helper: close and delete the whole database.
export async function deleteDB() {
  await closeDB();
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase blocked by an open connection'));
  });
}

// Quota errors must reach the UI as "storage full", never as a silent loss.
export function classifyError(err) {
  const e = err instanceof Error || (err && err.message !== undefined) ? err : new Error(String(err));
  if (e && e.name === 'QuotaExceededError') {
    const out = new Error('Device storage is full. Free up space, then try saving again.');
    out.name = 'QuotaExceededError';
    out.quota = true;
    out.cause = e;
    return out;
  }
  return e;
}
export const _classifyError = classifyError;

// Run fn(tx) in one transaction and resolve with fn's result ONLY after the
// transaction has committed (oncomplete), not merely when a request succeeds.
// If fn throws, or calls fail(e), the transaction is aborted so partial writes roll back.
async function run(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    } catch (e) { reject(classifyError(e)); return; }
    let result;
    let failure = null;
    const fail = e => { failure = e; try { tx.abort(); } catch { /* already finished */ } };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(classifyError(failure || tx.error || new Error('Transaction aborted')));
    tx.onerror = () => { if (!failure) failure = tx.error; };
    try {
      result = fn(tx, fail);
    } catch (e) {
      fail(e);
    }
  });
}

const reqP = r => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

// Read helpers: resolve with the request's value once the tx completes.
function read(store, fn) {
  return run([store], 'readonly', tx => {
    const box = {};
    const r = fn(tx.objectStore(store));
    r.onsuccess = () => { box.v = r.result; };
    return box;
  }).then(box => box.v);
}
function write(store, fn) {
  return run([store], 'readwrite', tx => { fn(tx.objectStore(store)); });
}

// ---- forms ----
export function putForm(spec) {
  if (!spec || spec.form_id === undefined || spec.version === undefined) {
    return Promise.reject(new Error('putForm needs form_id and version'));
  }
  return write('forms', s => s.put(spec));
}
export const getForm = (formId, version) => read('forms', s => s.get([formId, version]));
export const listForms = () => read('forms', s => s.getAll()).then(v => v || []);

// ---- preload datasets ----
export function putDataset(name, rows) {
  return write('preload', s => s.put({ name, rows }));
}
export const getDataset = name => read('preload', s => s.get(name)).then(r => (r ? r.rows : undefined));

// ---- drafts ----
export function saveDraft(draft) {
  if (!draft || draft.id === undefined || draft.id === null) {
    return Promise.reject(new Error('saveDraft needs an id'));
  }
  return write('drafts', s => s.put({ ...draft, updated_at: Date.now() }));
}
export const getDraft = id => read('drafts', s => s.get(id));
export const listDrafts = () => read('drafts', s => s.getAll()).then(v => v || []);
export const deleteDraft = id => write('drafts', s => s.delete(id));

// ---- upload queue ----
const mediaRange = uuid => IDBKeyRange.bound([uuid], [uuid, []]); // every [uuid, <string>]

// mediaBlobs: { [question]: Blob }. Submission and media commit together or not at all.
export function enqueue(submission, mediaBlobs) {
  if (!submission || typeof submission.uuid !== 'string' || !submission.uuid) {
    return Promise.reject(new Error('enqueue needs a submission with a uuid'));
  }
  const uuid = submission.uuid;
  const entries = Object.entries(mediaBlobs || {});
  return run(['queue', 'media'], 'readwrite', (tx, fail) => {
    const queue = tx.objectStore('queue');
    const media = tx.objectStore('media');
    const existing = queue.get(uuid);
    existing.onsuccess = () => {
      try {
        const prev = existing.result;
        const queued_at = prev && prev.queued_at !== undefined ? prev.queued_at : Date.now() + (seq++ % 1000) / 1000;
        // Re-enqueue replaces: drop media from the earlier attempt so none lingers.
        media.delete(mediaRange(uuid));
        queue.put({ ...submission, queued_at });
        for (const [question, blob] of entries) media.put({ uuid, question, blob });
      } catch (e) {
        // A throw inside a request callback would not abort on its own.
        fail(e);
      }
    };
  });
}

export async function peekQueue(n = 1) {
  const out = [];
  const limit = Math.max(0, n | 0);
  if (!limit) return out;
  await run(['queue'], 'readonly', tx => {
    const req = tx.objectStore('queue').index('by_queued').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c && out.length < limit) { out.push(c.value); c.continue(); }
    };
  });
  return out;
}

export function dequeue(uuid) {
  return run(['queue', 'media'], 'readwrite', tx => {
    tx.objectStore('queue').delete(uuid);
    tx.objectStore('media').delete(mediaRange(uuid));
  });
}

export const queueLength = () => read('queue', s => s.count());

// Media for one queued submission: [{ uuid, question, blob }, ...]
export const getMedia = uuid => read('media', s => s.getAll(mediaRange(uuid))).then(v => v || []);

// ---- rejected submissions ----
// rec: { uuid, form_id, version, status, code, message, rejected_at, submission, media: [{question, blob}] }
export function putRejected(rec) {
  if (!rec || typeof rec.uuid !== 'string' || !rec.uuid) return Promise.reject(new Error('putRejected needs a uuid'));
  return write('rejected', s => s.put(rec));
}
export const listRejected = () => read('rejected', s => s.getAll()).then(v => v || []);
export const getRejected = uuid => read('rejected', s => s.get(uuid));
export const deleteRejected = uuid => write('rejected', s => s.delete(uuid));

// ---- session ----
export function putSession(s) {
  return write('session', st => st.put({ ...s, id: SESSION_ID }));
}
export const getSession = () => read('session', s => s.get(SESSION_ID));
export const clearSession = () => write('session', s => s.delete(SESSION_ID));
