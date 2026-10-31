/**
 * Evidence Action - survey data download page.
 * Paste this file as Code.gs, and Page.html beside it, in Extensions > Apps Script.
 *
 * Layout of this file:
 *   1. PURE LOGIC  - takes data, returns data, never touches SpreadsheetApp. Tested under Node
 *                    (appsscript/tests/logic.test.js).
 *   2. SHEET GLUE  - doGet and the functions the page calls. Runs only inside Google.
 *
 * Assumptions about the sheet (see README): first row = column names, first column = the
 * submission uuid, one tab per form, repeat-group tabs named <form>_<repeat> whose first column
 * is parent_uuid.
 */

var IST_OFFSET_MS = 330 * 60 * 1000;           // Asia/Kolkata is UTC+05:30 all year, no DST
var MAX_DISTINCT_FILTER = 40;                  // an ordinary column with more values is not a filter
var MAX_DISTINCT_PREFERRED = 800;              // district / block lists may be long
var MAX_TEXT_LENGTH = 40;                      // longer average text means free text, not a category

// ======================================================================================
// 1. PURE LOGIC
// ======================================================================================

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

/** Milliseconds since epoch for a cell, or null. Text with no zone is read as Indian time. */
function parseInstant(v) {
  if (v === null || v === undefined) return null;
  if (isDate_(v)) return v.getTime();
  if (typeof v !== 'string') return null;
  var m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?\s*$/i.exec(v);
  if (!m) return null;
  var mo = +m[2], d = +m[3], h = +(m[4] || 0), mi = +(m[5] || 0), s = +(m[6] || 0);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  var utc = Date.UTC(+m[1], mo - 1, d, h, mi, s);
  var z = m[7];
  var offset = IST_OFFSET_MS;
  if (z) {
    if (z.toUpperCase() === 'Z') offset = 0;
    else {
      var sign = z.charAt(0) === '-' ? -1 : 1;
      var digits = z.slice(1).replace(':', '');
      offset = sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60000;
    }
  }
  return utc - offset;
}

/** 'YYYY-MM-DD' of that instant on the Indian calendar. */
function istDateKey(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD HH:MM:SS' on the Indian clock. */
function formatIst(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19);
}

function cellKey_(v) {
  if (v === null || v === undefined) return '';
  if (isDate_(v)) return formatIst(v.getTime());
  return String(v).trim();
}

function normName_(h) {
  return String(h === null || h === undefined ? '' : h).toLowerCase().replace(/[^a-z0-9ऀ-ॿ]/g, '');
}

/** Indexes of columns that look like a timestamp, best first: received, then finished, then started. */
function findDateColumns(headers) {
  var received = [], finished = [], started = [];
  for (var i = 0; i < headers.length; i++) {
    var n = normName_(headers[i]);
    if (n.indexOf('received') >= 0) received.push(i);
    else if (n === 'finishedat') finished.push(i);
    else if (n === 'startedat') started.push(i);
  }
  return received.concat(finished, started);
}

/** Keep rows whose Indian date lies in [from, to]. Both optional ('YYYY-MM-DD'). */
function filterByDate(rows, colIndex, from, to) {
  if (!from && !to) return { rows: rows.slice(), undated: 0 };
  var out = [], undated = 0;
  for (var i = 0; i < rows.length; i++) {
    var ms = parseInstant(rows[i][colIndex]);
    if (ms === null) { undated++; continue; }
    var day = istDateKey(ms);
    if (from && day < from) continue;
    if (to && day > to) continue;
    out.push(rows[i]);
  }
  return { rows: out, undated: undated };
}

var PREFERRED_FILTERS = [
  ['district', 'districtname', 'dist', 'zila', 'jila', 'जिला', 'जिला'],
  ['block', 'blockname', 'prakhand', 'प्रखंड']
];

function preferredRank_(header) {
  var n = normName_(header);
  for (var r = 0; r < PREFERRED_FILTERS.length; r++) {
    if (PREFERRED_FILTERS[r].indexOf(n) >= 0) return r;
  }
  return -1;
}

/**
 * Column indexes worth offering as a dropdown: district, block, then any other column that has a
 * small set of repeated values. Never the id column, the metadata columns or timestamps.
 */
function discoverFilters(headers, rows) {
  var dateCols = findDateColumns(headers);
  var preferred = [], others = [];
  for (var c = 1; c < headers.length; c++) {
    var name = String(headers[c]);
    if (name.charAt(0) === '_' || dateCols.indexOf(c) >= 0) continue;
    var seen = {}, distinct = 0, nonEmpty = 0, totalLen = 0;
    for (var r = 0; r < rows.length; r++) {
      var k = cellKey_(rows[r][c]);
      if (k === '') continue;
      nonEmpty++;
      totalLen += k.length;
      if (!seen.hasOwnProperty(k)) { seen[k] = 1; distinct++; }
    }
    if (distinct === 0) continue;
    var rank = preferredRank_(name);
    if (rank >= 0) {
      if (distinct <= MAX_DISTINCT_PREFERRED) preferred.push({ c: c, rank: rank });
    } else if (distinct <= MAX_DISTINCT_FILTER && distinct < nonEmpty && totalLen / nonEmpty <= MAX_TEXT_LENGTH) {
      others.push(c);
    }
  }
  preferred.sort(function (a, b) { return a.rank - b.rank || a.c - b.c; });
  return preferred.map(function (p) { return p.c; }).concat(others);
}

