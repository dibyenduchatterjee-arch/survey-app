// Users and form assignments. Admin sees the controls; supervisors can read assignments.
// Hiding the controls is presentation only: the server refuses non-admins regardless.
import { h, clear, fmtDate } from './ui.js';

export async function mountUsers(root, ctx) {
  const { api, user } = ctx;
  const isAdmin = user && user.role === 'admin';
  clear(root);
  const msg = h('p', { class: 'msg', role: 'status', hidden: true });
  const say = (text, bad) => { msg.textContent = text; msg.className = 'msg ' + (bad ? 'bad' : 'ok'); msg.hidden = false; };
  const users = h('div', { class: 'users' });
  const assigns = h('div', { class: 'assignments' });
  root.append(h('h1', { text: 'Users and assignments' }), msg);

  if (isAdmin) {
    const f = {
      username: h('input', { id: 'nu-username', required: true }),
      full_name: h('input', { id: 'nu-name', required: true }),
      password: h('input', { id: 'nu-password', type: 'password', autocomplete: 'new-password', required: true }),
      phone: h('input', { id: 'nu-phone' }),
      role: h('select', { id: 'nu-role' }, ['enumerator', 'supervisor', 'admin'].map(r => h('option', { value: r, text: r }))),
    };
    root.append(h('form', { class: 'card', onsubmit: async e => {
      e.preventDefault();
      try {
        await api.post('/api/users', { username: f.username.value.trim(), full_name: f.full_name.value.trim(), password: f.password.value, role: f.role.value, phone: f.phone.value.trim() || null });
        say(`Created ${f.username.value.trim()}.`);
        f.password.value = '';
        await loadUsers();
      } catch (ex) { say(ex.message, true); }
    } },
    h('h2', { text: 'Add a user' }),
    h('label', { for: 'nu-username', text: 'Username' }), f.username,
    h('label', { for: 'nu-name', text: 'Full name' }), f.full_name,
    h('label', { for: 'nu-password', text: 'Temporary password' }), f.password,
    h('label', { for: 'nu-phone', text: 'Phone (optional)' }), f.phone,
    h('label', { for: 'nu-role', text: 'Role' }), f.role,
    h('button', { class: 'primary', type: 'submit', text: 'Create user' })));
    root.append(h('h2', { text: 'People' }), users);
  }
  root.append(h('h2', { text: 'Who has which form' }), assigns);

  let userList = [];
  let forms = [];
  async function loadUsers() {
    if (!isAdmin) return;
    clear(users);
    try { userList = await api.get('/api/users'); } catch (e) { users.append(h('p', { class: 'msg bad', role: 'alert', text: e.message })); return; }
    users.append(h('table', {}, h('thead', {}, h('tr', {}, ['Username', 'Name', 'Role', 'Last sign-in', 'Active'].map(t => h('th', { text: t })))),
      h('tbody', {}, userList.map(u => h('tr', {},
        h('td', {}, h('code', { text: u.username })), h('td', { text: u.full_name }), h('td', { text: u.role }),
        h('td', { text: fmtDate(u.last_login_at) }),
        h('td', {}, h('button', { type: 'button', class: 'toggle-active', text: u.is_active ? 'Deactivate' : 'Activate', onclick: async () => {
          try { await api.patch(`/api/users/${u.id}`, { is_active: !u.is_active }); await loadUsers(); } catch (ex) { say(ex.message, true); }
        } })))))));
    await loadAssignments();
  }

  async function loadAssignments() {
    clear(assigns);
    let list;
    try { list = await api.get('/api/assignments'); } catch (e) { assigns.append(h('p', { class: 'msg bad', role: 'alert', text: e.message })); return; }
    if (isAdmin) {
      const u = h('select', { id: 'as-user' }, userList.filter(x => x.role === 'enumerator' && x.is_active).map(x => h('option', { value: x.id, text: `${x.full_name} (${x.username})` })));
      const fm = h('select', { id: 'as-form' }, forms.map(x => h('option', { value: x.form_id, text: `${x.title} (${x.form_id})` })));
      assigns.append(h('div', { class: 'toolbar' }, u, fm, h('button', { class: 'primary assign', type: 'button', text: 'Assign', onclick: async () => {
        try { await api.post('/api/assignments', { user_id: Number(u.value), form_id: fm.value }); say('Assigned.'); await loadAssignments(); } catch (ex) { say(ex.message, true); }
      } })));
    }
    assigns.append(list.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['Enumerator', 'Form', ''].map(t => h('th', { text: t })))),
        h('tbody', {}, list.map(a => h('tr', {}, h('td', { text: `${a.full_name} (${a.username})` }), h('td', { text: `${a.form_title} (${a.form_id})` }),
          h('td', {}, isAdmin ? h('button', { type: 'button', class: 'unassign', text: 'Remove', onclick: async () => {
            try { await api.del(`/api/assignments/${a.id}`); await loadAssignments(); } catch (ex) { say(ex.message, true); }
          } }) : null)))))
      : h('p', { text: 'No assignments yet.' }));
  }

  try { forms = await api.get('/api/forms'); } catch { /* shown by the assignment list if it matters */ }
  if (isAdmin) await loadUsers(); else await loadAssignments();
}
