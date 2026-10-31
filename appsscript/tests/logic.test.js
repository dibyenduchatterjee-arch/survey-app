'use strict';
// Loads Code.gs the way Apps Script does: one file, global functions, no module system.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
const L = ctx;
const plain = x => JSON.parse(JSON.stringify(x));

const HEAD = ['uuid', 'district', 'block', 'child_name', 'age', '_gps', '_started_at', '_finished_at', '_submitted_by', '_received_at'];
const R = (uuid, district, block, name, age, received) =>
  [uuid, district, block, name, age, '26.1 85.4', '', '', 'a@x.org', received];
const ROWS = [
  R('u1', 'मुजफ्फरपुर', 'कांटी', 'Asha', 5, '2026-10-30T10:00:00Z'),
  R('u2', 'मुजफ्फरपुर', 'मीनापुर', 'Ravi', 6, '2026-10-31T10:00:00Z'),
  R('u3', 'गया', 'बोधगया', 'Sita', 7, '2026-10-31T22:30:00Z'), // 04:00 IST on 1 Nov
  R('u4', 'गया', 'टेकारी', 'Mohan', 8, '2026-11-02T01:00:00Z'),
  R('u5', 'पटना', 'दानापुर', 'Gita', 9, 'not a date'),
];

test('parseInstant: ISO with Z, with offset, without zone (read as IST), Date, junk', () => {
  assert.equal(L.parseInstant('2026-10-31T18:30:00Z'), Date.UTC(2026, 9, 31, 18, 30));
  assert.equal(L.parseInstant('2026-11-01T00:00:00+05:30'), Date.UTC(2026, 9, 31, 18, 30));
  assert.equal(L.parseInstant('2026-11-01 00:00:00'), Date.UTC(2026, 9, 31, 18, 30));
  assert.equal(L.parseInstant('2026-11-01'), Date.UTC(2026, 9, 31, 18, 30));
  assert.equal(L.parseInstant(new Date(Date.UTC(2026, 9, 31, 18, 30))), Date.UTC(2026, 9, 31, 18, 30));
  assert.equal(L.parseInstant('hello'), null);
  assert.equal(L.parseInstant(''), null);
  assert.equal(L.parseInstant(null), null);
  assert.equal(L.parseInstant(12345), null);
});

test('istDateKey: 18:29:59Z is still 31 Oct, 18:30:00Z is 1 Nov', () => {
  assert.equal(L.istDateKey(Date.UTC(2026, 9, 31, 18, 29, 59)), '2026-10-31');
  assert.equal(L.istDateKey(Date.UTC(2026, 9, 31, 18, 30, 0)), '2026-11-01');
});

test('date range includes and excludes correctly at both IST boundaries', () => {
  const mk = iso => [[iso]];
  const keep = (iso, from, to) => L.filterByDate(mk(iso), 0, from, to).rows.length === 1;
  // upper edge: last second of 31 Oct IST is in, first second of 1 Nov IST is out
  assert.ok(keep('2026-10-31T18:29:59Z', '', '2026-10-31'));
  assert.ok(!keep('2026-10-31T18:30:00Z', '', '2026-10-31'));
  // lower edge: 23:59:59 IST on 31 Oct is out of "from 1 Nov", 00:00:00 IST is in
  assert.ok(!keep('2026-10-31T18:29:59Z', '2026-11-01', ''));
  assert.ok(keep('2026-10-31T18:30:00Z', '2026-11-01', ''));
  // a 04:00 IST visit on 1 Nov (22:30Z on 31 Oct) belongs to 1 Nov
  assert.ok(keep('2026-10-31T22:30:00Z', '2026-11-01', '2026-11-01'));
  assert.ok(!keep('2026-10-31T22:30:00Z', '2026-10-31', '2026-10-31'));
});

test('undated rows are dropped only when a range is set, and counted', () => {
  const none = L.filterByDate(ROWS, 9, '', '');
  assert.equal(none.rows.length, 5);
  const some = L.filterByDate(ROWS, 9, '2026-10-30', '2026-11-30');
  assert.equal(some.rows.length, 4);
  assert.equal(some.undated, 1);
});