function sortedDistinct_(rows, colIndex) {
  var seen = {}, out = [];
  for (var i = 0; i < rows.length; i++) {
    var k = cellKey_(rows[i][colIndex]);
    if (k === '' || seen.hasOwnProperty(k)) continue;
    seen[k] = 1;
    out.push(k);
  }
  out.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
  return out;
}

function matchesSelection_(row, colIndex, value) {
  return cellKey_(row[colIndex]) === value;
}

/**
 * Options for each filter column. A column's list depends only on the choices made in the
 * columns BEFORE it, so choosing a district narrows the block list but not the district list.
 * Returns { <header>: [values] }.
 */
function cascadeOptions(headers, rows, filterCols, selected) {
  var out = {}, current = rows;
  for (var i = 0; i < filterCols.length; i++) {
    var c = filterCols[i], name = String(headers[c]);
    out[name] = sortedDistinct_(current, c);
    var chosen = selected && selected[name];
    if (chosen) {
      current = current.filter(function (row) { return matchesSelection_(row, c, chosen); });
    }
  }
  return out;
}

function validRange_(from, to) {
  return !(from && to && from > to);
}

/**
 * The whole filter pipeline: returns { rows: matching rows, info: what the page shows }.
 * request = { dateColumn, dateFrom, dateTo, selected: { <header>: value } }
 */
function applyQuery_(headers, rows, request) {
  request = request || {};
  var from = request.dateFrom || '', to = request.dateTo || '';
  var dateCols = findDateColumns(headers);
  var dateIdx = -1;
  if (request.dateColumn) dateIdx = headers.indexOf(request.dateColumn);
  if (dateIdx < 0 && dateCols.length) dateIdx = dateCols[0];

  var filterCols = discoverFilters(headers, rows);
  var options = cascadeOptions(headers, rows, filterCols, request.selected || {});

  // keep only choices that are still valid, in column order
  var selected = {}, active = [];
  for (var i = 0; i < filterCols.length; i++) {
    var name = String(headers[filterCols[i]]);
    var want = request.selected && request.selected[name];
    if (!want) continue;
    var legal = cascadeOptions(headers, rows, filterCols, selected)[name];
    if (legal.indexOf(want) >= 0) { selected[name] = want; active.push([filterCols[i], want]); }
  }
  options = cascadeOptions(headers, rows, filterCols, selected);

  var info = {
    total: rows.length,
    count: 0,
    undated: 0,
    problem: '',
    dateIgnored: false,
    dateColumn: dateIdx >= 0 ? String(headers[dateIdx]) : '',
    dateColumns: dateCols.map(function (c) { return String(headers[c]); }),
    selected: selected,
    filters: filterCols.map(function (c) {
      var n = String(headers[c]);
      return { column: n, options: options[n], selected: selected[n] || '' };
    })
  };

  if (!validRange_(from, to)) {
    info.problem = 'range_reversed';
    return { rows: [], info: info };
  }

  var kept = rows;
  if (from || to) {
    if (dateIdx < 0) info.dateIgnored = true;
    else {
      var d = filterByDate(kept, dateIdx, from, to);
      kept = d.rows;
      info.undated = d.undated;
    }
  }
  for (var j = 0; j < active.length; j++) {
    (function (c, v) { kept = kept.filter(function (row) { return matchesSelection_(row, c, v); }); })(active[j][0], active[j][1]);
  }
  info.count = kept.length;
  return { rows: kept, info: info };
}

function runQuery(headers, rows, request) {
  return applyQuery_(headers, rows, request).info;
}

// ---- CSV -----------------------------------------------------------------------------

