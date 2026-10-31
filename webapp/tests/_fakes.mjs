// Shared fakes for the Apps Script client tests. No network is ever touched.
//
// memStore: db.js's exact interface, in memory.
// fakeBackend: the Apps Script API as task-40-report describes it (open / forms / submit), with
// one `fetchImpl` the client is given. It can be told to fail at a named action.

import { rekeySpec, rekeyRecord, rekeyRejected, rekeySession } from '../js/projectkey.js';

export function memStore() {
  const forms = new Map();
  const rejected = new Map();
  const media = new Map();
  const session = new Map();
  const drafts = new Map();
  let queue = [];
  let seq = 0;
  return {
    forms, rejected, session, drafts,
    get queue() { return queue; },
    async putForm(spec) { forms.set(`${spec.form_id}|${spec.version}`, structuredClone(spec)); },
    async getForm(id, v) { return forms.get(`${id}|${v}`); },
    async listForms() { return [...forms.values()]; },
    async putRejected(rec) { rejected.set(rec.uuid, rec); },
    async listRejected() { return [...rejected.values()]; },
    async getRejected(uuid) { return rejected.get(uuid); },
    async deleteRejected(uuid) { rejected.delete(uuid); },
    async enqueue(sub, blobs) {
      queue = queue.filter(q => q.uuid !== sub.uuid);
      queue.push({ ...sub, queued_at: ++seq });
      media.set(sub.uuid, Object.entries(blobs || {}).map(([question, blob]) => ({ uuid: sub.uuid, question, blob })));
    },
    async peekQueue(n = 1) { return queue.slice(0, n); },
    async dequeue(uuid) { queue = queue.filter(q => q.uuid !== uuid); media.delete(uuid); },
    async queueLength() { return queue.length; },
    async getMedia(uuid) { return media.get(uuid) || []; },
    async saveDraft(d) { drafts.set(d.id, structuredClone(d)); },
    async listDrafts() { return [...drafts.values()].map(d => structuredClone(d)); },
    // The same rule db.js applies in one IndexedDB transaction (see projectkey.js).
    async migrateProjectKey(oldKey, newKey, name) {
      for (const [k, spec] of [...forms]) { const n = rekeySpec(spec, oldKey, newKey, name); if (n) { forms.delete(k); forms.set(`${n.form_id}|${n.version}`, n); } }
      for (const [k, d] of [...drafts]) { const n = rekeyRecord(d, oldKey, newKey); if (n) drafts.set(k, n); }
      queue = queue.map(q => rekeyRecord(q, oldKey, newKey) || q);
      for (const [k, r] of [...rejected]) { const n = rekeyRejected(r, oldKey, newKey); if (n) rejected.set(k, n); }
      const out = rekeySession({ legacy: session.get('project:' + oldKey), current: session.get('project:' + newKey), active: session.get('active') }, oldKey, newKey, name);
      session.delete('project:' + oldKey);
      if (out.project) session.set(out.project.id, structuredClone(out.project));
      if (out.active) session.set('active', out.active);
    },
    async putSessionRecord(rec) { session.set(rec.id, structuredClone(rec)); },
    async getSessionRecord(id) { return session.has(id) ? structuredClone(session.get(id)) : undefined; },
    async deleteSessionRecord(id) { session.delete(id); },
    async listProjectSessions() { return [...session.values()].filter(r => r.id.startsWith('project:')).map(r => structuredClone(r)); },
  };
}

export const URL_ = 'https://script.google.com/macros/s/TEST/exec';

const reply = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
const html = () => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html><html><body>Service invoked too many times</body></html>' });