test('findDateColumns prefers received, then finished, then started', () => {
  assert.deepEqual(plain(L.findDateColumns(HEAD)), [9, 7, 6]);
  assert.deepEqual(plain(L.findDateColumns(['uuid', '_started_at'])), [1]);
  assert.deepEqual(plain(L.findDateColumns(['uuid', 'x'])), []);
  assert.equal(L.findDateColumns(['uuid', 'Received', 'received_at'])[0], 1);
});

test('discoverFilters: district then block first, ids/meta/free text excluded', () => {
  const head = ['uuid', 'age_band', 'block', 'child_name', 'district', '_gps', '_started_at', '_finished_at', '_submitted_by', '_received_at'];
  const data = [];
  for (let i = 0; i < 100; i++) data.push(['u' + i, 'band' + (i % 4), 'B' + (i % 9), 'Child number ' + i, 'D' + (i % 3), '', '', '', '', '2026-10-30T10:00:00Z']);
  const f = L.discoverFilters(head, data);
  assert.deepEqual(plain(f.map(x => head[x])), ['district', 'block', 'age_band']);
});

test('discoverFilters: a small sheet still offers district; matches other spellings', () => {
  const f = L.discoverFilters(['uuid', 'District Name', 'Block', 'x'], [['1', 'गया', 'a', 'p'], ['2', 'पटना', 'b', 'q']]);
  assert.deepEqual(plain(f.slice(0, 2)), [1, 2]);
});

test('cascade: choosing a district narrows the block list to that district', () => {
  const f = L.discoverFilters(HEAD, ROWS);
  const none = L.cascadeOptions(HEAD, ROWS, f, {});
  assert.deepEqual(plain(none.block).sort(), ['कांटी', 'टेकारी', 'दानापुर', 'बोधगया', 'मीनापुर'].sort());
  const gaya = L.cascadeOptions(HEAD, ROWS, f, { district: 'गया' });
  assert.deepEqual(plain(gaya.block).sort(), ['टेकारी', 'बोधगया'].sort());
  assert.deepEqual(plain(gaya.district).sort(), ['गया', 'पटना', 'मुजफ्फरपुर'].sort()); // district list itself stays full
});

test('runQuery: count, pruning of a stale block, reversed range', () => {
  const base = { dateColumn: '_received_at', dateFrom: '', dateTo: '', selected: {} };
  const all = L.runQuery(HEAD, ROWS, base);
  assert.equal(all.count, 5);
  assert.equal(all.total, 5);

  const gaya = L.runQuery(HEAD, ROWS, { ...base, selected: { district: 'गया' } });
  assert.equal(gaya.count, 2);

  // block belongs to another district -> no longer valid, dropped
  const stale = L.runQuery(HEAD, ROWS, { ...base, selected: { district: 'गया', block: 'कांटी' } });
  assert.deepEqual(plain(stale.selected), { district: 'गया' });
  assert.equal(stale.count, 2);

  const bad = L.runQuery(HEAD, ROWS, { ...base, dateFrom: '2026-11-05', dateTo: '2026-11-01' });
  assert.equal(bad.problem, 'range_reversed');
  assert.equal(bad.count, 0);

  const day = L.runQuery(HEAD, ROWS, { ...base, dateFrom: '2026-11-01', dateTo: '2026-11-01' });
  assert.equal(day.count, 1); // only the 04:00 IST visit
});

test('runQuery with no date column: date filter is ignored and says so', () => {
  const r = L.runQuery(['uuid', 'district'], [['1', 'a']], { dateFrom: '2026-01-01', dateTo: '', selected: {} });
  assert.equal(r.dateColumn, '');
  assert.equal(r.count, 1);
  assert.equal(r.dateIgnored, true);
});

