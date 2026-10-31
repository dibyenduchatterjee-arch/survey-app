// Browser tests for the admin console. fetch is a scripted stand-in: no server needed.
import { createApi } from '../console/js/api.js';
import { enter } from '../console/js/session.js';
import { mountForms } from '../console/js/forms.js';
import { mountSubmissions } from '../console/js/submissions.js';
import { mountHome } from '../console/js/home.js';
import { exportControl, safeDriveUrl, saveBlob } from '../console/js/exports.js';
import { mountAudit } from '../console/js/audit.js';

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(5); }
  throw new Error('timed out waiting for ' + what);
}

// routes: [[METHOD, /regex/, (match, init, url) => body | {status, body}]]. Records every call.
function stub(routes) {
  const calls = [];
  const authFetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, init });
    for (const [m, re, fn] of routes) {
      const match = re.exec(url);
      if (m === method && match) {
        let r = typeof fn === 'function' ? await fn(match, init, url) : fn;
        if (!(r && typeof r.status === 'number' && ('body' in r || 'blob' in r))) r = { status: 200, body: r };
        if (r.blob) return new Response(r.blob, { status: r.status, headers: r.headers || {} });
        return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ detail: 'no stub for ' + method + ' ' + url }), { status: 404 });
  };
  return { api: createApi(authFetch), calls };
}

const mount = () => { const el = document.createElement('div'); document.body.append(el); return el; };
const text = el => el.textContent;

const SPEC = {
  form_id: 'amb_asha_visit', version: '2026103101', title: { default: 'ASHA visit' }, languages: ['default', 'hi'], default_language: 'hi',
  choices: { yn: [{ value: 'yes' }, { value: 'no' }] },
  nodes: [
    { type: 'text', name: 'asha_name', label: { hi: 'आशा का नाम', default: 'ASHA name' }, required: true },
    { type: 'select_one', name: 'syrup_given', label: { hi: 'क्या आईएफए सिरप दिया?' }, choices_ref: 'yn' },
    { type: 'repeat', name: 'children', label: { hi: 'बच्चे' }, children: [{ type: 'integer', name: 'child_age', label: { hi: 'उम्र' } }] },
  ],
};

async function pickFile(input) {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'form.xlsx'));
  input.files = dt.files;
}

// ------------------------------------------------------------------ forms

export async function test_uploading_an_xlsform_shows_its_questions_before_publish() {
  const published = [];
  const { api } = stub([
    ['POST', /\/api\/forms$/, () => ({ status: 201, body: { form_id: 'amb_asha_visit', version: '2026103101', warnings: ['choice list unused: old'] } })],
    ['GET', /\/versions\/2026103101\/spec$/, () => SPEC],
    ['POST', /\/publish$/, (m, init) => { published.push(JSON.parse(init.body)); return { form_id: 'amb_asha_visit', version: '2026103101', is_current: true }; }],
  ]);
  const root = mount();
  await mountForms(root, { api });
  await pickFile(root.querySelector('input[type=file]'));
  root.querySelector('button.upload').click();
  await until(() => root.querySelector('table.questions'), 'question table');
  const t = text(root.querySelector('table.questions'));
  assert(t.includes('asha_name') && t.includes('syrup_given') && t.includes('child_age'), 'all questions, including those inside a repeat: ' + t);
  assert(t.includes('आशा का नाम'), 'Hindi label shown');
  assert(text(root).includes('choice list unused: old'), 'warnings shown');
  eq(published, [], 'nothing published before the supervisor clicks');
  root.querySelector('button.publish').click();
  await until(() => root.querySelector('.published'), 'published message');
  eq(published, [{ version: '2026103101' }]);
  root.remove();
}

