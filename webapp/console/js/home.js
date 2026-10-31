// The project list: one row per form, current version and submission count at a glance,
// with the CSV download right there. Built for ten-plus projects: a filter box, and a
// count that loads per row so one slow answer does not hold up the rest.
import { h, clear } from './ui.js';
import { exportControl } from './exports.js';

export async function mountHome(root, ctx) {
  const { api } = ctx;
  clear(root);
  const list = h('div', { class: 'projects' });
  const search = h('input', { type: 'search', id: 'project-filter', placeholder: 'Filter projects by name or id', 'aria-label': 'Filter projects' });
  root.append(h('h1', { text: 'Projects' }), h('div', { class: 'toolbar' }, search), list);
  let forms;
  try { forms = await api.get('/api/forms'); } catch (e) {
    list.append(h('p', { class: 'msg bad', role: 'alert', text: e.message }));
    return;
  }
  if (!forms.length) { list.append(h('p', { class: 'msg', text: 'No published forms yet. Upload one under Forms.' })); return; }

  const rows = forms.map(f => {
    const count = h('span', { class: 'count', text: '...' });
    const el = h('section', { class: 'card project', 'data-form': f.form_id },
      h('div', { class: 'project-head' },
        h('h2', { lang: 'hi', text: f.title }),
        h('p', { class: 'hint' }, h('code', { text: f.form_id }),
          ' · version ', h('code', { class: 'version', text: f.current_version || 'none' }),
          ' · ', count, ' submissions')),
      h('div', { class: 'project-actions' },
        exportControl(f.form_id, { api, pollMs: ctx.pollMs }),
        h('a', { class: 'button', href: `submissions.html?form=${encodeURIComponent(f.form_id)}`, text: 'View submissions' })));
    api.get('/api/submissions', { form_id: f.form_id, page_size: 1 })
      .then(p => { count.textContent = String(p.total); })
      .catch(() => { count.textContent = '?'; });
    list.append(el);
    return { f, el };
  });

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const { f, el } of rows) el.hidden = !!q && !(f.title + ' ' + f.form_id).toLowerCase().includes(q);
  });
}
