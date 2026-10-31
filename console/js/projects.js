// Projects: a project holds forms; people assigned to a project can fill every form in it,
// now and later. The page renders exactly what the API returns (a supervisor is sent only
// their own projects; an admin everything) and makes that consequence visible in words.
import { h, clear } from './ui.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function mountProjects(root, ctx) {
  const { api, user } = ctx;
  const isAdmin = user && user.role === 'admin';
  clear(root);
  const msg = h('p', { class: 'msg', role: 'status', hidden: true });
  const say = (text, bad) => { msg.textContent = text; msg.className = 'msg ' + (bad ? 'bad' : 'ok'); msg.hidden = false; };
  const list = h('div', { class: 'project-list' });
  const filter = h('input', { type: 'search', id: 'projects-filter', placeholder: 'Filter projects or forms', 'aria-label': 'Filter projects' });
  const newName = h('input', { id: 'np-name', placeholder: 'e.g. IFA syrup, Bihar' });
  const create = h('form', { class: 'card create-project', onsubmit: async e => {
    e.preventDefault();
    const name = newName.value.trim();
    if (!name) { say('Give the project a name.', true); return; }
    try { await api.post('/api/projects', { name }); newName.value = ''; say(`Created project "${name}".`); await load(); } catch (ex) { say(ex.message, true); }
  } },
  h('h2', { text: 'New project' }),
  h('label', { for: 'np-name', text: 'Project name' }), newName,
  h('button', { class: 'primary', type: 'submit', text: 'Create project' }));
  root.append(h('h1', { text: 'Projects' }),
    h('p', { class: 'hint', text: 'Every form belongs to exactly one project. A person added to a project gets every form in it, including forms added to it later.' }),
    msg, create, h('div', { class: 'toolbar' }, filter), list);

  let details = [];   // each: {id, name, forms, members}
  let people = null;  // active users who can be added (admin only; null = cannot list)
  let allForms = [];
  const open = new Set();

  async function load() {
    let projects;
    try { projects = await api.get('/api/projects'); } catch (e) { clear(list).append(h('p', { class: 'msg bad', role: 'alert', text: e.message })); return; }
    details = await Promise.all(projects.map(p => api.get(`/api/projects/${p.id}`).catch(() => ({ ...p, forms: [], members: [], failed: true }))));
    try { allForms = await api.get('/api/forms'); } catch { allForms = []; }
    if (isAdmin && people === null) {
      try { people = (await api.get('/api/users')).filter(u => u.is_active !== false); } catch { people = []; }
    }
    draw();
  }

  async function reload(...ids) {
    for (const id of ids) {
      if (id == null) continue;
      try {
        const fresh = await api.get(`/api/projects/${id}`);
        details = details.map(d => (d.id === id ? fresh : d));
      } catch (e) { say(e.message, true); }
    }
    draw();
  }

  function card(p) {
    const forms = p.forms || [];
    const members = p.members || [];
    const who = members.length
      ? members.map(m => h('li', { class: 'member', 'data-user': m.user_id },
        h('strong', { text: m.full_name }), ' ', h('code', { text: m.username }), ' ',
        h('span', { class: 'hint', text: `fills all ${plural(forms.length, 'form', 'forms')}` }), ' ',
        h('button', { type: 'button', class: 'remove-member', text: 'Remove', 'aria-label': `Remove ${m.full_name} from ${p.name}`, onclick: async () => {
          try {
            await api.del(`/api/projects/${p.id}/members/${m.user_id}`);
            say(`${m.full_name} no longer gets the forms in "${p.name}" through this project.`);
          } catch (ex) { say(ex.message, true); }
          await reload(p.id);
        } })))
      : [h('li', { class: 'hint', text: 'Nobody is assigned yet, so no field worker gets these forms through this project.' })];

    const memberIds = new Set(members.map(m => m.user_id));
    const addable = (people || []).filter(u => !memberIds.has(u.id));
    const userSel = h('select', { class: 'add-member-user', 'aria-label': `Person to add to ${p.name}` }, addable.map(u => h('option', { value: u.id, text: `${u.full_name} (${u.username}, ${u.role})` })));
    const adder = !isAdmin ? null
      : h('div', { class: 'toolbar' }, userSel,
        h('button', { type: 'button', class: 'primary add-member', text: 'Add to project', disabled: !addable.length, onclick: async () => {
          const u = addable.find(x => String(x.id) === userSel.value);
          if (!u) return;
          try {
            await api.post(`/api/projects/${p.id}/members`, { user_id: u.id });
            say(`${u.full_name} can now fill all ${plural(forms.length, 'form', 'forms')} in "${p.name}", and any form added later.`);
          } catch (ex) { say(ex.message, true); }
          await reload(p.id);
        } }));

    const here = new Set(forms.map(f => f.form_id));
    const projOf = new Map();
    for (const d of details) for (const f of d.forms || []) projOf.set(f.form_id, d.name);
    const movable = allForms.filter(f => !here.has(f.form_id));
    const formSel = h('select', { class: 'move-form-id', 'aria-label': `Form to move into ${p.name}` }, movable.map(f => h('option', { value: f.form_id, text: `${f.title} (currently in ${projOf.get(f.form_id) || 'another project'})` })));
    const mover = h('div', { class: 'toolbar' }, formSel,
      h('button', { type: 'button', class: 'move-form', text: 'Move form here', disabled: !movable.length, onclick: async () => {
        const f = movable.find(x => x.form_id === formSel.value);
        if (!f) return;
        const from = details.find(d => (d.forms || []).some(x => x.form_id === f.form_id));
        try {
          await api.request(`/api/projects/${p.id}/forms/${encodeURIComponent(f.form_id)}`, { method: 'PUT' });
          say(`Moved "${f.title}" into "${p.name}". Its ${plural(members.length, 'member', 'members')} can fill it now; people assigned only to the old project no longer get it.`);
        } catch (ex) { say(ex.message, true); }
        await reload(p.id, from && from.id !== p.id ? from.id : null);
      } }));

    const nameIn = h('input', { class: 'rename-input', value: p.name, 'aria-label': `Rename ${p.name}` });
    const el = h('details', { class: 'card project-card', 'data-project': p.id, open: open.has(p.id) },
      h('summary', {},
        h('strong', { class: 'project-name', text: p.name }), ' ',
        h('span', { class: 'badge counts', text: `${plural(forms.length, 'form', 'forms')} · ${plural(members.length, 'member', 'members')}` }),
        h('div', { class: 'chips' }, forms.map(f => h('span', { class: 'chip', lang: 'hi', text: f.title })))),
      h('div', { class: 'project-body' },
        p.failed ? h('p', { class: 'msg bad', role: 'alert', text: 'Could not load this project.' }) : null,
        h('h3', { text: `Forms in this project (${forms.length})` }),
        forms.length ? h('ul', { class: 'forms-in' }, forms.map(f => h('li', {}, h('span', { lang: 'hi', text: f.title }), ' ', h('code', { text: f.form_id })))) : h('p', { class: 'hint', text: 'No forms yet.' }),
        mover,
        h('h3', { text: `Who has access (${members.length})` }),
        h('p', { class: 'access-note', text: `Everyone below can fill all ${plural(forms.length, 'form', 'forms')} above, and any form moved into "${p.name}" later.` }),
        h('ul', { class: 'members' }, who),
        adder || h('p', { class: 'hint', text: 'Only an admin can add people.' }),
        h('div', { class: 'toolbar rename' }, nameIn,
          h('button', { type: 'button', class: 'rename', text: 'Rename', onclick: async () => {
            const name = nameIn.value.trim();
            if (!name || name === p.name) return;
            try { await api.patch(`/api/projects/${p.id}`, { name }); say(`Renamed to "${name}".`); } catch (ex) { say(ex.message, true); }
            await reload(p.id);
          } }))));
    el.addEventListener('toggle', () => { if (el.open) open.add(p.id); else open.delete(p.id); });
    return el;
  }

  function draw() {
    clear(list);
    if (!details.length) { list.append(h('p', { class: 'msg', text: 'No projects to show yet.' })); return; }
    const q = filter.value.trim().toLowerCase();
    for (const p of details) {
      const el = card(p);
      const hay = (p.name + ' ' + (p.forms || []).map(f => f.title + ' ' + f.form_id).join(' ')).toLowerCase();
      el.hidden = !!q && !hay.includes(q);
      list.append(el);
    }
  }
  filter.addEventListener('input', draw);
  await load();
}