export async function test_a_publish_error_shows_the_offending_question_name() {
  // 1. the server refuses at upload time, naming the question
  const { api } = stub([
    ['POST', /\/api\/forms$/, () => ({ status: 422, body: { detail: { error: 'unsupported_expression', question: 'visit_gap_days', message: 'uses a function we do not support' } } })],
  ]);
  const root = mount();
  await mountForms(root, { api });
  await pickFile(root.querySelector('input[type=file]'));
  root.querySelector('button.upload').click();
  const name = await until(() => root.querySelector('.question-name'), 'question name');
  eq(name.textContent, 'visit_gap_days');
  assert(text(root).includes('uses a function we do not support'), 'server message kept');
  root.remove();

  // 2. the server refuses at publish time: same treatment, and the button comes back
  const { api: api2 } = stub([
    ['POST', /\/api\/forms$/, { form_id: 'f', version: '2026103101', warnings: [] }],
    ['GET', /\/spec$/, SPEC],
    ['POST', /\/publish$/, () => ({ status: 422, body: { detail: { error: 'x', question: 'child_age', message: 'cannot publish' } } })],
  ]);
  const root2 = mount();
  await mountForms(root2, { api: api2 });
  await pickFile(root2.querySelector('input[type=file]'));
  root2.querySelector('button.upload').click();
  await until(() => root2.querySelector('button.publish'), 'publish button');
  root2.querySelector('button.publish').click();
  const n2 = await until(() => root2.querySelector('.form-error .question-name'), 'publish error question');
  eq(n2.textContent, 'child_age');
  assert(!root2.querySelector('button.publish').disabled, 'can retry after fixing');
  root2.remove();

  // 3. plain list of messages (invalid_xlsform) is shown line by line
  const { api: api3 } = stub([
    ['POST', /\/api\/forms$/, () => ({ status: 422, body: { detail: { error: 'invalid_xlsform', messages: ['row 4: duplicate name q1', 'row 9: missing type'] } } })],
  ]);
  const root3 = mount();
  await mountForms(root3, { api: api3 });
  await pickFile(root3.querySelector('input[type=file]'));
  root3.querySelector('button.upload').click();
  await until(() => root3.querySelector('.form-error li'), 'messages');
  assert(text(root3).includes('row 4: duplicate name q1') && text(root3).includes('row 9: missing type'));
  root3.remove();
}

// ------------------------------------------------------------------ submissions

const summary = (i, status = 'received') => ({
  uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, form_id: 'amb', version: '1', status,
  submitted_by: 2, received_at: '2026-10-30T10:00:00Z', failure_count: status === 'flagged' ? 1 : 0,
});

export async function test_the_submission_list_paginates_and_filters_by_status() {
  const all = Array.from({ length: 60 }, (_, i) => summary(i, i % 3 === 0 ? 'flagged' : 'received'));
  const { api, calls } = stub([
    ['GET', /\/api\/forms$/, [{ form_id: 'amb', title: 'AMB', current_version: '1' }]],
    ['GET', /\/api\/submissions\?/, (m, i, url) => {
      const q = new URL(url, 'http://x').searchParams;
      const rows = all.filter(s => !q.get('status') || s.status === q.get('status'));
      const size = Number(q.get('page_size')), page = Number(q.get('page'));
      return { items: rows.slice((page - 1) * size, page * size), total: rows.length, page, page_size: size };
    }],
  ]);
  const root = mount();
  await mountSubmissions(root, { api, params: new URLSearchParams('') });
  eq(root.querySelectorAll('tbody tr').length, 25, 'first page is full');
  assert(text(root.querySelector('.page-info')).includes('Page 1 of 3'), text(root.querySelector('.page-info')));
  assert(root.querySelector('button.prev').disabled, 'no previous on page 1');
  root.querySelector('button.next').click();
  await until(() => text(root.querySelector('.page-info')).includes('Page 2 of 3'), 'page 2');
  assert(calls.some(c => /page=2/.test(c.url)), 'page 2 requested from the server');
  const sel = root.querySelector('#status-filter');
  sel.value = 'flagged';
  sel.dispatchEvent(new Event('change'));
  await until(() => text(root.querySelector('.page-info')).includes('Page 1 of 1'), 'filtered to flagged, back at page 1');
  eq(root.querySelectorAll('tbody tr').length, 20);
  assert([...root.querySelectorAll('tbody .badge')].every(b => b.textContent === 'flagged'));
  assert(calls.some(c => /status=flagged/.test(c.url)), 'filter is applied by the server, not hidden client-side');
  root.remove();
}

const DETAIL = {
  ...summary(7, 'flagged'), failure_count: 3,
  data: { asha_name: 'सुनीता देवी', syrup_given: 'yes', evil: '<img src=x onerror="window.__pwned=1">' },
  repeats: { children: [{ child_age: '3' }, { child_age: '5' }] },
  failures: [
    { question: 'asha_name', rule: 'required', message: 'ASHA name is required' },
    { question: 'child_age', rule: 'constraint', message: 'Age must be under 6' },
    { question: 'visit_gap_days', rule: 'error', message: 'division by zero' },
  ],
  media: [{ question_name: 'house_photo', content_type: 'image/jpeg', size: 20480, sha256: 'ab' }],
  device_id: 'd1', started_at: null, finished_at: null, gps_lat: 25.6, gps_lon: 85.1, gps_accuracy: 8, likely_duplicates: [],
};
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

