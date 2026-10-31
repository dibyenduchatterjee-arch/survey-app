// The Download CSV control: start an export job, poll it honestly, then hand over the file.
//
// SECURITY: the CSV is fetched only through `api` (authFetch, so a signed-in session
// is required, and our own RBAC decides) after the job reports done. The Drive link is secondary. This page never constructs a
// Drive link itself and never offers a link that works without a session on our side. Who can
// then open the Drive file is decided by Drive's own sharing, which is why the server must
// keep the export folder private; see the task report.
import { h, clear, sleep } from './ui.js';

export const POLL_MS = 2000;
export const GIVE_UP_MS = 10 * 60 * 1000;

const STAGE = {
  pending: 'Waiting to start',
  running: 'Building the CSV files and uploading them',
};

// Only ever send the browser to Google Drive over https. The URL came from the server, but
// it is checked anyway: a link to anywhere else is shown as text, not made clickable.
export function safeDriveUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'drive.google.com' ? u.href : null;
  } catch { return null; }
}

// Hands the bytes to the browser as a normal download, then frees the object URL.
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The words for a date range, the same shape the server uses in its own messages.
export function rangeText(from, to) {
  if (from && to) return `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `up to ${to}`;
  return 'all dates';
}

// What the finished job covered, read from the job itself (the server's record of what it did),
// so a downloaded file always arrives with the context to tell it from another one.
function summary(job, formId) {
  const count = job.row_count != null ? `${job.row_count} submission${job.row_count === 1 ? '' : 's'}` : null;
  const item = (label, value) => h('li', {}, h('strong', { text: label + ': ' }), value);
  return h('ul', { class: 'export-summary' },
    job.project_name ? item('Project', `${job.project_name} (all forms)`) : item('Form', job.form_id || formId),
    item('Dates', job.date_from || job.date_to ? `${rangeText(job.date_from, job.date_to)} (UTC days)` : 'all dates'),
    count ? item('Submissions', count) : null);
}

// `target` is one form id, or a function returning the request body (it may throw an Error whose
// message is shown, for input that is wrong before anything is sent).
// `opts.pollMs`/`opts.giveUpMs`/`opts.now`/`opts.save` exist for tests.
export function exportControl(target, { api, pollMs = POLL_MS, giveUpMs = GIVE_UP_MS, now = () => Date.now(), save = saveBlob } = {}) {
  const formId = typeof target === 'string' ? target : null;
  const request = typeof target === 'function' ? target : () => ({ form_id: target });
  const status = h('p', { class: 'export-status', role: 'status', 'aria-live': 'polite' });
  const bar = h('progress', { class: 'export-bar', hidden: true });
  const result = h('div', { class: 'export-result' });
  const button = h('button', { class: 'primary download-csv', type: 'button', text: 'Download CSV' });
  const box = h('div', { class: 'export-control', 'data-form': formId }, button, bar, status, result);
  let busy = false;

  const fail = text => {
    bar.hidden = true;
    clear(status);
    clear(result).append(h('p', { class: 'msg bad export-error', role: 'alert' },
      h('strong', { text: 'The export did not work. ' }), text));
    busy = false;
    button.disabled = false;
    button.textContent = 'Try again';
  };

  async function run() {
    if (busy) return;
    let body;
    try { body = request(); } catch (e) { return fail(e.message); }
    busy = true;
    button.disabled = true;
    clear(result);
    bar.hidden = false;
    bar.removeAttribute('value'); // indeterminate: the server reports a stage, not a percentage
    status.textContent = 'Starting the export...';
    const t0 = now();
    let job;
    try {
      job = await api.post('/api/exports', body);
    } catch (e) { return fail(e.message); }
    const id = job.job_id;
    let shown = '';
    for (;;) {
      let j;
      try { j = await api.get(`/api/exports/${id}`); } catch (e) { return fail(e.message); }
      if (j.status === 'failed') return fail(j.error || 'The server did not say why.');
      if (j.status === 'done') {
        let file;
        try { file = await api.file(`/api/exports/${id}/download`); } catch (e) { return fail(e.message); }
        const name = file.filename || `${formId || 'export'}.csv`;
        try { save(file.blob, name); } catch (e) { return fail('The file arrived but the browser would not save it: ' + e.message); }
        return done(j, name);
      }
      const secs = Math.round((now() - t0) / 1000);
      const text = `${STAGE[j.status] || j.status}... ${secs}s`;
      if (text !== shown) { status.textContent = text; shown = text; }
      if (now() - t0 > giveUpMs) {
        return fail('Still not finished after ' + Math.round(giveUpMs / 60000) + ' minutes. The job (number ' + id + ') may still complete; try again later rather than starting several.');
      }
      await sleep(pollMs);
    }
  }

  function done(job, name) {
    bar.hidden = true;
    clear(status);
    const url = safeDriveUrl(job.url);
    clear(result).append(h('p', { class: 'msg ok' },
      h('strong', { text: 'Downloaded ' }), h('code', { class: 'saved-name', text: name }), '. ',
      url ? h('span', { class: 'hint' }, ' Also saved to Drive: ', h('a', { class: 'drive-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'open copy' })) : null),
      summary(job, formId),
      job.message ? h('p', { class: 'msg warn export-empty', role: 'status', text: job.message }) : null);
    busy = false;
    button.disabled = false;
    button.textContent = 'Download again';
  }

  button.addEventListener('click', run);
  box.run = run;
  return box;
}

export async function mountExports(root, ctx) {
  const { api } = ctx;
  clear(root);
  root.append(h('h1', { text: 'Exports' }),
    h('p', { class: 'hint', text: 'Choose a project, and a form if you want just one, then the dates. Leave both dates empty to get everything received so far.' }));
  let projects;
  try { projects = await api.get('/api/projects'); } catch (e) {
    root.append(h('p', { class: 'msg bad', role: 'alert', text: e.message }));
    return;
  }
  if (!projects.length) {
    root.append(h('p', { class: 'msg', text: 'You have no projects, so there is nothing to export yet.' }));
    return;
  }
  const project = h('select', { id: 'export-project' }, projects.map(p => h('option', { value: p.id, text: p.name })));
  const form = h('select', { id: 'export-form' });
  const from = h('input', { type: 'date', id: 'export-from' });
  const to = h('input', { type: 'date', id: 'export-to' });
  const formNote = h('p', { class: 'msg bad', role: 'alert', hidden: true });

  let latest = 0;
  async function loadForms() {
    const mine = ++latest;
    const id = project.value;
    clear(form).append(h('option', { value: '', text: 'All forms in this project' }));
    formNote.hidden = true;
    let detail;
    try { detail = await api.get(`/api/projects/${id}`); } catch (e) {
      if (mine === latest) { formNote.textContent = e.message; formNote.hidden = false; }
      return;
    }
    if (mine !== latest) return; // the person has already picked another project
    for (const f of detail.forms) form.append(h('option', { value: f.form_id, text: `${f.title} (${f.form_id})` }));
  }
  project.addEventListener('change', loadForms);

  // Exactly what was chosen: a form replaces the project (the server refuses both), an empty
  // date is left out, and a backwards range is caught here before anything is sent.
  const request = () => {
    if (from.value && to.value && to.value < from.value) {
      throw new Error('The "to" date is earlier than the "from" date. Change one of them.');
    }
    const body = form.value ? { form_id: form.value } : { project_id: Number(project.value) };
    if (from.value) body.date_from = from.value;
    if (to.value) body.date_to = to.value;
    return body;
  };

  const field = (label, control, id, hint) => h('div', { class: 'export-field' },
    h('label', { for: id, text: label }), control, hint ? h('p', { class: 'hint', text: hint }) : null);
  root.append(h('section', { class: 'card export-form' },
    field('Project', project, 'export-project'),
    field('Form', form, 'export-form', 'Optional. Leave it on "All forms" to export every form in the project, one set of files per form.'),
    field('From date', from, 'export-from'),
    field('To date', to, 'export-to', 'Both dates are included. Days are UTC, the same clock as the received_at column in the file. Empty means everything.'),
    formNote,
    exportControl(request, { api, pollMs: ctx.pollMs, save: ctx.save })));
  await loadForms();
}
