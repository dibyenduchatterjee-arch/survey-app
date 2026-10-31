/**
 * Evidence Action - survey data backend (Apps Script Web App).
 * Paste this file as Backend.gs beside Code.gs (the download page) in Extensions > Apps Script.
 *
 * What it is: a small JSON API that the phone app calls instead of a server. It runs AS THE
 * PERSON WHO DEPLOYED IT, with their Drive permissions, so field workers need no Google account.
 * A project ACCESS CODE is the credential: one deployed app serves every project, and the code
 * decides which project's forms and data a phone can reach.
 *
 * Layout of this file:
 *   1. PURE LOGIC - takes data, returns data. No SpreadsheetApp / DriveApp / Utilities inside.
 *                   Tested under Node (appsscript/tests/backend.test.js).
 *   2. dispatch   - the whole request flow, still pure: every outside effect (Sheets, Drive,
 *                   clock, lock, hashing) arrives through a `deps` object, so tests run it with
 *                   in-memory fakes.
 *   3. GOOGLE GLUE - doPost, the Projects tab, menu items. Runs only inside Google; NOT tested here.
 *
 * Nothing in this file deletes anything: no row, tab, file or folder is ever removed.
 */

var PROJECTS_TAB = 'Projects';
var PEOPLE_TAB = 'People';
var PROJECT_HEADERS = ['Project name', 'Drive folder id', 'Data spreadsheet id'];
var PEOPLE_HEADERS = ['Person name', 'Access code', 'Project', 'Active'];

var SESSION_TTL_MS = 6 * 3600 * 1000;          // a working day; the phone simply opens again after that
var HASH_ROUNDS = 300;
var FAIL_WINDOW_MS = 10 * 60 * 1000;           // wrong-code attempts are counted over ten minutes
var FAIL_LIMIT = 40;                           // across ALL phones: there is no per-phone identity in Apps Script
var FAIL_PAUSE_S = 300;

var MAX_BODY_CHARS = 10 * 1024 * 1024;
var MAX_TABS = 20;
var MAX_ROWS = 500;
var MAX_COLS = 300;
var MAX_CELL_CHARS = 20000;
var MAX_PHOTOS = 20;
var MAX_PHOTO_B64 = 4 * 1024 * 1024;           // about 3 MB of picture; the phone shrinks photos far below that
var MAX_NAME_CHARS = 100;

var STAMP_RECEIVED = '_received_at';           // UTC, ISO text, e.g. 2026-10-31T10:00:00.000Z
var STAMP_RECEIVED_IST = '_received_date_ist'; // Indian calendar date, e.g. 2026-10-31
var STAMP_SUBMITTED_BY = '_submitted_by';       // the person's name, from THEIR code, never from the phone
var STAMP_COLS = [STAMP_RECEIVED, STAMP_RECEIVED_IST, STAMP_SUBMITTED_BY];
var RESERVED_TABS = ['projects', 'people'];

var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I, L, O, 0, 1: easy to read out and type
var PHOTO_TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a'
};

// ======================================================================================
// 1. PURE LOGIC
// ======================================================================================

// ---- access codes: stored as a salted, repeated SHA-256, never as text --------------------

function normalizeCode_(c) {
  return String(c === null || c === undefined ? '' : c).trim().toUpperCase();
}

function constantTimeEqual_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  return diff === 0;
}

function hashRounds_(code, salt, rounds, sha) {
  var h = sha(salt + '|' + code);
  for (var i = 0; i < rounds; i++) h = sha(h + '|' + salt + '|' + code);
  return h;
}

/** 'sha256$<rounds>$<salt>$<hex>' - what goes in the Access code cell. */
function makeStoredCode(code, salt, sha, rounds, tag) {
  var n = normalizeCode_(code);
  if (!n) throw new Error('empty code');
  rounds = rounds || HASH_ROUNDS;
  return 'sha256$' + rounds + '$' + salt + '$' + hashRounds_(n, salt, rounds, sha) + (tag ? '$' + tag : '');
}

function parseStored_(s) {
  var m = /^sha256\$(\d{1,5})\$([A-Za-z0-9]{8,64})\$([0-9a-f]{64})(?:\$([0-9a-f]{16}))?$/.exec(String(s === null || s === undefined ? '' : s).trim());
  if (!m || +m[1] > 20000) return null;
  return { rounds: +m[1], salt: m[2], hash: m[3], tag: m[4] || '' };
}

function isStoredCode(s) {
  return !!parseStored_(s);
}

function verifyCode(code, stored, sha) {
  var p = parseStored_(stored), n = normalizeCode_(code);
  if (!p || !n) return false;
  return constantTimeEqual_(hashRounds_(n, p.salt, p.rounds, sha), p.hash);
}

/** Problem with a code someone chose, or '' when it is acceptable. */
function codeProblem(code) {
  var n = normalizeCode_(code);
  if (n.length < 6) return 'The code must have at least 6 letters or digits.';
  if (/\s/.test(n)) return 'The code must not contain spaces.';
  return '';
}