async function openDetail(media) {
  const routes = [
    ['GET', /\/api\/forms$/, []],
    ['GET', /\/api\/submissions\?/, { items: [summary(7, 'flagged')], total: 1, page: 1, page_size: 25 }],
    ['GET', /\/api\/submissions\/[0-9a-f-]+$/, DETAIL],
    ['GET', /\/media\/house_photo$/, media],
  ];
  const { api, calls } = stub(routes);
  const root = mount();
  await mountSubmissions(root, { api, params: new URLSearchParams('') });
  root.querySelector('button.open').click();
  await until(() => root.querySelector('table.answers'), 'detail');
  return { root, calls };
}

export async function test_opening_a_submission_shows_its_answers_and_photos() {
  const { root, calls } = await openDetail({ status: 200, blob: new Blob([PNG], { type: 'image/png' }) });
  const t = text(root.querySelector('.detail'));
  assert(t.includes('सुनीता देवी'), 'Hindi answer shown');
  assert(t.includes('child_age') && t.includes('Row 2'), 'repeat rows shown');
  assert(t.includes('<img src=x'), 'hostile answer is displayed as text');
  assert(!window.__pwned && !root.querySelector('.answers img'), 'and was not executed');
  const img = await until(() => root.querySelector('img.media-img'), 'photo');
  assert(img.src.startsWith('blob:'), 'photo comes from an authenticated fetch, shown as blob: ' + img.src);
  assert(calls.some(c => c.url === '/api/submissions/00000000-0000-4000-8000-000000000007/media/house_photo'), 'media path');
  root.remove();
}

export async function test_a_photo_the_server_cannot_serve_shows_a_placeholder() {
  const { root } = await openDetail({ status: 404, body: { detail: 'Not Found' } });
  const ph = await until(() => root.querySelector('.media-placeholder'), 'placeholder');
  assert(ph.textContent.includes('no media download endpoint'), ph.textContent);
  assert(!root.querySelector('img.media-img'));
  root.remove();
}

export async function test_flagged_submissions_show_their_validation_failures() {
  const { root } = await openDetail({ status: 404, body: {} });
  const by = rule => root.querySelector(`.failure[data-rule="${rule}"]`);
  assert(by('required') && by('constraint') && by('error'), 'one card per failure');
  assert(by('error').classList.contains('failure-form-broken'), 'error = the form is broken');
  assert(by('constraint').classList.contains('failure-data') && by('required').classList.contains('failure-data'), 'required/constraint = data problem');
  assert(by('error').textContent.includes('FORM PROBLEM') && by('error').textContent.includes('fix the XLSForm'), 'remedy differs: fix the form');
  assert(by('required').textContent.includes('MISSING ANSWER') && by('constraint').textContent.includes('ANSWER OUT OF RANGE'));
  assert(by('constraint').textContent.includes('Age must be under 6'), 'server message shown');
  assert(!by('required').textContent.includes('FORM PROBLEM'), 'a data problem is never labelled as the form being broken');
  eq(root.querySelector('.failure').dataset.rule, 'error', 'form problems listed first');
  root.remove();
}

// ------------------------------------------------------------------ exports

const doneJob = { job_id: 9, form_id: 'amb', status: 'done', drive_file_id: 'FILE1', row_count: 42, error: null };

