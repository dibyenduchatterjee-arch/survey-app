'use strict';
// Loads Code.gs and Backend.gs into ONE context, the way Apps Script shares globals between files.
// Nothing here touches Google: dispatch() takes its Sheets, Drive, clock and lock as plain
// functions, and the fakes below keep everything in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ctx = vm.createContext({ console });
for (const f of ['Code.gs', 'Backend.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
}
const L = ctx;
const plain = x => JSON.parse(JSON.stringify(x));
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (s, k) => crypto.createHmac('sha256', k).update(s, 'utf8').digest('hex');

const PROJ_HEADER = ['Project name', 'Drive folder id', 'Data spreadsheet id'];
const PEOPLE_HEADER = ['Person name', 'Access code', 'Project', 'Active'];
const tagOf = n => hmac(n, 'lookup-key').slice(0, 16);
const stored = (code, salt, noTag) => L.makeStoredCode(code, salt || 'saltsalt01', sha, 5, noTag ? '' : tagOf(code.trim().toUpperCase()));
const SPEC_A = { form_id: 'amb_visit', version: 3, nodes: [] };
const SPEC_B = { form_id: 'school_visit', version: 1, nodes: [] };

function makeWorld(over) {
  const w = Object.assign({
    projects: [PROJ_HEADER,
      ['Bihar AMB', 'folderA', 'ssA'],
      ['Odisha Schools', 'folderB', 'ssB']],
    people: [PEOPLE_HEADER,
      ['Sunita Devi', stored('AMB12345', 'saltAAAA01'), 'Bihar AMB', 'yes'],
      ['Ravi Kumar', stored('RAVI55555', 'saltRRRR01'), 'bihar amb', 'yes'],
      ['Mohan Das', stored('ODI67890', 'saltBBBB01'), 'Odisha Schools', 'yes'],
      ['Old Pilot', stored('PILOT999', 'saltCCCC01'), 'Bihar AMB', 'no']],
    sheets: {}, photos: [], fails: [], now: Date.UTC(2026, 9, 31, 10, 0, 0), busy: false, boom: false,
    specs: {
      folderA: [{ name: 'amb_visit.spec.json', text: JSON.stringify(SPEC_A) }, { name: 'notes.txt', text: 'x' }],
      folderB: [{ name: 'school_visit.spec.json', text: JSON.stringify(SPEC_B) }]
    }
  }, over || {});
  w.deps = {
    now: () => w.now,
    readProjectsValues: () => w.projects,
    readPeopleValues: () => w.people,
    tagOf,
    sha256hex: sha, hmacHex: hmac, secret: 'unit-test-secret',
    listSpecFiles: p => w.specs[p.folderId] || [],
    readTab: (p, name, n) => {
      const t = (w.sheets[p.spreadsheetId] || {})[name];
      return t ? { headers: t.headers.slice(), keyRows: t.rows.map(r => r.slice(0, n)) } : null;
    },
    writeTab: (p, name, plan0) => {
      const plan = plain(plan0);
      if (w.boom) throw new Error('secret internal detail: DriveApp exploded');
      const ss = (w.sheets[p.spreadsheetId] = w.sheets[p.spreadsheetId] || {});
      const t = (ss[name] = ss[name] || { headers: [], rows: [] });
      t.headers = plan.headers.slice();
      t.rows.forEach(r => { while (r.length < t.headers.length) r.push(''); });
      plan.rows.forEach(r => t.rows.push(r.slice()));
    },
    savePhoto: (p, name, mime) => { w.photos.push({ project: p.name, name, mime }); return 'https://drive.example/' + name; },
    withLock: fn => { if (w.busy) { const e = new Error('lock'); e.busy = true; throw e; } return fn(); },
    getFailures: () => w.fails.slice(),
    addFailure: t => w.fails.push(t)
  };
  w.call = body => plain(L.dispatch(body, w.deps));
  w.open = code => w.call({ action: 'open', code });
  return w;
}
const mainTab = (uuid, data, extra) => ({
  name: 'amb_visit', kind: 'main', key: ['uuid'],
  rows: [Object.assign({ uuid }, data || { district: 'Gaya', child: 'Asha' }, extra || {})]
});
const sub = (token, uuid, tabs, more) => Object.assign({ action: 'submit', token, uuid, tabs: tabs || [mainTab(uuid)] }, more || {});
const UUID1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const UUID2 = '22222222-aaaa-4bbb-8ccc-000000000002';

// ---- the code is a hash, never plain text ------------------------------------------------

test('stored code does not contain the code, and verifies only the right one (case-insensitive)', () => {
  const s = stored('Amb12345');
  assert.ok(!s.toLowerCase().includes('amb12345'));
  assert.match(s, /^sha256\$\d+\$[A-Za-z0-9]+\$[0-9a-f]{64}(\$[0-9a-f]{16})?$/);
  assert.equal(L.verifyCode('AMB12345', s, sha), true);
  assert.equal(L.verifyCode('  amb12345 ', s, sha), true);
  assert.equal(L.verifyCode('AMB12346', s, sha), false);
  assert.equal(L.verifyCode('', s, sha), false);
});

test('a plain-text cell never verifies, even when typed code equals the cell', () => {
  assert.equal(L.verifyCode('AMB12345', 'AMB12345', sha), false);
  assert.equal(L.isStoredCode('AMB12345'), false);
  assert.equal(L.isStoredCode(stored('X1')), true);
});

test('same code with a different salt gives a different stored value', () => {
  assert.notEqual(stored('AMB12345', 'saltone001'), stored('AMB12345', 'salttwo002'));
});

test('generateCode: right length, unambiguous alphabet, rejects biased bytes', () => {
  const bytes = []; for (let i = 0; i < 64; i++) bytes.push((i * 37 + 11) % 256);
  const c = L.generateCode(bytes, 8);
  assert.equal(c.length, 8);
  assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.throws(() => L.generateCode([1, 2, 3], 8));
  assert.equal(L.generateCode([255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0], 8), 'AAAAAAAA'); // 255 is skipped
});

// ---- open ---------------------------------------------------------------------------------

test('wrong code, unknown code, blank code and inactive person are refused identically', () => {
  const w = makeWorld();
  const wrong = w.open('NOPE0000');
  assert.equal(wrong.ok, false);
  assert.deepEqual(w.open('PILOT999'), wrong);        // valid code, person switched off
  w.people.push(['Ghost', stored('GHOST123', 'saltGGGG01'), 'No Such Project', 'yes']);
  assert.deepEqual(w.open('GHOST123'), wrong);        // valid code, project not on the Projects tab
  assert.deepEqual(w.open(''), wrong);
  assert.deepEqual(w.open(undefined), wrong);
  assert.deepEqual(w.open('amb1234'), wrong);          // near miss
  assert.equal(wrong.error, 'refused');
  assert.ok(!('project' in wrong) && !('token' in wrong));
});

test('a valid code opens its own project only; case of the typed code does not matter', () => {
  const w = makeWorld();
  const a = w.open('amb12345');
  assert.equal(a.ok, true);
  assert.equal(a.project, 'Bihar AMB');
  assert.equal(a.person, 'Sunita Devi');
  assert.ok(a.token && a.expires_at);
  assert.ok(!JSON.stringify(a).includes('folderA') && !JSON.stringify(a).includes('ssA'), 'no Drive ids leak');
  const b = w.open('ODI67890');
  assert.equal(b.project, 'Odisha Schools');
  assert.equal(b.person, 'Mohan Das');
  assert.notEqual(a.token, b.token);
  assert.equal(w.open('ravi55555').person, 'Ravi Kumar');   // another person, same project, own code
});

test('forms: a token returns only its own project specs', () => {
  const w = makeWorld();
  const fa = w.call({ action: 'forms', token: w.open('AMB12345').token });
  assert.equal(fa.ok, true);
  assert.deepEqual(fa.forms.map(f => f.form_id), ['amb_visit']);
  const fb = w.call({ action: 'forms', token: w.open('ODI67890').token });
  assert.deepEqual(fb.forms.map(f => f.form_id), ['school_visit']);
});

test('setting a person to Active no, or changing their code, ends their session at once', () => {
  const w = makeWorld();
  const tok = w.open('AMB12345').token;
  assert.equal(w.call({ action: 'forms', token: tok }).ok, true);
  w.people[1][3] = 'No';
  const r = w.call({ action: 'forms', token: tok });
  assert.equal(r.ok, false); assert.equal(r.error, 'session');
  w.people[1][3] = 'yes';
  assert.equal(w.call({ action: 'forms', token: tok }).ok, true);
  w.people[1][1] = stored('NEWCODE77', 'saltAAAA02');
  assert.equal(w.call({ action: 'forms', token: tok }).error, 'session');
  assert.equal(w.open('AMB12345').ok, false);
  assert.equal(w.open('NEWCODE77').ok, true);
});

test('expired, tampered, missing and foreign tokens are all "session"', () => {
  const w = makeWorld();
  const tok = w.open('AMB12345').token;
  w.now += 7 * 3600 * 1000;
  assert.equal(w.call({ action: 'forms', token: tok }).error, 'session');
  w.now -= 7 * 3600 * 1000;
  const parts = tok.split('.');
  assert.equal(w.call({ action: 'forms', token: parts.slice(0, 3).join('.') + '.' + 'f'.repeat(parts[3].length) }).error, 'session');
  assert.equal(w.call({ action: 'forms' }).error, 'session');
  assert.equal(w.call({ action: 'forms', token: 'a.b.c.d' }).error, 'session');
  // a token for project A with the project id swapped for B's is not B's
  const tokB = w.open('ODI67890').token.split('.');
  assert.equal(w.call({ action: 'forms', token: [tokB[0], parts[1], parts[2], parts[3]].join('.') }).error, 'session');
  // signed with a different secret
  const other = makeWorld(); other.deps.secret = 'different';
  assert.equal(other.call({ action: 'forms', token: tok }).error, 'session');
});

test('too many wrong codes pause opening, even for the right code, and tell the phone to retry', () => {
  const w = makeWorld();
  for (let i = 0; i < 40; i++) w.open('WRONG' + i);
  const r = w.open('AMB12345');
  assert.equal(r.ok, false); assert.equal(r.error, 'too_many_attempts'); assert.equal(r.retry, true);
  w.now += 11 * 60 * 1000;
  assert.equal(w.open('AMB12345').ok, true);
});

test('an open session keeps working while opening is paused', () => {
  const w = makeWorld();
  const tok = w.open('AMB12345').token;
  for (let i = 0; i < 40; i++) w.open('WRONG' + i);
  assert.equal(w.call({ action: 'forms', token: tok }).ok, true);
});

// ---- projects sheet -----------------------------------------------------------------------

test('removing one person ends only that person, the rest of the project carries on', () => {
  const w = makeWorld();
  const sunita = w.open('AMB12345').token, ravi = w.open('RAVI55555').token;
  w.people[1][3] = 'no';
  assert.equal(w.call({ action: 'forms', token: sunita }).error, 'session');
  assert.equal(w.call({ action: 'forms', token: ravi }).ok, true);
});

test('a code shared by two active people is refused: it cannot say who is collecting', () => {
  const w = makeWorld();
  w.people.push(['Copycat', stored('AMB12345', 'saltDDDD01'), 'Bihar AMB', 'yes']);
  assert.equal(w.open('AMB12345').error, 'refused');
});

test('people with an old hash that has no lookup tag still sign in; a sign-in hashes few rows', () => {
  const w = makeWorld();
  w.people[1][1] = stored('AMB12345', 'saltAAAA01', true);
  assert.equal(w.open('AMB12345').ok, true);
  const big = makeWorld();
  for (let i = 0; i < 76; i++) big.people.push(['P' + i, stored('CODE' + (100000 + i), 'saltP' + String(i).padStart(5, '0')), 'Bihar AMB', 'yes']);
  let calls = 0;
  big.deps.sha256hex = x => { calls++; return sha(x); };
  assert.equal(big.open('CODE100010').person, 'P10');
  assert.ok(calls < 1500, 'digest calls ' + calls);   // untagged would be about 25,000
});

test('submitted_by comes from the code: the phone cannot claim another name', () => {
  const w = makeWorld();
  const r = w.call(sub(w.open('RAVI55555').token, UUID1, [mainTab(UUID1, { district: 'Gaya', _submitted_by: 'Someone Else' })]));
  assert.equal(r.ok, true);
  const t = w.sheets.ssA.amb_visit;
  assert.equal(t.rows[0][t.headers.indexOf('_submitted_by')], 'Ravi Kumar');
  assert.equal(t.headers.filter(h => h === '_submitted_by').length, 1);
});

test('submitted_by fills the existing column when the sheet already has one', () => {
  const w = makeWorld();
  w.sheets.ssA = { amb_visit: { headers: ['uuid', 'district', '_submitted_by'], rows: [] } };
  w.call(sub(w.open('AMB12345').token, UUID1, [mainTab(UUID1, { district: 'Gaya' })]));
  const t = w.sheets.ssA.amb_visit;
  assert.deepEqual(t.headers.slice(0, 3), ['uuid', 'district', '_submitted_by']);
  assert.equal(t.rows[0][2], 'Sunita Devi');
});

test('parseProjects and parsePeople: columns found by name in any order, Active read strictly', () => {
  const pr = plain(L.parseProjects([['Data spreadsheet id', 'project name', 'Drive folder id'], ['s1', 'P1', 'f1'], ['', '', ''], ['s2', 'P2', '']]));
  assert.deepEqual(pr.map(p => [p.name, p.folderId, p.spreadsheetId, p.usable]), [['P1', 'f1', 's1', true], ['P2', '', 's2', false]]);
  assert.equal(pr[1].rowNumber, 4);
  const pe = plain(L.parsePeople([['active', 'Project', 'Access code', 'Person name'],
    ['YES', 'P1', stored('A1'), 'A'], ['y', 'P1', stored('A2'), 'B'], ['maybe', 'P1', stored('A3'), 'C'], ['', 'P1', stored('A4'), 'D']]));
  assert.deepEqual(pe.map(p => [p.name, p.active, p.projectName]), [['A', true, 'P1'], ['B', true, 'P1'], ['C', false, 'P1'], ['D', false, 'P1']]);
});

test('a project with a missing folder or spreadsheet id, or a duplicated name, cannot be opened', () => {
  const w = makeWorld();
  w.projects[1][2] = '';
  assert.equal(w.open('AMB12345').error, 'refused');
  w.projects[1][2] = 'ssA';
  assert.equal(w.open('AMB12345').ok, true);
  w.projects.push(['bihar amb', 'folderX', 'ssX']);
  assert.equal(w.open('AMB12345').error, 'refused');
});

test('a missing Projects or People tab (no rows) refuses everyone', () => {
  assert.equal(makeWorld({ projects: [] }).open('AMB12345').error, 'refused');
  assert.equal(makeWorld({ people: [] }).open('AMB12345').error, 'refused');
});

test('projectProblems flags plain-text codes, missing codes, unknown or duplicate projects', () => {
  const projects = L.parseProjects([PROJ_HEADER, ['P1', 'f', 's'], ['P1', 'f', 's'], ['P2', '', 's'], ['P3', 'f', 's']]);
  const people = L.parsePeople([PEOPLE_HEADER,
    ['Plain', 'letmein', 'P3', 'yes'], ['NoCode', '', 'P3', 'yes'], ['Lost', stored('Z'), 'Nowhere', 'yes'], ['Fine', stored('Z'), 'P3', 'yes'], ['Off', 'letmein', 'P3', 'no']]);
  const msgs = L.projectProblems(projects, people).join('\n');
  assert.match(msgs, /Projects row 4/); assert.match(msgs, /appears 2 times/);
  assert.match(msgs, /People row 2 \(Plain\).*plain text/); assert.match(msgs, /People row 3 \(NoCode\).*no access code/);
  assert.match(msgs, /People row 4 \(Lost\).*Nowhere/);
  assert.doesNotMatch(msgs, /Fine/);
});

test('setup rows: right headings, example rows inactive and without a usable code', () => {
  assert.deepEqual(plain(L.PROJECT_HEADERS), PROJ_HEADER);
  assert.deepEqual(plain(L.PEOPLE_HEADERS), PEOPLE_HEADER);
  assert.equal(plain(L.exampleProjectRow()).length, 3);
  const ex = plain(L.examplePersonRow());
  assert.equal(ex.length, 4);
  assert.equal(String(ex[3]).toLowerCase(), 'no');
  assert.equal(L.isStoredCode(ex[1]), false);
});

// ---- the download page: only the owner -----------------------------------------------------

test('downloadPageAllowed: owner and listed emails yes; anonymous, strangers no', () => {
  assert.equal(L.downloadPageAllowed('me@org.in', 'me@org.in', ''), true);
  assert.equal(L.downloadPageAllowed('ME@org.in', 'me@org.in', ''), true);
  assert.equal(L.downloadPageAllowed('colleague@org.in', 'me@org.in', 'a@org.in, colleague@org.in'), true);
  assert.equal(L.downloadPageAllowed('', 'me@org.in', ''), false);
  assert.equal(L.downloadPageAllowed('x@org.in', 'me@org.in', ''), false);
  assert.equal(L.downloadPageAllowed('', '', ''), false);
});

// ---- spec files -----------------------------------------------------------------------------

test('parseSpecFiles: only *.spec.json, bad JSON is skipped and named', () => {
  const r = L.parseSpecFiles([
    { name: 'a.spec.json', text: '{"form_id":"a","version":1}' },
    { name: 'b.spec.json', text: '{oops' },
    { name: 'c.json', text: '{"form_id":"c"}' },
    { name: 'd.spec.json', text: '[1,2]' }
  ]);
  assert.deepEqual(plain(r.forms), [{ form_id: 'a', version: 1 }]);
  assert.deepEqual(plain(r.skipped), ['b.spec.json', 'd.spec.json']);
});

// ---- submit ---------------------------------------------------------------------------------

function tokenA(w) { return w.open('AMB12345').token; }

test('submit appends one row, uuid first, script-stamped received columns at the end', () => {
  const w = makeWorld();
  const r = w.call(sub(tokenA(w), UUID1));
  assert.equal(r.ok, true); assert.equal(r.status, 'created');
  const t = w.sheets.ssA.amb_visit;
  assert.deepEqual(t.headers, ['uuid', 'district', 'child', '_received_at', '_received_date_ist', '_submitted_by']);
  assert.deepEqual(t.rows[0], [UUID1, 'Gaya', 'Asha', '2026-10-31T10:00:00.000Z', '2026-10-31', 'Sunita Devi']);
  assert.equal(w.sheets.ssB, undefined, 'project B untouched');
});

test('received timestamp is the script clock, never the payload; India date follows IST', () => {
  const w = makeWorld({ now: Date.UTC(2026, 9, 31, 22, 30, 0) });   // 04:00 on 1 Nov in India
  const tab = mainTab(UUID1, { district: 'Gaya', _received_at: '1999-01-01T00:00:00Z', _received_date_ist: '1999-01-01' });
  const r = w.call(sub(tokenA(w), UUID1, [tab], { received_at: '1999-01-01', _received_at: '1999-01-01' }));
  assert.equal(r.ok, true);
  const t = w.sheets.ssA.amb_visit;
  const row = Object.fromEntries(t.headers.map((h, i) => [h, t.rows[0][i]]));
  assert.equal(row._received_at, '2026-10-31T22:30:00.000Z');
  assert.equal(row._received_date_ist, '2026-11-01');
  assert.equal(t.headers.filter(h => h === '_received_at').length, 1);
});

test('the download page can filter on what we wrote', () => {
  const w = makeWorld({ now: Date.UTC(2026, 9, 31, 22, 30, 0) });
  w.call(sub(tokenA(w), UUID1));
  const t = w.sheets.ssA.amb_visit;
  const cols = L.findDateColumns(t.headers);
  assert.equal(t.headers[cols[0]], '_received_at');
  const kept = L.filterByDate(t.rows, cols[0], '2026-11-01', '2026-11-01');
  assert.equal(kept.rows.length, 1);
  assert.equal(L.filterByDate(t.rows, cols[0], '2026-10-31', '2026-10-31').rows.length, 0);
});

test('a duplicate uuid appends nothing and says so; the reply is still ok so the phone dequeues', () => {
  const w = makeWorld();
  const tok = tokenA(w);
  w.call(sub(tok, UUID1));
  const before = JSON.stringify(w.sheets);
  w.now += 60000;
  const r = w.call(sub(tok, UUID1, [mainTab(UUID1, { district: 'CHANGED' })]));
  assert.equal(r.ok, true); assert.equal(r.status, 'duplicate');
  assert.equal(JSON.stringify(w.sheets), before);
  assert.equal(w.sheets.ssA.amb_visit.rows.length, 1);
});

test('uuid match ignores case and surrounding spaces in the sheet', () => {
  const w = makeWorld();
  w.sheets.ssA = { amb_visit: { headers: ['uuid', 'district'], rows: [['  ' + UUID1.toUpperCase() + ' ', 'Gaya']] } };
  const r = w.call(sub(tokenA(w), UUID1));
  assert.equal(r.status, 'duplicate');
  assert.equal(w.sheets.ssA.amb_visit.rows.length, 1);
});

test('a new field adds a column at the right-hand end and existing rows stay aligned', () => {
  const w = makeWorld();
  const tok = tokenA(w);
  w.call(sub(tok, UUID1));
  const r = w.call(sub(tok, UUID2, [mainTab(UUID2, { district: 'Patna', child: 'Ravi', weight_kg: 12.5 })]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.added_columns, { amb_visit: ['weight_kg'] });
  const t = w.sheets.ssA.amb_visit;
  assert.deepEqual(t.headers, ['uuid', 'district', 'child', '_received_at', '_received_date_ist', '_submitted_by', 'weight_kg']);
  assert.deepEqual(t.rows[0], [UUID1, 'Gaya', 'Asha', '2026-10-31T10:00:00.000Z', '2026-10-31', 'Sunita Devi', '']);
  assert.deepEqual(t.rows[1], [UUID2, 'Patna', 'Ravi', '2026-10-31T10:00:00.000Z', '2026-10-31', 'Sunita Devi', 12.5]);
});

test('columns are never reordered or removed: another order or fewer fields fits the sheet', () => {
  const w = makeWorld();
  w.sheets.ssA = { amb_visit: { headers: ['uuid', 'child', 'district', 'extra', '_received_at', '_received_date_ist'], rows: [] } };
  w.call(sub(tokenA(w), UUID1, [mainTab(UUID1, { district: 'Gaya', child: 'Asha' })]));
  const t = w.sheets.ssA.amb_visit;
  assert.deepEqual(t.headers, ['uuid', 'child', 'district', 'extra', '_received_at', '_received_date_ist', '_submitted_by']);
  assert.deepEqual(t.rows[0], [UUID1, 'Asha', 'Gaya', '', '2026-10-31T10:00:00.000Z', '2026-10-31', 'Sunita Devi']);
});

test('an older sheet without received columns gets them added at the end', () => {
  const w = makeWorld();
  w.sheets.ssA = { amb_visit: { headers: ['uuid', 'district', 'child'], rows: [['old', 'Gaya', 'Z']] } };
  w.call(sub(tokenA(w), UUID1));
  const t = w.sheets.ssA.amb_visit;
  assert.deepEqual(t.headers, ['uuid', 'district', 'child', '_received_at', '_received_date_ist', '_submitted_by']);
  assert.deepEqual(t.rows[0], ['old', 'Gaya', 'Z', '', '', '']);
});

const repeatTab = (uuid, n) => ({
  name: 'amb_visit_doses', kind: 'repeat', key: ['parent_uuid', 'row_index'],
  rows: Array.from({ length: n }, (_, i) => ({ parent_uuid: uuid, row_index: i + 1, dose: 'D' + (i + 1) }))
});

test('repeat rows go to their own tab and carry the parent uuid in column 1', () => {
  const w = makeWorld();
  const r = w.call(sub(tokenA(w), UUID1, [mainTab(UUID1), repeatTab(UUID1, 2)]));
  assert.equal(r.ok, true);
  const t = w.sheets.ssA.amb_visit_doses;
  assert.deepEqual(t.headers, ['parent_uuid', 'row_index', 'dose']);
  assert.deepEqual(t.rows, [[UUID1, 1, 'D1'], [UUID1, 2, 'D2']]);
  assert.equal(w.sheets.ssA.amb_visit.rows.length, 1);
});

test('half-finished submission (repeat rows landed, main row did not) completes without repeating rows', () => {
  const w = makeWorld();
  const tok = tokenA(w);
  w.sheets.ssA = { amb_visit_doses: { headers: ['parent_uuid', 'row_index', 'dose'], rows: [[UUID1, 1, 'D1']] } };
  const r = w.call(sub(tok, UUID1, [mainTab(UUID1), repeatTab(UUID1, 2)]));
  assert.equal(r.status, 'created');
  assert.deepEqual(w.sheets.ssA.amb_visit_doses.rows, [[UUID1, 1, 'D1'], [UUID1, 2, 'D2']]);
  assert.equal(w.sheets.ssA.amb_visit.rows.length, 1);
});

test('repeat tabs are written before the main row, so the main row proves everything landed', () => {
  const w = makeWorld();
  const order = [];
  const real = w.deps.writeTab;
  w.deps.writeTab = (p, n, plan) => { order.push(n); return real(p, n, plan); };
  w.call(sub(tokenA(w), UUID1, [mainTab(UUID1), repeatTab(UUID1, 1)]));
  assert.deepEqual(order, ['amb_visit_doses', 'amb_visit']);
});

test('a duplicate main row skips the repeat rows too', () => {
  const w = makeWorld();
  const tok = tokenA(w);
  w.call(sub(tok, UUID1, [mainTab(UUID1), repeatTab(UUID1, 2)]));
  w.call(sub(tok, UUID1, [mainTab(UUID1), repeatTab(UUID1, 2)]));
  assert.equal(w.sheets.ssA.amb_visit_doses.rows.length, 2);
});

test('a repeat row whose parent_uuid is another submission is refused', () => {
  const w = makeWorld();
  const bad = repeatTab(UUID1, 1); bad.rows[0].parent_uuid = UUID2;
  const r = w.call(sub(tokenA(w), UUID1, [mainTab(UUID1), bad]));
  assert.equal(r.ok, false); assert.equal(r.error, 'bad_request'); assert.equal(r.retry, false);
  assert.deepEqual(w.sheets, {});
});

test('refuses to write into the Projects tab, or any tab with an odd name', () => {
  const w = makeWorld();
  const tok = tokenA(w);
  for (const name of ['Projects', 'projects', '../x', 'a b', '', 'x'.repeat(101), "o'brien", 'a/b']) {
    const t = mainTab(UUID1); t.name = name;
    const r = w.call(sub(tok, UUID1, [t]));
    assert.equal(r.ok, false, 'name ' + JSON.stringify(name));
    assert.equal(r.error, 'bad_request');
  }
  assert.deepEqual(w.sheets, {});
});

test('malformed submissions are bad_request and never retried', () => {
  const w = makeWorld();
  const tok = tokenA(w);
  const cases = [
    sub(tok, 'short'),
    sub(tok, UUID1, []),
    sub(tok, UUID1, [mainTab(UUID2)]),                                        // row uuid != submission uuid
    sub(tok, UUID1, [mainTab(UUID1), mainTab(UUID1)]),                         // two mains / same name
    sub(tok, UUID1, [mainTab(UUID1, { district: { nested: 1 } })]),            // object cell
    sub(tok, UUID1, [mainTab(UUID1, { '=cmd': 'x' })]),                        // formula-looking column name
    sub(tok, UUID1, [Object.assign(mainTab(UUID1), { key: ['district'] })]),   // main key must be uuid
    sub(tok, UUID1, [Object.assign(mainTab(UUID1), { rows: [] })]),
    sub(tok, UUID1, [{ name: 'f', kind: 'weird', key: ['uuid'], rows: [] }])
  ];
  for (const c of cases) {
    const r = w.call(c);
    assert.equal(r.ok, false); assert.equal(r.error, 'bad_request'); assert.equal(r.retry, false);
  }
  assert.deepEqual(w.sheets, {});
});

test('size limits: too many rows or columns is too_large', () => {
  const w = makeWorld();
  const tok = tokenA(w);
  const many = repeatTab(UUID1, 501);
  assert.equal(w.call(sub(tok, UUID1, [mainTab(UUID1), many])).error, 'too_large');
  const wide = {}; for (let i = 0; i < 301; i++) wide['q' + i] = 1;
  assert.equal(w.call(sub(tok, UUID1, [mainTab(UUID1, wide)])).error, 'too_large');
});

test('submit with a bad or revoked token writes nothing', () => {
  const w = makeWorld();
  const tok = tokenA(w);
  w.people[1][3] = 'no';
  const r = w.call(sub(tok, UUID1));
  assert.equal(r.error, 'session'); assert.deepEqual(w.sheets, {});
  assert.equal(w.call(sub('x.y.z.w', UUID1)).error, 'session');
});

test('photos are saved to the project, the cell carries the link, names are safe', () => {
  const w = makeWorld();
  const r = w.call(sub(tokenA(w), UUID1, [mainTab(UUID1, { district: 'Gaya', house_photo: '' })], {
    photos: [{ question: 'house_photo', mime: 'image/jpeg', data_base64: 'QUJD' }]
  }));
  assert.equal(r.ok, true);
  assert.equal(w.photos.length, 1);
  assert.equal(w.photos[0].project, 'Bihar AMB');
  assert.match(w.photos[0].name, /^[A-Za-z0-9_.-]+$/);
  assert.ok(w.photos[0].name.startsWith(UUID1) && w.photos[0].name.endsWith('.jpg'));
  const t = w.sheets.ssA.amb_visit;
  assert.equal(t.rows[0][t.headers.indexOf('house_photo')], 'https://drive.example/' + w.photos[0].name);
});

test('photo for a repeat row lands in that row', () => {
  const w = makeWorld();
  const rep = repeatTab(UUID1, 2); rep.rows[1].photo = '';
  w.call(sub(tokenA(w), UUID1, [mainTab(UUID1), rep], {
    photos: [{ question: 'photo', tab: 'amb_visit_doses', row: 1, mime: 'image/png', data_base64: 'QUJD' }]
  }));
  const t = w.sheets.ssA.amb_visit_doses;
  assert.match(t.rows[1][t.headers.indexOf('photo')], /^https:\/\/drive\.example\//);
  assert.equal(t.rows[0][t.headers.indexOf('photo')], '');
});

test('unsafe photo types, bad base64 and oversize photos are refused before anything is written', () => {
  const w = makeWorld();
  const tok = tokenA(w);
  const t = () => [mainTab(UUID1, { house_photo: '' })];
  for (const p of [
    { question: 'house_photo', mime: 'text/html', data_base64: 'QUJD' },
    { question: 'house_photo', mime: 'application/x-msdownload', data_base64: 'QUJD' },
    { question: 'house_photo', mime: 'image/jpeg', data_base64: '<script>' },
    { question: 'nope', mime: 'image/jpeg', data_base64: 'QUJD' }
  ]) {
    const r = w.call(sub(tok, UUID1, t(), { photos: [p] }));
    assert.equal(r.ok, false, JSON.stringify(p)); assert.equal(r.error, 'bad_request');
  }
  const big = w.call(sub(tok, UUID1, t(), { photos: [{ question: 'house_photo', mime: 'image/jpeg', data_base64: 'A'.repeat(8 * 1024 * 1024) }] }));
  assert.equal(big.error, 'too_large');
  assert.deepEqual(w.sheets, {}); assert.equal(w.photos.length, 0);
});

test('lock busy: reply is busy with retry true and nothing is written', () => {
  const w = makeWorld({ busy: true });
  const tok = tokenA(w);
  const r = w.call(sub(tok, UUID1));
  assert.equal(r.ok, false); assert.equal(r.error, 'busy'); assert.equal(r.retry, true);
  assert.deepEqual(w.sheets, {});
});

test('an unexpected failure is a retryable server_error that leaks no internals', () => {
  const w = makeWorld({ boom: true });
  const logged = [];
  w.deps.log = e => logged.push(String(e && e.message));
  const r = w.call(sub(tokenA(w), UUID1));
  assert.equal(r.ok, false); assert.equal(r.error, 'server_error'); assert.equal(r.retry, true);
  assert.ok(!JSON.stringify(r).includes('DriveApp'));
  assert.equal(logged.length, 1);
});

test('after a failed write the same submission can be sent again and lands once', () => {
  const w = makeWorld({ boom: true });
  const tok = tokenA(w);
  assert.equal(w.call(sub(tok, UUID1)).error, 'server_error');
  w.boom = false;
  assert.equal(w.call(sub(tok, UUID1)).status, 'created');
  assert.equal(w.call(sub(tok, UUID1)).status, 'duplicate');
  assert.equal(w.sheets.ssA.amb_visit.rows.length, 1);
});

test('cells: leading zeros and formula-looking text are kept as text, numbers stay numbers', () => {
  const w = makeWorld();
  w.call(sub(tokenA(w), UUID1, [mainTab(UUID1, { phone: '0987654321', note: '=1+1', age: 5, ok: true, blank: null })]));
  const t = w.sheets.ssA.amb_visit;
  const row = Object.fromEntries(t.headers.map((h, i) => [h, t.rows[0][i]]));
  assert.equal(row.phone, '0987654321'); assert.equal(row.note, '=1+1');
  assert.equal(row.age, 5); assert.equal(row.ok, true); assert.equal(row.blank, '');
});

// ---- the request itself ---------------------------------------------------------------------

test('parseBody: JSON text in, object out; junk and oversize are bad_request', () => {
  assert.equal(L.parseBody('{"action":"open","code":"X"}').ok, true);
  assert.equal(plain(L.parseBody('{"action":"open"}').body).action, 'open');
  for (const bad of ['', 'not json', '[]', 'null', '"x"', undefined]) {
    const r = plain(L.parseBody(bad));
    assert.equal(r.ok, false); assert.equal(r.error.error, 'bad_request'); assert.equal(r.error.retry, false);
  }
  assert.equal(plain(L.parseBody('{"a":"' + 'x'.repeat(12 * 1024 * 1024) + '"}')).error.error, 'too_large');
});

test('unknown action is bad_request', () => {
  const w = makeWorld();
  assert.equal(w.call({ action: 'delete' }).error, 'bad_request');
  assert.equal(w.call({}).error, 'bad_request');
  assert.equal(w.call(null).error, 'bad_request');
});

test('nothing in the API deletes: no delete path on deps, none in the source', () => {
  const w = makeWorld();
  assert.deepEqual(Object.keys(w.deps).filter(k => /delete|remove|clear|trash/i.test(k)), []);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'Backend.gs'), 'utf8'), /setTrashed|deleteRow|deleteSheet|\.remove\(|clearContent|\.clear\(/);
});

test('codeProblem: short codes and codes with spaces are not accepted', () => {
  assert.notEqual(L.codeProblem('abc'), '');
  assert.notEqual(L.codeProblem('abc def gh'), '');
  assert.equal(L.codeProblem('abc123'), '');
  assert.equal(L.codeProblem('   '), L.codeProblem(''));
});