// projects: { 'GAYA2026': { name: 'Bihar AMB', id: 'optional', forms: [spec...], active: true } }
// Each project has a stable `id` (default 'id-<name>'), which is what the real script sends as project_id.
// Sheets and seen-uuid sets are kept per id, so two projects with the same NAME stay separate.
export function fakeBackend(projects) {
  const b = {
    projects,
    calls: [],           // every request body, in order
    sheets: new Map(),   // project id -> Map(tab -> rows[])
    seen: new Map(),     // project id -> Set(uuid)
    tokens: new Map(),   // token -> project id
    ttlMs: 6 * 3600_000,
    now: () => Date.now(),
    fail: {},            // action -> fn(count, body) returning a reply object, 'html', 'throw' or undefined
    counts: {},
    n: 0,
  };
  const find = (code) => Object.entries(b.projects).find(([c, p]) => c.toLowerCase() === String(code).trim().toLowerCase() && p.active !== false);
  const idOf = (p) => p.id || 'id-' + p.name;
  // `project` is an id, or (for readability in tests) a name when that name is unique.
  const resolve = (project) => Object.values(b.projects).map(idOf).find(i => i === project) || idOf(Object.values(b.projects).find(p => p.name === project) || {});
  b.rows = (project, tab) => { const m = b.sheets.get(resolve(project)); return (m && m.get(tab)) || []; };
  b.fetchImpl = async (url, init) => {
    if (url !== URL_) throw new Error('unexpected url ' + url);
    if (init.method !== 'POST') throw new Error('must POST');
    if (!/^text\/plain/.test(init.headers['Content-Type'])) throw new Error('must be text/plain (no preflight)');
    const body = JSON.parse(init.body);
    b.calls.push(body);
    b.counts[body.action] = (b.counts[body.action] || 0) + 1;
    const f = b.fail[body.action];
    if (f) {
      const r = f(b.counts[body.action], body);
      if (r === 'throw') throw new TypeError('network down');
      if (r === 'html') return html();
      if (r) return reply(r);
    }
    if (body.action === 'open') {
      const hit = find(body.code);
      if (!hit) return reply({ ok: false, error: 'refused', message: 'That code is not valid.', retry: false });
      const token = 'tok' + (++b.n);
      b.tokens.set(token, idOf(hit[1]));
      return reply({ ok: true, project: hit[1].name, project_id: idOf(hit[1]), person: hit[1].person || 'Sita', token, expires_at: new Date(b.now() + b.ttlMs).toISOString(), ttl_s: b.ttlMs / 1000 });
    }
    const name = b.tokens.get(body.token);   // the project id
    const proj = Object.values(b.projects).find(p => idOf(p) === name);
    if (!name || !proj || proj.active === false) return reply({ ok: false, error: 'session', retry: false });
    if (body.action === 'forms') return reply({ ok: true, project: proj.name, project_id: name, forms: structuredClone(proj.forms || []), skipped: proj.skipped || [] });
    if (body.action === 'submit') {
      const seen = b.seen.get(name) || b.seen.set(name, new Set()).get(name);
      if (seen.has(body.uuid)) return reply({ ok: true, status: 'duplicate', uuid: body.uuid });
      if (!b.sheets.has(name)) b.sheets.set(name, new Map());
      const sheet = b.sheets.get(name);
      for (const tab of body.tabs) {
        if (!sheet.has(tab.name)) sheet.set(tab.name, []);
        // like the real script: the person's name is stamped from the token, never taken from the phone
        sheet.get(tab.name).push(...structuredClone(tab.rows).map(r => (tab.kind === 'main' ? { ...r, _submitted_by: proj.person || 'Sita' } : r)));
      }
      seen.add(body.uuid);
      return reply({ ok: true, status: 'created', uuid: body.uuid, received_at: new Date().toISOString(), appended: {} });
    }
    return reply({ ok: false, error: 'bad_request', retry: false });
  };
  return b;
}

export const FORM_A = {
  form_id: 'visit', version: '2026103101', title: { hi: 'घर का दौरा', en: 'Home visit' },
  nodes: [
    { type: 'text', name: 'asha_name' },
    { type: 'group', name: 'g', children: [{ type: 'integer', name: 'household_children' }] },
    { type: 'image', name: 'household_photo' },
    { type: 'note', name: 'n1' },
    { type: 'repeat', name: 'children', children: [
      { type: 'text', name: 'child_name' },
      { type: 'repeat', name: 'doses', children: [{ type: 'integer', name: 'dose_ml' }] },
    ] },
  ],
};
export const FORM_B = { form_id: 'visit', version: '2026103101', title: { en: 'School visit' }, nodes: [{ type: 'text', name: 'school_name' }] };

export const sub = (uuid, formId = 'id-Bihar AMB::visit', extra = {}) => ({
  uuid, form_id: formId, version: '2026103101', user_id: 'dev-1', person: 'Sita',
  data: { asha_name: 'सीता', household_children: 2 }, repeats: {},
  device_id: 'dev-1', started_at: '2026-10-31T09:00:00Z', finished_at: '2026-10-31T09:05:00Z',
  gps_lat: 25.5, gps_lon: 85.1, ...extra,
});
export const photo = (t = 'JPEG') => new Blob([t], { type: 'image/jpeg' });

export const noSleep = () => { const s = async ms => { s.waits.push(ms); }; s.waits = []; return s; };