/** A readable random code from raw bytes (0-255). Bytes that would bias the choice are skipped. */
function generateCode(bytes, length) {
  var out = '';
  for (var i = 0; i < bytes.length && out.length < length; i++) {
    if (bytes[i] < 248) out += CODE_ALPHABET.charAt(bytes[i] % 31);
  }
  if (out.length < length) throw new Error('not enough random bytes');
  return out;
}

// ---- the Projects sheet ---------------------------------------------------------------------

function exampleProjectRow() {
  return ['Example project (edit me)', 'PASTE-DRIVE-FOLDER-ID', 'PASTE-DATA-SPREADSHEET-ID'];
}

function examplePersonRow() {
  return ['Example person (edit me)', '', 'Example project (edit me)', 'no'];
}

function hdrKey_(h) {
  return String(h === null || h === undefined ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isActive_(v) {
  var s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  return s === 'yes' || s === 'y' || s === 'true' || s === '1';   // anything else, including blank, is off
}

/** Raw sheet values -> [{ rowNumber, get(key) }]. Columns are found by heading, in any order; blank rows dropped. */
function readTable_(values) {
  if (!values || values.length < 2) return [];
  var idx = {}, head = values[0];
  for (var c = 0; c < head.length; c++) idx[hdrKey_(head[c])] = c;
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r], blank = true;
    for (var k = 0; k < row.length; k++) if (String(row[k] === null || row[k] === undefined ? '' : row[k]).trim() !== '') blank = false;
    if (blank) continue;
    out.push({
      rowNumber: r + 1,
      get: (function (row) {
        return function (key) {
          var i = idx[key];
          return i === undefined || row[i] === undefined || row[i] === null ? '' : String(row[i]).trim();
        };
      })(row)
    });
  }
  return out;
}

/** Projects tab -> [{ rowNumber, name, folderId, spreadsheetId, usable }]. No codes live here. */
function parseProjects(values) {
  return readTable_(values).map(function (t) {
    var p = { rowNumber: t.rowNumber, name: t.get('projectname'), folderId: t.get('drivefolderid'), spreadsheetId: t.get('dataspreadsheetid') };
    p.usable = !!(p.name && p.folderId && p.spreadsheetId);
    return p;
  });
}

/** People tab -> [{ rowNumber, name, stored, projectName, active }]. */
function parsePeople(values) {
  return readTable_(values).map(function (t) {
    return { rowNumber: t.rowNumber, name: t.get('personname'), stored: t.get('accesscode'), projectName: t.get('project'), active: isActive_(t.get('active')) };
  });
}

/** The one usable project with this name (case-insensitive), or null if none or if the name is ambiguous. */
function resolveProject_(projects, name) {
  var key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  var hits = projects.filter(function (p) { return p.name.toLowerCase() === key; });
  return hits.length === 1 && hits[0].usable ? hits[0] : null;
}

/** Plain-language problems the owner should fix; empty when both tabs are fine. */
function projectProblems(projects, people) {
  var msgs = [], names = {};
  projects.forEach(function (p) {
    var label = 'Projects row ' + p.rowNumber + (p.name ? ' (' + p.name + ')' : '');
    if (!p.usable) msgs.push(label + ': the name, Drive folder id or data spreadsheet id is empty, so nobody can be given this project.');
    var k = p.name.toLowerCase();
    if (k) names[k] = (names[k] || 0) + 1;
  });
  Object.keys(names).forEach(function (k) {
    if (names[k] > 1) msgs.push('Projects: the name "' + k + '" appears ' + names[k] + ' times. Names must be unique, so everyone on that project is locked out until fixed.');
  });
  (people || []).forEach(function (p) {
    var label = 'People row ' + p.rowNumber + (p.name ? ' (' + p.name + ')' : '');
    if (p.stored && !isStoredCode(p.stored)) {
      msgs.push(label + ': the access code has not been hashed (it is plain text). Use the menu "Set or change the code for the selected row".');
    } else if (!p.stored && p.active) {
      msgs.push(label + ': Active is yes but there is no access code, so this person cannot open anything.');
    }
    if (p.active && !resolveProject_(projects, p.projectName)) {
      msgs.push(label + ': the project "' + p.projectName + '" is not on the Projects tab exactly once, or is incomplete.');
    }
  });
  return msgs;
}

/**
 * The active person whose code this is, with their project: { person, project }, or null.
 * tagOf (optional) turns a typed code into the short lookup tag stored beside the hash, so only
 * the person it points to is hashed in full. A code that matches two active people is refused:
 * it cannot say who is collecting.
 */
function findPerson(people, projects, code, sha, tagOf) {
  var n = normalizeCode_(code);
  var tag = tagOf && n ? tagOf(n) : '';
  var hits = [];
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    if (!p.active) continue;
    var parsed = parseStored_(p.stored);
    if (!parsed) continue;
    if (tag && parsed.tag && parsed.tag !== tag) continue;       // cannot be this person's code
    var project = resolveProject_(projects, p.projectName);
    if (!project) continue;
    if (verifyCode(code, p.stored, sha)) hits.push({ person: p, project: project });
  }
  return hits.length === 1 ? hits[0] : null;
}

