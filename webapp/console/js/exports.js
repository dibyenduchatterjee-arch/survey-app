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

// Control for one form. `opts.pollMs`/`opts.giveUpMs`/`opts.now` exist for tests.
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

export function exportControl(formId, { api, pollMs = POLL_MS, giveUpMs = GIVE_UP_MS, now = () => Date.now(), save = saveBlob } = {}) {
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
    busy = true;
    button.disabled = true;
    clear(result);
    bar.hidden = false;
    bar.removeAttribute('value'); // indeterminate: the server reports a stage, not a percentage
    status.textContent = 'Starting the export...';
    const t0 = now();
    let job;
    try {
      job = await api.post('/api/exports', { form_id: formId });
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
        const name = file.filename || `${formId}.csv`;
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
    const rows = job.row_count != null ? `${job.row_count} submission${job.row_count === 1 ? '' : 's'}. ` : '';
    clear(result).append(h('p', { class: 'msg ok' },
      h('strong', { text: 'Downloaded ' }), h('code', { class: 'saved-name', text: name }), '. ', rows,
      url ? h('span', { class: 'hint' }, ' Also saved to Drive: ', h('a', { class: 'drive-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'open copy' })) : null));
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
    h('p', { class: 'hint', text: 'Pick a project and download its data as CSV. The file is built from every submission received so far.' }));
  const list = h('div', { class: 'export-list' });
  root.append(list);
  let forms;
  try { forms = await api.get('/api/forms'); } catch (e) {
    list.append(h('p', { class: 'msg bad', role: 'alert', text: e.message }));
    return;
  }
  if (!forms.length) list.append(h('p', { text: 'No published forms yet.' }));
  for (const f of forms) {
    list.append(h('section', { class: 'card export-row' },
      h('h2', { lang: 'hi', text: f.title }), h('p', { class: 'hint' }, h('code', { text: f.form_id })),
      exportControl(f.form_id, { api, pollMs: ctx.pollMs })));
  }
}