export async function test_an_export_shows_progress_then_downloads_the_csv() {
  let polls = 0;
  const saved = [];
  const { api, calls } = stub([
    ['POST', /\/api\/exports$/, () => ({ status: 202, body: { job_id: 9 } })],
    ['GET', /\/api\/exports\/9$/, () => { polls++; return polls < 3 ? { ...doneJob, status: polls === 1 ? 'pending' : 'running' } : { ...doneJob, url: 'https://drive.google.com/file/d/FILE1/view' }; }],
    ['GET', /\/api\/exports\/9\/download$/, { status: 200, blob: new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="amb_2026-10-31.csv"' } }],
  ]);
  const el = exportControl('amb', { api, pollMs: 5, save: (blob, name) => saved.push({ blob, name }) });
  document.body.append(el);
  el.querySelector('button.download-csv').click();
  await until(() => /Waiting to start/.test(text(el.querySelector('.export-status'))), 'pending shown');
  assert(!el.querySelector('progress').hidden, 'progress bar visible while waiting');
  await until(() => /Building/.test(text(el.querySelector('.export-status'))), 'running shown');
  await until(() => el.querySelector('.saved-name'), 'download finished');
  eq(saved.length, 1);
  eq(saved[0].name, 'amb_2026-10-31.csv');
  eq(await saved[0].blob.text(), 'a,b\n1,2\n');
  assert(text(el).includes('42 submissions'), 'row count shown');
  assert(el.querySelector('progress').hidden, 'progress gone when done');
  const a = el.querySelector('a.drive-link');
  eq(a.href, 'https://drive.google.com/file/d/FILE1/view');
  assert(text(el).includes('Also saved to Drive'), 'Drive link is secondary');
  const dl = calls.findIndex(c => /download$/.test(c.url));
  assert(dl > calls.findIndex(c => /exports\/9$/.test(c.url)), 'file requested only after the job reported done');
  el.remove();
}

export async function test_saveblob_triggers_a_download_and_revokes_the_object_url() {
  const origCreate = URL.createObjectURL, origRevoke = URL.revokeObjectURL;
  const revoked = []; let clicked = null;
  URL.createObjectURL = () => 'blob:test-1';
  URL.revokeObjectURL = u => revoked.push(u);
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { clicked = { href: this.href, download: this.download }; };
  try {
    saveBlob(new Blob(['x']), 'f.csv');
    eq(clicked, { href: 'blob:test-1', download: 'f.csv' });
    await sleep(1200);
    eq(revoked, ['blob:test-1']);
  } finally { URL.createObjectURL = origCreate; URL.revokeObjectURL = origRevoke; HTMLAnchorElement.prototype.click = origClick; }
}

export async function test_a_failed_export_shows_the_servers_error_text() {
  const { api } = stub([
    ['POST', /\/api\/exports$/, { status: 202, body: { job_id: 3 } }],
    ['GET', /\/api\/exports\/3$/, { ...doneJob, job_id: 3, status: 'failed', drive_file_id: null, error: 'GoogleError: Drive quota exceeded for folder 1AbC' }],
  ]);
  const el = exportControl('amb', { api, pollMs: 5 });
  document.body.append(el);
  el.querySelector('button.download-csv').click();
  const err = await until(() => el.querySelector('.export-error'), 'error');
  assert(err.textContent.includes('Drive quota exceeded for folder 1AbC'), err.textContent);
  assert(!el.querySelector('a'), 'no link on failure');
  assert(el.querySelector('progress').hidden);
  assert(!el.querySelector('button').disabled, 'can try again');
  el.remove();

  // the job is done but the file request is refused: the server's words still show
  const { api: api3 } = stub([
    ['POST', /\/api\/exports$/, { status: 202, body: { job_id: 9 } }],
    ['GET', /\/api\/exports\/9$/, doneJob],
    ['GET', /\/download$/, { status: 409, body: { detail: 'Export file is no longer available' } }],
  ]);
  const el3 = exportControl('amb', { api: api3, pollMs: 5, save: () => { throw new Error('must not save'); } });
  document.body.append(el3);
  el3.querySelector('button.download-csv').click();
  const e3 = await until(() => el3.querySelector('.export-error'), 'download error');
  assert(e3.textContent.includes('no longer available'), e3.textContent);
  el3.remove();

  // a 503 when starting (missing configuration) carries its words too
  const { api: api2 } = stub([['POST', /\/api\/exports$/, { status: 503, body: { detail: 'DRIVE_FOLDER_ID is not set: exports need a Drive folder' } }]]);
  const el2 = exportControl('amb', { api: api2, pollMs: 5 });
  document.body.append(el2);
  el2.querySelector('button.download-csv').click();
  const e2 = await until(() => el2.querySelector('.export-error'), 'start error');
  assert(e2.textContent.includes('DRIVE_FOLDER_ID is not set'));
  el2.remove();
}

export async function test_the_download_needs_a_session_and_only_opens_drive_links() {
  // signed out: authFetch answers 401 and the control says so; no link appears
  const { api } = stub([['POST', /\/api\/exports$/, { status: 401, body: { detail: 'Not authenticated' } }]]);
  const el = exportControl('amb', { api, pollMs: 5 });
  document.body.append(el);
  el.querySelector('button.download-csv').click();
  const err = await until(() => el.querySelector('.export-error'), 'error');
  assert(err.textContent.includes('signed out'), err.textContent);
  el.remove();
  // a link that is not Drive over https is never made clickable
  eq(safeDriveUrl('https://drive.google.com/file/d/X/view'), 'https://drive.google.com/file/d/X/view');
  eq(safeDriveUrl('http://drive.google.com/file/d/X/view'), null);
  eq(safeDriveUrl('https://drive.google.com.evil.example/x'), null);
  eq(safeDriveUrl('javascript:alert(1)'), null);
  eq(safeDriveUrl(undefined), null);
  const { api: api2 } = stub([
    ['POST', /\/api\/exports$/, { status: 202, body: { job_id: 9 } }],
    ['GET', /\/api\/exports\/9$/, { ...doneJob, url: 'https://evil.example/steal' }],
    ['GET', /\/download$/, { status: 200, blob: new Blob(['x']), headers: { 'Content-Disposition': 'attachment; filename="x.csv"' } }],
  ]);
  const el2 = exportControl('amb', { api: api2, pollMs: 5, save: () => {} });
  document.body.append(el2);
  el2.querySelector('button.download-csv').click();
  await until(() => el2.querySelector('.export-result .msg'), 'result');
  assert(!el2.querySelector('a'), 'no anchor for a non-Drive url');
  el2.remove();
}

// ------------------------------------------------------------------ projects, access

export async function test_the_project_list_shows_version_and_submission_count_for_every_form() {
  const forms = Array.from({ length: 12 }, (_, i) => ({ form_id: `proj_${i}`, title: `प्रोजेक्ट ${i}`, current_version: `20261031${String(i).padStart(2, '0')}` }));
  const { api } = stub([
    ['GET', /\/api\/forms$/, forms],
    ['GET', /\/api\/submissions\?/, (m, i, url) => ({ items: [], total: 100 + Number(/proj_(\d+)/.exec(url)[1]), page: 1, page_size: 1 })],
  ]);
  const root = mount();
  await mountHome(root, { api });
  eq(root.querySelectorAll('.project').length, 12);
  await until(() => [...root.querySelectorAll('.count')].every(c => /^\d+$/.test(c.textContent)), 'counts');
  const p5 = root.querySelector('[data-form="proj_5"]');
  assert(p5.querySelector('.version').textContent === '2026103105' && p5.querySelector('.count').textContent === '105');
  assert(root.querySelectorAll('button.download-csv').length === 12, 'a Download CSV control on every row');
  const f = root.querySelector('#project-filter');
  f.value = 'proj_1';
  f.dispatchEvent(new Event('input'));
  eq([...root.querySelectorAll('.project')].filter(p => !p.hidden).length, 3, 'proj_1, proj_10, proj_11');
  root.remove();
}

const fakeStore = session => ({ getSession: async () => session });

export async function test_an_enumerator_opening_the_console_is_sent_away() {
  const root = mount();
  let went = null;
  const user = await enter(root, {
    store: fakeStore({ access_token: 't', refresh_token: 'r', user: { id: 5, username: 'sita', role: 'enumerator' } }),
    navigate: u => { went = u; },
  });
  eq(user, null);
  eq(went, '../', 'sent back to the survey app');
  assert(!root.querySelector('table, .projects, form'), 'no console content rendered');
  root.remove();

  // staff get in, no redirect
  const root2 = mount();
  went = null;
  const u2 = await enter(root2, { store: fakeStore({ access_token: 't', refresh_token: 'r', user: { id: 1, username: 'm', role: 'supervisor' } }), navigate: u => { went = u; } });
  eq(u2.role, 'supervisor');
  eq(went, null);
  root2.remove();

  // nobody signed in: a login form, not a redirect and not content
  const root3 = mount();
  went = null;
  const u3 = await enter(root3, { store: fakeStore(undefined), navigate: u => { went = u; } });
  eq(u3, null);
  assert(root3.querySelector('input[type=password]'), 'login form shown');
  eq(went, null);
  root3.remove();
}

export async function test_the_audit_page_lists_entries_read_only() {
  const { api, calls } = stub([
    ['GET', /\/api\/audit/, { items: [{ id: 2, at: '2026-10-31T05:00:00Z', actor_user_id: 1, action: 'user.update', object_type: 'user', object_id: 7, detail: { is_active: false } }], total: 1, limit: 50, offset: 0 }],
  ]);
  const root = mount();
  await mountAudit(root, { api });
  assert(text(root).includes('user.update') && text(root).includes('is_active'), 'entry shown: ' + text(root));
  assert(calls.every(c => c.method === 'GET'), 'audit page only reads');
  root.remove();
}

export async function test_the_audit_page_filters_by_actor_and_action() {
  const { api, calls } = stub([['GET', /\/api\/audit/, { items: [], total: 0, limit: 50, offset: 0 }]]);
  const root = mount();
  await mountAudit(root, { api });
  root.querySelector('input[name=actor_id]').value = '7';
  root.querySelector('input[name=action]').value = 'user.update';
  root.querySelector('form.filters').dispatchEvent(new Event('submit', { cancelable: true }));
  await until(() => calls.length >= 2, 'filtered request');
  const u = calls[calls.length - 1].url;
  assert(u.includes('actor_id=7') && u.includes('action=user.update'), u);
  root.remove();
}