// ---- session token: stateless, signed, re-checked against the sheets on every call ------------

function personId_(person, sha) {
  return sha(person.name.toLowerCase() + '|' + person.projectName.toLowerCase()).slice(0, 16);
}

function signToken_(person, now, sha, hmac, secret) {
  var parsed = parseStored_(person.stored);
  var body = personId_(person, sha) + '.' + parsed.hash.slice(0, 12) + '.' + (now + SESSION_TTL_MS);
  return body + '.' + hmac(body, secret);
}

/** { person, project } this token still belongs to, or null (expired, forged, person switched off, code changed). */
function verifyToken_(token, people, projects, now, sha, hmac, secret) {
  if (typeof token !== 'string' || token.length > 300) return null;
  var parts = token.split('.');
  if (parts.length !== 4) return null;
  var body = parts[0] + '.' + parts[1] + '.' + parts[2];
  if (!constantTimeEqual_(hmac(body, secret), parts[3])) return null;
  if (!(+parts[2] > now)) return null;
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    if (!p.active) continue;
    var parsed = parseStored_(p.stored);
    if (!parsed || parsed.hash.slice(0, 12) !== parts[1]) continue;
    if (personId_(p, sha) !== parts[0]) continue;
    var project = resolveProject_(projects, p.projectName);
    if (project) return { person: p, project: project };
  }
  return null;
}

function pruneFailures_(times, now) {
  return (times || []).filter(function (t) { return t > now - FAIL_WINDOW_MS; });
}

// ---- the download page: owner only ------------------------------------------------------------

/** The page runs as the owner and can download everything, so it is not shown to an anonymous visitor. */
function downloadPageAllowed(activeEmail, ownerEmail, extraCsv) {
  var a = String(activeEmail || '').trim().toLowerCase();
  if (!a) return false;
  if (a === String(ownerEmail || '').trim().toLowerCase()) return true;
  return String(extraCsv || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).indexOf(a) >= 0;
}

// ---- forms -------------------------------------------------------------------------------------

function parseSpecFiles(files) {
  var forms = [], skipped = [];
  (files || []).forEach(function (f) {
    if (!/\.spec\.json$/i.test(f.name)) return;
    try {
      var o = JSON.parse(f.text);
      if (o && typeof o === 'object' && !Array.isArray(o)) forms.push(o); else skipped.push(f.name);
    } catch (e) { skipped.push(f.name); }
  });
  return { forms: forms, skipped: skipped };
}

// ---- responses ---------------------------------------------------------------------------------

function fail_(error, message, retry, retryAfterS) {
  var o = { ok: false, error: error, message: message, retry: !!retry };
  if (retryAfterS) o.retry_after_s = retryAfterS;
  return o;
}

function refused_() { return fail_('refused', 'That code was not accepted.', false); }
function sessionExpired_() { return fail_('session', 'The session has ended. Open the project again with its code.', false); }

/** Raw POST text -> { ok:true, body } or { ok:false, error:<response> }. */
function parseBody(text) {
  if (typeof text !== 'string' || !text) return { ok: false, error: fail_('bad_request', 'The request was empty.', false) };
  if (text.length > MAX_BODY_CHARS) return { ok: false, error: fail_('too_large', 'The request is too large. Send fewer or smaller photos.', false) };
  var body;
  try { body = JSON.parse(text); } catch (e) { return { ok: false, error: fail_('bad_request', 'The request was not valid JSON.', false) }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: fail_('bad_request', 'The request must be a JSON object.', false) };
  return { ok: true, body: body };
}

// ---- submissions -------------------------------------------------------------------------------

function keyOf_(cells) {
  return cells.map(function (c) { return String(c === null || c === undefined ? '' : c).trim().toLowerCase(); }).join('|');
}

function validTabName_(n) {
  return typeof n === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(n) && RESERVED_TABS.indexOf(n.toLowerCase()) < 0;
}

function validColumn_(n) {
  return typeof n === 'string' && n.length >= 1 && n.length <= MAX_NAME_CHARS && n === n.trim() &&
    !/[\u0000-\u001f]/.test(n) && !/^[=+\-@]/.test(n);
}

function bad_(msg) { return { ok: false, error: 'bad_request', message: msg }; }
function big_(msg) { return { ok: false, error: 'too_large', message: msg }; }