function csvCell_(v) {
  if (v === null || v === undefined) return '';
  var s;
  if (isDate_(v)) s = formatIst(v.getTime());
  else if (typeof v === 'number') return isFinite(v) ? String(v) : '';   // real numbers stay numeric
  else if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  else {
    s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                              // CSV injection
  }
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** UTF-8 BOM + CRLF so Excel opens Hindi correctly. Always has a header row. */
function toCsv(headers, rows) {
  var lines = [headers.map(function (h) { return csvCell_(String(h)); }).join(',')];
  for (var i = 0; i < rows.length; i++) lines.push(rows[i].map(csvCell_).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function buildExport(headers, rows, request) {
  var q = applyQuery_(headers, rows, request);
  if (q.info.problem) return { csv: '', count: 0, problem: q.info.problem };
  return { csv: toCsv(headers, q.rows), count: q.rows.length, problem: '' };
}

function makeFilename(tab, from, to, selected) {
  function clean(s) { return String(s).replace(/[\\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, ''); }
  var parts = [clean(tab) || 'data', (from || to) ? (clean(from || 'start') + '_to_' + clean(to || 'latest')) : 'all-dates'];
  Object.keys(selected || {}).forEach(function (k) {
    if (selected[k]) parts.push(clean(selected[k]));
  });
  return parts.join('_') + '.csv';
}

// ---- table shaping --------------------------------------------------------------------

/** Raw sheet values -> { headers, rows }. Drops trailing blank columns and blank rows. */
function cleanTable(values) {
  if (!values || !values.length) return { headers: [], rows: [] };
  var headers = values[0].map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); });
  while (headers.length && headers[headers.length - 1] === '') headers.pop();
  for (var i = 0; i < headers.length; i++) if (headers[i] === '') headers[i] = 'column_' + (i + 1);
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r].slice(0, headers.length);
    while (row.length < headers.length) row.push('');
    var blank = row.every(function (v) { return v === '' || v === null || v === undefined; });
    if (!blank) rows.push(row);
  }
  return { headers: headers, rows: rows };
}

/** Longest tab name that is a "<name>_" prefix of this repeat tab, or ''. */
function findParentTab(tab, names) {
  var best = '';
  names.forEach(function (n) {
    if (n !== tab && tab.indexOf(n + '_') === 0 && n.length > best.length) best = n;
  });
  return best;
}

/** Add the parent submission's columns to each repeat row (matched on parent uuid). */
function joinParent(headers, rows, parentHeaders, parentRows, keyCol) {
  var keyIdx = headers.indexOf(keyCol);
  var byUuid = {};
  parentRows.forEach(function (r) { byUuid[cellKey_(r[0])] = r; });
  var used = {};
  headers.forEach(function (h) { used[h] = 1; });
  var add = [];   // [parentColumnIndex, outputName]
  for (var c = 1; c < parentHeaders.length; c++) {
    var name = parentHeaders[c];
    if (used[name]) name = 'parent_' + name;
    if (used[name]) continue;
    used[name] = 1;
    add.push([c, name]);
  }
  var outRows = rows.map(function (r) {
    var p = keyIdx >= 0 ? byUuid[cellKey_(r[keyIdx])] : null;
    return r.concat(add.map(function (a) { return p ? p[a[0]] : ''; }));
  });
  return { headers: headers.concat(add.map(function (a) { return a[1]; })), rows: outRows };
}

// ======================================================================================
// 2. SHEET GLUE  (runs only in Google; not covered by the Node tests)
// ======================================================================================

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Page')
    .setTitle('Evidence Action - Survey data download')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Tab names for the page's first dropdown, with their row counts. */
function getTabs() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (sh) {
    return { name: sh.getName(), rows: Math.max(0, sh.getLastRow() - 1) };
  });
}

function loadTable_(tab) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(tab);
  if (!sh) throw new Error('Tab not found: ' + tab);
  if (sh.getLastRow() < 1 || sh.getLastColumn() < 1) return { headers: [], rows: [], parent: '' };
  var t = cleanTable(sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues());
  var parent = '';
  if (t.headers[0] === 'parent_uuid') {
    var names = ss.getSheets().map(function (s) { return s.getName(); });
    parent = findParentTab(tab, names);
    if (parent) {
      var p = loadTable_(parent);
      if (p.headers.length) {
        var j = joinParent(t.headers, t.rows, p.headers, p.rows, 'parent_uuid');
        t = { headers: j.headers, rows: j.rows };
      }
    }
  }
  return { headers: t.headers, rows: t.rows, parent: parent };
}

/** Called by the page whenever a choice changes. Returns the count, and the dropdown contents. */
function queryTab(request) {
  var t = loadTable_(request.tab);
  var info = runQuery(t.headers, t.rows, request);
  info.tab = request.tab;
  info.parent = t.parent;
  info.empty = t.headers.length === 0;
  return info;
}

/** Called by the Download button. The browser turns the text into a file. */
function exportCsv(request) {
  var t = loadTable_(request.tab);
  var out = buildExport(t.headers, t.rows, request);
  var info = runQuery(t.headers, t.rows, request);
  out.filename = makeFilename(request.tab, request.dateFrom, request.dateTo, info.selected);
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseInstant: parseInstant, istDateKey: istDateKey, formatIst: formatIst, findDateColumns: findDateColumns,
    filterByDate: filterByDate, discoverFilters: discoverFilters, cascadeOptions: cascadeOptions,
    runQuery: runQuery, buildExport: buildExport, toCsv: toCsv, makeFilename: makeFilename,
    cleanTable: cleanTable, findParentTab: findParentTab, joinParent: joinParent
  };
}
