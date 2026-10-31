// Submission list (filter by form and status, paginate) and the detail view.
import { h, clear, fmtDate } from './ui.js';

export const PAGE_SIZE = 25;
export const STATUSES = ['received', 'flagged', 'approved', 'rejected'];

// The two kinds of failure need different people to act, so they look different.
//   error                -> OUR form is broken (a bad expression in the XLSForm). The
//                           enumerator did nothing wrong. Fix the form, upload a new version.
//   required / constraint-> the data entered is wrong or missing. Go back to the enumerator.
export function failureCard(f) {
  const broken = f.rule === 'error';
  return h('li', { class: 'failure ' + (broken ? 'failure-form-broken' : 'failure-data'), 'data-rule': f.rule },
    h('span', { class: 'badge ' + (broken ? 'bad' : 'warn'), text: broken ? 'FORM PROBLEM' : f.rule === 'required' ? 'MISSING ANSWER' : 'ANSWER OUT OF RANGE' }),
    ' ', h('code', { text: f.question }),
    f.message ? h('p', { class: 'failure-message', text: f.message }) : null,
    h('p', { class: 'hint failure-remedy', text: broken
      ? 'The form itself failed to evaluate this question. The enumerator is not at fault; fix the XLSForm and publish a new version.'
      : f.rule === 'required'
        ? 'The enumerator left a required question empty. Ask her to correct it and resubmit.'
        : 'The answer broke the rule set for this question. Ask the enumerator to check the answer.' }));
}

export function failureList(failures) {
  if (!failures || !failures.length) return null;
  // Form problems first: they affect every enumerator, not just this one.
  const sorted = [...failures].sort((a, b) => (b.rule === 'error') - (a.rule === 'error'));
  return h('ul', { class: 'failures' }, sorted.map(failureCard));
}

export async function mountSubmissions(root, ctx) {
  const { api } = ctx;
  const params = ctx.params || new URLSearchParams();
  const state = { form: params.get('form') || '', status: params.get('status') || '', page: Number(params.get('page')) || 1 };
  clear(root);
  const formSel = h('select', { id: 'form-filter', 'aria-label': 'Form' }, h('option', { value: '', text: 'All forms' }));
  const statusSel = h('select', { id: 'status-filter', 'aria-label': 'Status' },
    h('option', { value: '', text: 'Any status' }), STATUSES.map(s => h('option', { value: s, text: s })));
  const table = h('div', { class: 'sub-list' });
  const pager = h('div', { class: 'pager' });
  const detail = h('div', { class: 'detail', 'aria-live': 'polite' });
  root.append(h('h1', { text: 'Submissions' }), h('div', { class: 'toolbar' }, formSel, statusSel), table, pager, detail);

  try {
    for (const f of await api.get('/api/forms')) formSel.append(h('option', { value: f.form_id, text: `${f.title} (${f.form_id})` }));
  } catch { /* the list below reports the real problem */ }
  formSel.value = state.form;
  statusSel.value = state.status;
  formSel.addEventListener('change', () => { state.form = formSel.value; state.page = 1; load(); });
  statusSel.addEventListener('change', () => { state.status = statusSel.value; state.page = 1; load(); });

  async function load() {
    clear(table);
    let data;
    try {
      data = await api.get('/api/submissions', { form_id: state.form, status: state.status, page: state.page, page_size: PAGE_SIZE });
    } catch (e) { table.append(h('p', { class: 'msg bad', role: 'alert', text: e.message })); clear(pager); return; }
    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    if (!data.items.length) table.append(h('p', { class: 'msg', text: 'No submissions match.' }));
    else {
      table.append(h('table', { class: 'subs' },
        h('thead', {}, h('tr', {}, ['Received', 'Form', 'Status', 'Problems', ''].map(t => h('th', { text: t })))),
        h('tbody', {}, data.items.map(s => h('tr', { 'data-uuid': s.uuid },
          h('td', { text: fmtDate(s.received_at) }),
          h('td', {}, h('code', { text: s.form_id }), ' v', s.version),
          h('td', {}, h('span', { class: 'badge status-' + s.status, text: s.status })),
          h('td', { text: s.failure_count ? String(s.failure_count) : '' }),
          h('td', {}, h('button', { class: 'open', type: 'button', text: 'Open', onclick: () => openDetail(s.uuid) })))))));
    }
    clear(pager).append(
      h('button', { class: 'prev', type: 'button', text: 'Previous', disabled: state.page <= 1, onclick: () => { state.page--; load(); } }),
      h('span', { class: 'page-info', text: ` Page ${data.page} of ${pages} · ${data.total} submissions ` }),
      h('button', { class: 'next', type: 'button', text: 'Next', disabled: state.page >= pages, onclick: () => { state.page++; load(); } }));
  }

  async function openDetail(uuid) {
    clear(detail).append(h('p', { text: 'Loading...' }));
    try { renderDetail(detail, await api.get(`/api/submissions/${encodeURIComponent(uuid)}`), api); }
    catch (e) { clear(detail).append(h('p', { class: 'msg bad', role: 'alert', text: e.message })); }
    detail.scrollIntoView && detail.scrollIntoView({ block: 'start' });
  }

  ctx.openDetail = openDetail;
  await load();
  if (params.get('uuid')) await openDetail(params.get('uuid'));
}

