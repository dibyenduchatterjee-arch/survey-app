// Read-only audit trail (admin only; the server refuses anyone else).
import { h, clear, fmtDate } from './ui.js';

const LIMIT = 50;

export async function mountAudit(root, ctx) {
  const { api } = ctx;
  let offset = 0;
  const f = { actor_id: '', action: '' };
  clear(root);
  const body = h('div', { class: 'audit-list' });
  const actor = h('input', { name: 'actor_id', type: 'number', min: '1', placeholder: 'user id', 'aria-label': 'Who (user id)' });
  const action = h('input', { name: 'action', placeholder: 'e.g. user.update', 'aria-label': 'Action' });
  const filter = h('form', { class: 'filters', onsubmit: e => { e.preventDefault(); f.actor_id = actor.value.trim(); f.action = action.value.trim(); offset = 0; load(); } },
    h('label', null, 'Who ', actor), ' ', h('label', null, 'Action ', action), ' ',
    h('button', { type: 'submit', class: 'apply', text: 'Filter' }), ' ',
    h('button', { type: 'button', class: 'reset', text: 'Clear', onclick: () => { actor.value = action.value = ''; f.actor_id = f.action = ''; offset = 0; load(); } }));
  root.append(h('h1', { text: 'Audit trail' }), h('p', { class: 'hint', text: 'Read-only. Newest first. Filter by the user id who acted, or by action.' }), filter, body);
  async function load() {
    clear(body);
    let data;
    try { data = await api.get('/api/audit', { actor_id: f.actor_id, action: f.action, limit: LIMIT, offset }); } catch (e) {
      body.append(h('p', { class: 'msg bad', role: 'alert', text: e.message }));
      return;
    }
    body.append(h('table', { class: 'audit' },
      h('thead', null, h('tr', null, ['When', 'Who (user id)', 'Action', 'Object', 'Detail'].map(t => h('th', { text: t })))),
      h('tbody', null, data.items.map(r => h('tr', null,
        h('td', { text: fmtDate(r.at) }), h('td', { text: r.actor_user_id ?? '' }), h('td', { text: r.action }),
        h('td', { text: `${r.object_type || ''} ${r.object_id ?? ''}`.trim() }),
        h('td', { text: r.detail == null ? '' : typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail) }))))));
    if (!data.items.length) body.append(h('p', { text: 'Nothing recorded yet.' }));
    body.append(h('p', null, `${data.total} entries. `,
      h('button', { type: 'button', class: 'prev', disabled: offset === 0, text: 'Newer', onclick: () => { offset = Math.max(0, offset - LIMIT); load(); } }), ' ',
      h('button', { type: 'button', class: 'next', disabled: offset + LIMIT >= data.total, text: 'Older', onclick: () => { offset += LIMIT; load(); } })));
  }
  await load();
}