function isPlainObject_(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

/**
 * Checks a submit request and returns { ok:true, sub } with each tab's columns worked out
 * (key columns first, then the rest in order of appearance, never the received stamps), or
 * { ok:false, error, message }.
 */
function validateSubmission(body) {
  var uuid = body.uuid;
  if (typeof uuid !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(uuid)) return bad_('uuid is missing or not valid.');
  if (!Array.isArray(body.tabs) || body.tabs.length < 1) return bad_('tabs is missing.');
  if (body.tabs.length > MAX_TABS) return big_('Too many tabs in one submission.');
  var names = {}, mains = 0, tabs = [], main = null;
  for (var t = 0; t < body.tabs.length; t++) {
    var tab = body.tabs[t];
    if (!isPlainObject_(tab)) return bad_('A tab is malformed.');
    if (!validTabName_(tab.name)) return bad_('A tab name is not allowed.');
    if (names[tab.name.toLowerCase()]) return bad_('Two tabs have the same name.');
    names[tab.name.toLowerCase()] = 1;
    if (tab.kind !== 'main' && tab.kind !== 'repeat') return bad_('A tab must be kind main or repeat.');
    if (!Array.isArray(tab.key) || !tab.key.length || tab.key.some(function (k) { return !validColumn_(k); })) return bad_('A tab needs key columns.');
    if (tab.kind === 'main') {
      mains++;
      if (tab.key.length !== 1 || tab.key[0] !== 'uuid') return bad_('The main tab key must be uuid.');
    } else if (tab.key[0] !== 'parent_uuid') return bad_('A repeat tab key must start with parent_uuid.');
    if (!Array.isArray(tab.rows)) return bad_('A tab needs rows.');
    if (tab.rows.length > MAX_ROWS) return big_('Too many rows in a tab.');
    if (tab.kind === 'main' && tab.rows.length !== 1) return bad_('The main tab carries exactly one row.');
    var columns = tab.key.slice(), seen = {}, rows = [];
    columns.forEach(function (c) { seen[c] = 1; });
    for (var r = 0; r < tab.rows.length; r++) {
      var src = tab.rows[r];
      if (!isPlainObject_(src)) return bad_('A row is malformed.');
      var row = {};
      var keys = Object.keys(src);
      for (var k = 0; k < keys.length; k++) {
        var col = keys[k], v = src[col];
        if (STAMP_COLS.indexOf(col) >= 0) continue;                 // the script stamps these, never the phone
        if (!validColumn_(col)) return bad_('A column name is not allowed.');
        if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return bad_('A value must be text, a number, true/false or empty.');
        if (typeof v === 'number' && !isFinite(v)) return bad_('A number is not valid.');
        if (typeof v === 'string' && v.length > MAX_CELL_CHARS) return big_('An answer is too long.');
        row[col] = v;
        if (!seen[col]) { seen[col] = 1; columns.push(col); }
      }
      for (var q = 0; q < tab.key.length; q++) {
        var kv = row[tab.key[q]];
        if (kv === undefined || kv === null || String(kv).trim() === '') return bad_('A key value is missing.');
      }
      if (tab.kind === 'main' && String(row.uuid) !== uuid) return bad_('The row uuid does not match the submission uuid.');
      if (tab.kind === 'repeat' && String(row.parent_uuid) !== uuid) return bad_('A repeat row belongs to a different submission.');
      rows.push(row);
    }
    if (columns.length > MAX_COLS) return big_('Too many columns.');
    var norm = { name: tab.name, kind: tab.kind, key: tab.key.slice(), columns: columns, rows: rows };
    tabs.push(norm);
    if (tab.kind === 'main') main = norm;
  }
  if (mains !== 1) return bad_('There must be exactly one main tab.');

  var photos = [], list = body.photos === undefined ? [] : body.photos;
  if (!Array.isArray(list)) return bad_('photos must be a list.');
  if (list.length > MAX_PHOTOS) return big_('Too many photos.');
  for (var i = 0; i < list.length; i++) {
    var ph = list[i];
    if (!isPlainObject_(ph)) return bad_('A photo is malformed.');
    if (!PHOTO_TYPES.hasOwnProperty(ph.mime)) return bad_('This file type is not accepted.');
    if (typeof ph.data_base64 !== 'string' || !ph.data_base64) return bad_('A photo has no data.');
    if (ph.data_base64.length > MAX_PHOTO_B64) return big_('A photo is too large.');
    if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(ph.data_base64)) return bad_('A photo is not valid base64.');
    var tabName = ph.tab === undefined ? main.name : ph.tab;
    var target = null;
    for (var x = 0; x < tabs.length; x++) if (tabs[x].name === tabName) target = tabs[x];
    var rowIdx = ph.row === undefined ? 0 : ph.row;
    if (!target || !isInteger_(rowIdx) || rowIdx < 0 || rowIdx >= target.rows.length) return bad_('A photo points at a row that is not there.');
    if (typeof ph.question !== 'string' || !validColumn_(ph.question) || target.columns.indexOf(ph.question) < 0) return bad_('A photo points at a question that is not there.');
    photos.push({ question: ph.question, mime: ph.mime, data_base64: ph.data_base64, tab: target.name, row: rowIdx, isMain: target === main });
  }
  return { ok: true, sub: { uuid: uuid, main: main, tabs: tabs, photos: photos } };
}