const show = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function renderDetail(el, s, api) {
  clear(el);
  el.append(h('h2', {}, 'Submission ', h('code', { text: s.uuid })),
    h('p', {}, h('span', { class: 'badge status-' + s.status, text: s.status }),
      ` ${s.form_id} v${s.version} · received ${fmtDate(s.received_at)}`));
  const fl = failureList(s.failures);
  if (fl) el.append(h('h3', { text: 'Why this was flagged' }), fl);
  if (s.likely_duplicates && s.likely_duplicates.length) {
    el.append(h('p', { class: 'msg warn' }, 'Possible duplicate of: ', s.likely_duplicates.map(u => h('code', { text: u + ' ' }))));
  }
  const answers = Object.entries(s.data || {});
  el.append(h('h3', { text: 'Answers' }),
    answers.length
      ? h('table', { class: 'answers' }, h('tbody', {}, answers.map(([k, v]) => h('tr', {}, h('th', {}, h('code', { text: k })), h('td', { lang: 'hi', text: show(v) })))))
      : h('p', { text: 'No answers recorded.' }));
  for (const [name, rows] of Object.entries(s.repeats || {})) {
    el.append(h('h3', { text: `${name} (${rows.length})` }),
      ...rows.map((r, i) => h('table', { class: 'answers repeat-row' }, h('caption', { text: `Row ${i + 1}` }),
        h('tbody', {}, Object.entries(r).map(([k, v]) => h('tr', {}, h('th', {}, h('code', { text: k })), h('td', { lang: 'hi', text: show(v) })))))));
  }
  if (s.gps_lat != null) el.append(h('p', { class: 'hint', text: `GPS: ${s.gps_lat}, ${s.gps_lon} (accuracy ${s.gps_accuracy ?? '?'} m)` }));
  if (s.media && s.media.length) el.append(h('h3', { text: 'Photos and files' }), mediaGallery(s, api));
}

// Photos come from GET /api/submissions/{uuid}/media/{question_name}, which does NOT exist on
// the server yet. An <img src> cannot send the bearer token, so the bytes are fetched with
// authFetch and shown from a blob URL. Until the endpoint exists every item shows the
// placeholder, which says so rather than pretending the photo is missing.
export function mediaPath(uuid, question) {
  return `/api/submissions/${encodeURIComponent(uuid)}/media/${encodeURIComponent(question)}`;
}

function mediaGallery(s, api) {
  return h('div', { class: 'media' }, s.media.map(m => {
    const box = h('figure', { class: 'media-item', 'data-question': m.question_name },
      h('figcaption', {}, h('code', { text: m.question_name }), ` · ${m.content_type} · ${Math.round(m.size / 1024)} KB`));
    const placeholder = () => box.prepend(h('div', { class: 'media-placeholder', text: 'Photo not available to view yet: the server has no media download endpoint.' }));
    if (!api || !api.blob) { placeholder(); return box; }
    api.blob(mediaPath(s.uuid, m.question_name)).then(blob => {
      const url = URL.createObjectURL(blob);
      if (m.content_type.startsWith('image/')) box.prepend(h('img', { src: url, alt: m.question_name, class: 'media-img' }));
      else if (m.content_type.startsWith('audio/')) box.prepend(h('audio', { src: url, controls: true }));
      else if (m.content_type.startsWith('video/')) box.prepend(h('video', { src: url, controls: true }));
      else box.prepend(h('a', { href: url, download: m.question_name, text: 'Download file' }));
    }).catch(placeholder);
    return box;
  }));
}