test('CSV starts with a BOM and uses CRLF', () => {
  const csv = L.toCsv(['a', 'b'], [['1', '2'], ['3', '4']]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  const bytes = Buffer.from(csv, 'utf8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.equal(csv.slice(1), 'a,b\r\n1,2\r\n3,4\r\n');
  assert.ok(!/[^\r]\n/.test(csv));
});

test('Devanagari survives the UTF-8 byte round trip', () => {
  const csv = L.toCsv(['जिला'], [['मुजफ्फरपुर'], ['कांटी, बोचहां']]);
  const back = new TextDecoder('utf-8').decode(Buffer.from(csv, 'utf8'));
  assert.ok(back.includes('मुजफ्फरपुर'));
  assert.ok(back.includes('"कांटी, बोचहां"'));
  assert.ok(!back.includes('?'));
});

test('CSV injection: = + - @ get a quote prefix, real numbers stay numeric', () => {
  const csv = L.toCsv(['v'], [['=SUM(A1)'], ['+91 98'], ['-cmd'], ['@x'], [-5], [3.5], [0], ['Asha']]);
  const lines = csv.slice(1).split('\r\n');
  assert.deepEqual(lines, ['v', "'=SUM(A1)", "'+91 98", "'-cmd", "'@x", '-5', '3.5', '0', 'Asha', '']);
});

test('CSV quoting: commas, quotes, newlines; dates as IST text; blanks', () => {
  const csv = L.toCsv(['t', 'n'], [['a "b", c', 'x\ny'], [new Date(Date.UTC(2026, 9, 31, 22, 30)), null]]);
  assert.equal(csv.slice(1), 't,n\r\n"a ""b"", c","x\ny"\r\n2026-11-01 04:00:00,\r\n');
});

test('an empty match produces a header-only CSV, not an error', () => {
  const csv = L.toCsv(['uuid', 'जिला'], []);
  assert.equal(csv, '﻿uuid,जिला\r\n');
});

test('buildExport: filtered rows only, header-only when nothing matched', () => {
  const ok = L.buildExport(HEAD, ROWS, { dateColumn: '_received_at', dateFrom: '2026-10-31', dateTo: '2026-10-31', selected: { district: 'मुजफ्फरपुर' } });
  assert.equal(ok.count, 1);
  assert.ok(ok.csv.includes('Ravi'));
  assert.ok(!ok.csv.includes('Asha'));
  const none = L.buildExport(HEAD, ROWS, { dateColumn: '_received_at', dateFrom: '2030-01-01', dateTo: '2030-01-02', selected: {} });
  assert.equal(none.count, 0);
  assert.equal(none.csv.slice(1).split('\r\n').filter(Boolean).length, 1);
});

test('joinParent: repeat rows pick up parent columns, collisions renamed, orphans blank', () => {
  const rh = ['parent_uuid', 'row_index', 'dose', 'district'];
  const rr = [['u2', 1, 'a', 'x'], ['zz', 2, 'b', 'y']];
  const j = L.joinParent(rh, rr, HEAD, ROWS, 'parent_uuid');
  assert.deepEqual(plain(j.headers.slice(0, 4)), rh);
  assert.ok(j.headers.includes('parent_district'));
  assert.ok(j.headers.includes('block'));
  assert.ok(!j.headers.includes('uuid'));
  const bi = j.headers.indexOf('block');
  assert.equal(j.rows[0][bi], 'मीनापुर');
  assert.equal(j.rows[1][bi], '');
});

test('findParentTab: longest prefix match', () => {
  assert.equal(L.findParentTab('visit_children', ['visit', 'visit_children', 'other']), 'visit');
  assert.equal(L.findParentTab('a_b_c', ['a', 'a_b', 'a_b_c']), 'a_b');
  assert.equal(L.findParentTab('solo', ['a', 'solo']), '');
});

test('cleanTable: trailing blank headers and blank rows removed', () => {
  const t = L.cleanTable([['uuid', 'a', '', ''], ['1', 'x', '', ''], ['', '', '', ''], ['2', 'y', '', '']]);
  assert.deepEqual(plain(t.headers), ['uuid', 'a']);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(plain(L.cleanTable([])), { headers: [], rows: [] });
});

test('makeFilename is safe and says what was selected', () => {
  const n = L.makeFilename('visit/form', '2026-10-01', '2026-10-31', { district: 'मुजफ्फरपुर', block: '' });
  assert.ok(n.endsWith('.csv'));
  assert.ok(!/[\\/:*?"<>| ]/.test(n));
  assert.ok(n.includes('2026-10-01') && n.includes('2026-10-31') && n.includes('मुजफ्फरपुर'));
});