function isInteger_(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

function photoFileName(uuid, photo) {
  function clean(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60); }
  var mid = photo.isMain ? '' : clean(photo.tab) + '_' + photo.row + '_';
  return uuid + '_' + mid + clean(photo.question) + '.' + PHOTO_TYPES[photo.mime];
}

/** Puts each photo's Drive link in its cell. links[i] belongs to sub.photos[i]. */
function applyPhotoLinks(sub, links) {
  sub.photos.forEach(function (ph, i) {
    sub.tabs.forEach(function (tab) { if (tab.name === ph.tab) tab.rows[ph.row][ph.question] = links[i]; });
  });
}

/** Existing headers kept exactly as they are; wanted columns that are missing are added at the end. */
function planColumns(existingHeaders, wanted) {
  var have = {}, added = [];
  existingHeaders.forEach(function (h) { have[String(h).trim()] = 1; });
  wanted.forEach(function (w) { if (!have[w]) { have[w] = 1; added.push(w); } });
  return { headers: existingHeaders.concat(added), added: added };
}

function cellOut_(v) {
  return v === undefined || v === null ? '' : v;
}

/**
 * Works out what to write to one tab. `existing` is null for a tab that is not there yet, else
 * { headers, keyRows } with keyRows holding the first key.length cells of every data row.
 * Returns { error } or { name, headers, existingCols, added, rows, skipped }.
 */
function planTab(tab, existing, stamps) {
  var n = tab.key.length;
  var wanted = tab.columns.slice();
  if (stamps) STAMP_COLS.forEach(function (c) { if (wanted.indexOf(c) < 0) wanted.push(c); });
  var existingHeaders = existing && existing.headers ? existing.headers.map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); }) : [];
  if (existingHeaders.length) {
    for (var i = 0; i < n; i++) {
      if (existingHeaders[i] !== tab.key[i]) {
        return { error: 'layout_mismatch', message: 'The tab "' + tab.name + '" does not start with ' + tab.key.join(', ') + '. Its columns have been rearranged by hand.' };
      }
    }
  }
  var cols = planColumns(existingHeaders, wanted);
  var seen = {};
  ((existing && existing.keyRows) || []).forEach(function (r) { seen[keyOf_(r.slice(0, n))] = 1; });
  var rows = [], skipped = 0;
  tab.rows.forEach(function (row) {
    var k = keyOf_(tab.key.map(function (c) { return row[c]; }));
    if (seen[k]) { skipped++; return; }
    seen[k] = 1;
    rows.push(cols.headers.map(function (h) {
      if (stamps && stamps.hasOwnProperty(h)) return stamps[h];
      return Object.prototype.hasOwnProperty.call(row, h) ? cellOut_(row[h]) : '';
    }));
  });
  return { name: tab.name, headers: cols.headers, existingCols: existingHeaders.length, added: existingHeaders.length ? cols.added : [], rows: rows, skipped: skipped };
}

function makeStamps_(now, person) {
  var o = {};
  o[STAMP_SUBMITTED_BY] = person.name;
  o[STAMP_RECEIVED] = new Date(now).toISOString();
  o[STAMP_RECEIVED_IST] = istDateKey(now);
  return o;
}

// ======================================================================================
// 2. dispatch - the request flow with every outside effect injected
// ======================================================================================

function authorise_(body, deps) {
  return verifyToken_(body.token, parsePeople(deps.readPeopleValues()), parseProjects(deps.readProjectsValues()),
    deps.now(), deps.sha256hex, deps.hmacHex, deps.secret);
}

function doOpen_(body, deps) {
  var now = deps.now();
  var fails = pruneFailures_(deps.getFailures ? deps.getFailures() : [], now);
  if (fails.length >= FAIL_LIMIT) {
    return fail_('too_many_attempts', 'Too many wrong codes just now. Wait a few minutes and try again.', true, FAIL_PAUSE_S);
  }
  var hit = findPerson(parsePeople(deps.readPeopleValues()), parseProjects(deps.readProjectsValues()), body.code, deps.sha256hex, deps.tagOf);
  if (!hit) {
    if (deps.addFailure) deps.addFailure(now);
    return refused_();
  }
  return {
    ok: true, project: hit.project.name, person: hit.person.name,
    token: signToken_(hit.person, now, deps.sha256hex, deps.hmacHex, deps.secret),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    ttl_s: SESSION_TTL_MS / 1000
  };
}

function doForms_(body, deps) {
  var auth = authorise_(body, deps);
  if (!auth) return sessionExpired_();
  var parsed = parseSpecFiles(deps.listSpecFiles(auth.project));
  return { ok: true, project: auth.project.name, person: auth.person.name, forms: parsed.forms, skipped: parsed.skipped };
}

