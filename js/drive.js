// Thin wrapper over the Google Drive v3 and Sheets v4 REST APIs.
//
// Failure policy: transient errors (network, 429, 5xx) are retried with exponential backoff
// and jitter; any other 4xx is permanent. When retries run out, or the error is permanent,
// a DriveError is THROWN. Nothing is swallowed, so the caller (sync) can keep the submission.
//
// Everything takes injectable fetchImpl / getToken / sleep so tests never touch the network.

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const FOLDER = 'application/vnd.google-apps.folder';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

export class DriveError extends Error {
  constructor(message, { status = 0, retryable = false, body, cause } = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
    if (cause) this.cause = cause;
  }
}

// Escape for a Drive `q` string literal.
const qs = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const enc = encodeURIComponent;

export function createDrive({
  fetchImpl,
  getToken,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  maxRetries = 5,
  baseDelayMs = 500,
  maxDelayMs = 30000,
  jitter = () => 0.5 + Math.random() * 0.5, // 0.5x..1x, so 76 clients do not retry in lockstep
} = {}) {
  const doFetch = (...a) => (fetchImpl || globalThis.fetch).apply(globalThis, a);

  async function request(url, { method = 'GET', headers = {}, body, raw = false } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const ra = lastErr && lastErr.retryAfterMs;
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * jitter();
        await sleep(ra ? Math.max(ra, backoff) : backoff);
      }
      let res;
      try {
        const token = await getToken();
        res = await doFetch(url, { method, headers: { Authorization: 'Bearer ' + token, ...headers }, body });
      } catch (e) {
        if (e && e.code === 'needs_signin') throw e;           // not a network problem
        lastErr = new DriveError('Network error: ' + (e && e.message), { retryable: true, cause: e });
        continue;
      }
      if (res.ok) return raw ? res : res.status === 204 ? {} : res.json();
      let text = '';
      try { text = await res.text(); } catch { /* ignore */ }
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new DriveError(`Google API ${res.status} for ${method} ${url.split('?')[0]}: ${text.slice(0, 300)}`, { status: res.status, retryable, body: text });
      const ra = res.headers && res.headers.get && Number(res.headers.get('Retry-After'));
      if (ra) lastErr.retryAfterMs = ra * 1000;
      if (!retryable) throw lastErr;
    }
    throw lastErr;
  }

  const json = (url, method, obj) => request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  async function listAll(q, fields) {
    const out = [];
    let pageToken;
    do {
      const p = new URLSearchParams({ q, fields: `nextPageToken, files(${fields})`, pageSize: '1000', orderBy: 'name' });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await request(`${DRIVE}/files?${p}`);
      out.push(...(r.files || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  const listProjects = rootFolderId =>
    listAll(`'${qs(rootFolderId)}' in parents and mimeType = '${FOLDER}' and trashed = false`, 'id,name');

  async function listForms(projectFolderId) {
    const files = await listAll(`'${qs(projectFolderId)}' in parents and trashed = false`, 'id,name,modifiedTime');
    return files.filter(x => /\.spec\.json$/i.test(x.name));
  }

  const readSpec = fileId => request(`${DRIVE}/files/${enc(fileId)}?alt=media&supportsAllDrives=true`);

  async function uploadMedia(projectFolderId, name, blob) {
    const boundary = 'evac' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const meta = JSON.stringify({ name, parents: [projectFolderId] });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    const r = await request(`${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    return { id: r.id, link: r.webViewLink };
  }

  async function findOrCreateSpreadsheet(projectFolderId, name) {
    const found = await listAll(`'${qs(projectFolderId)}' in parents and name = '${qs(name)}' and mimeType = '${SHEET_MIME}' and trashed = false`, 'id,name');
    if (found.length) return found[0].id;
    const r = await json(`${DRIVE}/files?fields=id&supportsAllDrives=true`, 'POST', { name, mimeType: SHEET_MIME, parents: [projectFolderId] });
    return r.id;
  }

  async function ensureTab(spreadsheetId, tabName, headerRow) {
    const meta = await request(`${SHEETS}/${enc(spreadsheetId)}?fields=sheets.properties.title`);
    if ((meta.sheets || []).some(s => s.properties && s.properties.title === tabName)) return;
    try {
      await json(`${SHEETS}/${enc(spreadsheetId)}:batchUpdate`, 'POST', { requests: [{ addSheet: { properties: { title: tabName } } }] });
    } catch (e) {
      // Another phone created the tab between our check and our create: it also writes the header.
      if (e.status === 400 && /already exists/i.test(e.body || e.message)) return;
      throw e;
    }
    await json(`${SHEETS}/${enc(spreadsheetId)}/values/${enc(tabName + '!A1')}?valueInputOption=RAW`, 'PUT', { values: [headerRow] });
  }

  async function appendRow(spreadsheetId, tabName, values) {
    let row = values;
    if (!Array.isArray(values)) {
      const h = await request(`${SHEETS}/${enc(spreadsheetId)}/values/${enc(tabName + '!1:1')}`);
      const header = (h.values && h.values[0]) || [];
      if (!header.length) throw new DriveError(`Tab "${tabName}" has no header row; call ensureTab first.`, { status: 0, retryable: false });
      row = header.map(k => (values[k] === undefined || values[k] === null ? '' : values[k]));
    }
    // RAW: stored literally, so an answer beginning with "=" is never evaluated as a formula.
    return json(`${SHEETS}/${enc(spreadsheetId)}/values/${enc(tabName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, 'POST', { values: [row] });
  }

  return { listProjects, listForms, readSpec, uploadMedia, findOrCreateSpreadsheet, ensureTab, appendRow };
}

// Default instance: real fetch, token from googleauth.js. Built lazily.
let shared;
const inst = () => (shared ||= createDrive({ getToken: async () => (await import('./googleauth.js')).getAccessToken() }));
export const listProjects = a => inst().listProjects(a);
export const listForms = a => inst().listForms(a);
export const readSpec = a => inst().readSpec(a);
export const uploadMedia = (...a) => inst().uploadMedia(...a);
export const findOrCreateSpreadsheet = (...a) => inst().findOrCreateSpreadsheet(...a);
export const ensureTab = (...a) => inst().ensureTab(...a);
export const appendRow = (...a) => inst().appendRow(...a);