function doSubmit_(body, deps) {
  var auth = authorise_(body, deps);
  if (!auth) return sessionExpired_();
  var project = auth.project, person = auth.person;
  var v = validateSubmission(body);
  if (!v.ok) return fail_(v.error, v.message, false);
  var sub = v.sub;

  // A replay needs no photo uploads: look before uploading (the check is repeated under the lock).
  if (sub.photos.length) {
    var pre = deps.readTab(project, sub.main.name, 1);
    var already = planTab(sub.main, pre, makeStamps_(deps.now(), person));
    if (!already.error && already.skipped === 1) return { ok: true, status: 'duplicate', uuid: sub.uuid };
  }

  var links = sub.photos.map(function (ph) {
    return deps.savePhoto(project, photoFileName(sub.uuid, ph), ph.mime, ph.data_base64);
  });
  applyPhotoLinks(sub, links);

  return deps.withLock(function () {
    var now = deps.now();
    var stamps = makeStamps_(now, person);
    var mainPlan = planTab(sub.main, deps.readTab(project, sub.main.name, 1), stamps);
    if (mainPlan.error) return fail_(mainPlan.error, mainPlan.message, false);
    if (mainPlan.skipped === 1) return { ok: true, status: 'duplicate', uuid: sub.uuid };

    var plans = [];
    for (var i = 0; i < sub.tabs.length; i++) {
      var tab = sub.tabs[i];
      if (tab === sub.main || !tab.rows.length) continue;
      var plan = planTab(tab, deps.readTab(project, tab.name, tab.key.length), null);
      if (plan.error) return fail_(plan.error, plan.message, false);
      plans.push(plan);
    }
    plans.push(mainPlan);                      // the main row goes LAST: its presence proves the rest landed

    var appended = {}, addedCols = {};
    plans.forEach(function (plan) {
      if (plan.rows.length || plan.added.length) deps.writeTab(project, plan.name, plan);
      appended[plan.name] = plan.rows.length;
      if (plan.added.length) addedCols[plan.name] = plan.added;
    });
    return {
      ok: true, status: 'created', uuid: sub.uuid, received_at: stamps[STAMP_RECEIVED],
      appended: appended, added_columns: addedCols
    };
  });
}

/** Every request ends here. Never throws; never puts internals in a reply. */
function dispatch(body, deps) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail_('bad_request', 'The request must be a JSON object.', false);
    if (body.action === 'open') return doOpen_(body, deps);
    if (body.action === 'forms') return doForms_(body, deps);
    if (body.action === 'submit') return doSubmit_(body, deps);
    return fail_('bad_request', 'Unknown action.', false);
  } catch (e) {
    if (e && e.busy) return fail_('busy', 'The server is busy. Try again in a minute.', true, 60);
    if (deps.log) { try { deps.log(e); } catch (ignore) { /* logging must never break the reply */ } }
    return fail_('server_error', 'The server hit a problem. Nothing was lost; try again later.', true, 120);
  }
}

// ======================================================================================
// 3. GOOGLE GLUE (runs only in Google; not covered by the Node tests)
// ======================================================================================

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
}

function sha256hex_(s) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

function hmacHex_(s, key) {
  return hex_(Utilities.computeHmacSha256Signature(s, key));
}

function secret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TOKEN_SECRET');
  if (!s) {
    s = sha256hex_(Utilities.getUuid() + Utilities.getUuid() + Date.now());
    props.setProperty('TOKEN_SECRET', s);
  }
  return s;
}

function newSalt_() {
  return sha256hex_(Utilities.getUuid() + Date.now()).slice(0, 16);
}

function randomBytes_(count) {
  var out = [];
  while (out.length < count) {
    var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Math.random() + Date.now(), Utilities.Charset.UTF_8);
    d.forEach(function (b) { out.push(b < 0 ? b + 256 : b); });
  }
  return out;
}

function tabValues_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(1, 1, sh.getLastRow(), Math.max(sh.getLastColumn(), 5)).getValues();
}

/** Short keyed tag of a code, stored beside its hash so a sign-in hashes one person, not all of them. */
function lookupTag_(normalizedCode) {
  var props = PropertiesService.getScriptProperties();
  var k = props.getProperty('LOOKUP_KEY');
  if (!k) { k = sha256hex_(Utilities.getUuid() + Utilities.getUuid() + Date.now()); props.setProperty('LOOKUP_KEY', k); }
  return hmacHex_(normalizedCode, k).slice(0, 16);
}

function storeCode_(code) {
  return makeStoredCode(code, newSalt_(), sha256hex_, HASH_ROUNDS, lookupTag_(normalizeCode_(code)));
}

function realDeps_() {
  var books = {};
  function book(id) { return books[id] || (books[id] = SpreadsheetApp.openById(id)); }
  function photoFolder(project) {
    var root = DriveApp.getFolderById(project.folderId);
    var it = root.getFoldersByName('photos');
    return it.hasNext() ? it.next() : root.createFolder('photos');
  }
  var cache = CacheService.getScriptCache();
  return {
    now: function () { return Date.now(); },
    readProjectsValues: function () { return tabValues_(PROJECTS_TAB); },
    readPeopleValues: function () { return tabValues_(PEOPLE_TAB); },
    tagOf: lookupTag_,
    sha256hex: sha256hex_,
    hmacHex: hmacHex_,
    secret: secret_(),
    log: function (e) { console.error(String(e && e.stack ? e.stack : e)); },

    listSpecFiles: function (project) {
      var out = [], it = DriveApp.getFolderById(project.folderId).searchFiles("title contains '.spec.json' and trashed = false");
      while (it.hasNext()) {
        var f = it.next();
        out.push({ name: f.getName(), text: f.getBlob().getDataAsString('UTF-8') });
      }
      return out;
    },

    readTab: function (project, name, nKeyCols) {
      var sh = book(project.spreadsheetId).getSheetByName(name);
      if (!sh || sh.getLastColumn() < 1) return null;
      var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      var keyRows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, nKeyCols).getValues() : [];
      return { headers: headers, keyRows: keyRows };
    },

    writeTab: function (project, name, plan) {
      var ss = book(project.spreadsheetId);
      var sh = ss.getSheetByName(name);
      if (!sh) { sh = ss.insertSheet(name); sh.setFrozenRows(1); }
      var width = plan.headers.length;
      if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
      if (width > plan.existingCols) {                       // new columns: only the new header cells are written
        sh.getRange(1, plan.existingCols + 1, 1, width - plan.existingCols)
          .setNumberFormat('@').setValues([plan.headers.slice(plan.existingCols)]);
      }
      if (plan.rows.length) {
        var first = Math.max(sh.getLastRow(), 1) + 1;
        var need = first + plan.rows.length - 1;
        if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
        var range = sh.getRange(first, 1, plan.rows.length, width);
        range.setNumberFormat('@');                          // text: keeps 0987... and anything starting with = as plain text
        range.setValues(plan.rows);
      }
      SpreadsheetApp.flush();                                // the next check-before-append must see this row
    },

    savePhoto: function (project, filename, mime, base64) {
      var folder = photoFolder(project);
      var existing = folder.getFilesByName(filename);       // a replay finds the file it already saved
      if (existing.hasNext()) return existing.next().getUrl();
      var blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, filename);
      return folder.createFile(blob).getUrl();
    },

    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) { var e = new Error('lock busy'); e.busy = true; throw e; }
      try { return fn(); } finally { lock.releaseLock(); }
    },

    getFailures: function () {
      try { return JSON.parse(cache.get('open_fails') || '[]'); } catch (e) { return []; }
    },
    addFailure: function (t) {
      var list = pruneFailures_(this.getFailures(), t);
      list.push(t);
      cache.put('open_fails', JSON.stringify(list.slice(-200)), 900);
    }
  };
}

/** The phone calls this with a POST whose body is JSON text. */
function doPost(e) {
  var out;
  try {
    var parsed = parseBody(e && e.postData ? e.postData.contents : '');
    out = parsed.ok ? dispatch(parsed.body, realDeps_()) : parsed.error;
  } catch (err) {
    console.error(String(err && err.stack ? err.stack : err));
    out = fail_('server_error', 'The server hit a problem. Nothing was lost; try again later.', true, 120);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ---- Projects tab, menu and code helpers ---------------------------------------------------------

/** Run once. Creates the Projects and People tabs with their headings and an example row each, if not there. */
function setupProjects() {
  secret_();                                                // make the signing secret now
  lookupTag_('x');                                          // and the lookup key
  var ss = SpreadsheetApp.getActive();
  var made = [];
  if (!ss.getSheetByName(PROJECTS_TAB)) {
    var pr = ss.insertSheet(PROJECTS_TAB);
    pr.getRange(1, 1, 1, PROJECT_HEADERS.length).setValues([PROJECT_HEADERS]).setFontWeight('bold');
    pr.getRange(2, 1, 1, PROJECT_HEADERS.length).setValues([exampleProjectRow()]);
    pr.setFrozenRows(1);
    pr.setColumnWidth(1, 220); pr.setColumnWidth(2, 260); pr.setColumnWidth(3, 260);
    made.push(PROJECTS_TAB);
  }
  if (!ss.getSheetByName(PEOPLE_TAB)) {
    var pe = ss.insertSheet(PEOPLE_TAB);
    pe.getRange(1, 1, 1, PEOPLE_HEADERS.length).setValues([PEOPLE_HEADERS]).setFontWeight('bold');
    pe.getRange('B:B').setNumberFormat('@');
    pe.getRange(2, 1, 1, PEOPLE_HEADERS.length).setValues([examplePersonRow()]);
    pe.setFrozenRows(1);
    pe.setColumnWidth(1, 220); pe.setColumnWidth(2, 380); pe.setColumnWidth(3, 260);
    pe.getRange('D2:D500').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['yes', 'no'], true).build());
    pe.getRange('B1').setNote('Do not type codes here. Use the menu "Evidence Action survey > Set or change the code for the selected row". Codes are shown once and cannot be recovered.');
    made.push(PEOPLE_TAB);
  }
  SpreadsheetApp.getUi().alert(made.length
    ? 'Created: ' + made.join(', ') + '. Fill Projects (one row per project), then People (one row per person: name, project name exactly as on the Projects tab, Active = yes), then set each person\'s code from the menu.'
    : 'The Projects and People tabs already exist. Nothing was changed.');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Evidence Action survey')
    .addItem('Set up the Projects and People tabs', 'setupProjects')
    .addItem('Set or change the code for the selected row', 'setCodeForSelectedRow')
    .addItem('Check the Projects and People tabs', 'checkProjects')
    .addToUi();
}

function codeColumn_(sh) {
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 5)).getValues()[0];
  for (var i = 0; i < head.length; i++) if (hdrKey_(head[i]) === 'accesscode') return i + 1;
  return 0;
}

/**
 * Safety net: a code typed straight into the People tab's Access code column is replaced by its
 * hash at once. Prefer the menu helper: Sheets version history keeps what was typed before this ran.
 */
function onEdit(e) {
  try {
    var r = e.range, sh = r.getSheet();
    if (sh.getName() !== PEOPLE_TAB) return;
    var col = codeColumn_(sh);
    if (!col || col < r.getColumn() || col > r.getLastColumn()) return;
    for (var row = Math.max(r.getRow(), 2); row <= r.getLastRow(); row++) {
      var cell = sh.getRange(row, col), v = cell.getValue();
      if (v === '' || v === null || isStoredCode(v)) continue;
      if (codeProblem(v)) { cell.setNote(codeProblem(v) + ' Retype a longer code.'); continue; }
      cell.setNumberFormat('@').setValue(storeCode_(String(v))).clearNote();
    }
  } catch (err) { console.error(String(err)); }
}

/** Menu: set or change the code of the person on the selected People row. Empty box = a generated code, shown once. */
function setCodeForSelectedRow() {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSheet();
  var row = sh.getActiveCell().getRow();
  if (sh.getName() !== PEOPLE_TAB || row < 2) { ui.alert('Click a person row on the People tab first (not the header row).'); return; }
  var col = codeColumn_(sh);
  if (!col) { ui.alert('The People tab has no "Access code" column.'); return; }
  var who = String(sh.getRange(row, 1).getValue() || 'row ' + row);
  var ans = ui.prompt('New access code for ' + who, 'Leave empty to have a strong code made for you (recommended). Or type one of at least 6 letters or digits.', ui.ButtonSet.OK_CANCEL);
  if (ans.getSelectedButton() !== ui.Button.OK) return;
  var typed = ans.getResponseText().trim(), shown = '';
  if (!typed) { typed = generateCode(randomBytes_(64), 8); shown = typed; }
  var problem = codeProblem(typed);
  if (problem) { ui.alert(problem); return; }
  sh.getRange(row, col).setNumberFormat('@').setValue(storeCode_(typed));
  ui.alert(shown
    ? 'The new code for ' + who + ' is:\n\n' + shown + '\n\nWrite it down now and give it to them. It cannot be shown again. Their old code stops working.'
    : 'The code for ' + who + ' has been changed. Their old code stops working.');
}

/** Menu: tells the owner, in plain words, what is wrong with the two tabs. */
function checkProjects() {
  var ui = SpreadsheetApp.getUi();
  if (!SpreadsheetApp.getActive().getSheetByName(PROJECTS_TAB) || !SpreadsheetApp.getActive().getSheetByName(PEOPLE_TAB)) {
    ui.alert('The Projects or People tab is missing. Run "Set up the Projects and People tabs".'); return;
  }
  var projects = parseProjects(tabValues_(PROJECTS_TAB));
  var people = parsePeople(tabValues_(PEOPLE_TAB));
  var problems = projectProblems(projects, people);
  var live = people.filter(function (p) { return p.active && isStoredCode(p.stored) && resolveProject_(projects, p.projectName); }).length;
  ui.alert((problems.length ? 'Please fix:\n\n' + problems.join('\n\n') + '\n\n' : 'No problems found.\n\n') + live + ' person(s) can open a project from a phone right now.');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    makeStoredCode: makeStoredCode, verifyCode: verifyCode, isStoredCode: isStoredCode, generateCode: generateCode,
    codeProblem: codeProblem, parseProjects: parseProjects, parsePeople: parsePeople, projectProblems: projectProblems, findPerson: findPerson,
    downloadPageAllowed: downloadPageAllowed, parseSpecFiles: parseSpecFiles, parseBody: parseBody,
    validateSubmission: validateSubmission, planTab: planTab, planColumns: planColumns, dispatch: dispatch,
    PROJECT_HEADERS: PROJECT_HEADERS, PEOPLE_HEADERS: PEOPLE_HEADERS, exampleProjectRow: exampleProjectRow, examplePersonRow: examplePersonRow
  };
}
