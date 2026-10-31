// Upload an XLSForm, look at the questions it compiled to, then publish.
import { h, clear } from './ui.js';
import { ApiError } from './api.js';

// The server reports a bad question as detail.question (a compile error tied to one
// row of the sheet) or as free-text messages. Put the question name first and big:
// it is how a supervisor finds the row in their spreadsheet.
export function errorPanel(err) {
  const d = err instanceof ApiError ? err.detail : null;
  const kids = [];
  if (d && typeof d === 'object' && !Array.isArray(d) && d.question) {
    kids.push(h('p', { class: 'bad-question' }, 'Problem in question ', h('code', { class: 'question-name', text: d.question })));
  }
  if (d && typeof d === 'object' && Array.isArray(d.messages)) {
    kids.push(h('ul', {}, d.messages.map(m => h('li', { text: String(m) }))));
  } else {
    kids.push(h('p', { class: 'error-text', text: err.message }));
  }
  return h('div', { class: 'msg bad form-error', role: 'alert' }, ...kids);
}

const labelOf = (node, spec) => {
  const l = node.label || {};
  return l[spec.default_language] ?? l.default ?? Object.values(l)[0] ?? '';
};

// Flattens nested groups and repeats into rows with a depth, for display.
export function flattenNodes(spec) {
  const rows = [];
  const walk = (nodes, depth) => {
    for (const n of nodes || []) {
      rows.push({ node: n, depth });
      if (n.children) walk(n.children, depth + 1);
    }
  };
  walk(spec.nodes, 0);
  return rows;
}

export function questionList(spec) {
  const body = flattenNodes(spec).map(({ node, depth }) => {
    const ch = node.choices_ref && spec.choices && spec.choices[node.choices_ref];
    const kids = node.children ? ' (' + node.children.length + ')' : '';
    // Indent through the CSSOM, not a style="" attribute: the Content-Security-Policy has no
    // style-src-attr 'unsafe-inline', and el.style.x is not an inline-style attribute to it.
    const nameCell = h('td', { class: 'q-name' }, h('code', { text: node.name }));
    nameCell.style.paddingLeft = `${0.6 + depth * 1.2}rem`;
    return h('tr', { class: 'q-' + node.type },
      nameCell,
      h('td', { text: node.type + kids }),
      h('td', { class: 'q-label', lang: 'hi', text: labelOf(node, spec) }),
      h('td', { text: [node.required ? 'required' : '', node.relevant ? 'conditional' : '', ch ? ch.length + ' choices' : ''].filter(Boolean).join(', ') }));
  });
  return h('table', { class: 'questions' },
    h('thead', {}, h('tr', {}, ['Name', 'Type', 'Question', 'Notes'].map(t => h('th', { text: t })))),
    h('tbody', {}, body));
}

export async function mountForms(root, ctx) {
  const { api } = ctx;
  clear(root);
  const out = h('div', { class: 'upload-out', 'aria-live': 'polite' });
  const file = h('input', { type: 'file', id: 'xlsx', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const go = h('button', { class: 'primary upload', type: 'button', text: 'Upload and check' });
  // The project decides who can see this form's data, so it is chosen, never guessed.
  const projectSel = h('select', { id: 'upload-project', class: 'upload-project' });
  const projectRow = h('div', { class: 'project-pick', hidden: true },
    h('label', { for: 'upload-project', text: 'Project this form belongs to' }), projectSel);
  api.get('/api/projects').then(list => {
    if (!Array.isArray(list) || !list.length) return;
    if (list.length > 1) projectSel.append(h('option', { value: '', text: 'Choose a project...' }));
    for (const p of list) projectSel.append(h('option', { value: String(p.id), text: p.name }));
    projectRow.hidden = false;
  }).catch(() => { /* no list: the server will say if it needs a project */ });

  function chooseProject(id) {
    if (![...projectSel.options].some(o => o.value === String(id))) return;
    projectSel.value = String(id);
  }

  // The server refused because it needs to be told the project: show its list as choices.
  function projectChoices(d) {
    const choices = Array.isArray(d.projects) ? d.projects : [];
    const box = h('div', { class: 'msg warn project-choices', role: 'alert' },
      h('p', { text: d.message || 'Say which project this form belongs to.' }));
    if (choices.length) {
      box.append(h('div', { class: 'toolbar' }, choices.map(c => h('button', {
        type: 'button', class: 'choose-project', 'data-project': c.id, text: `Upload to ${c.name}`,
        onclick: () => { chooseProject(c.id); upload(c.id); },
      }))));
    }
    return box;
  }

  go.addEventListener('click', () => upload(projectSel.value));

  async function upload(projectId) {
    clear(out);
    if (!file.files || !file.files[0]) {
      out.append(h('p', { class: 'msg bad', role: 'alert', text: 'Choose an .xlsx file first.' }));
      return;
    }
    if (!projectRow.hidden && !projectId) {
      out.append(h('p', { class: 'msg bad', role: 'alert', text: 'Choose the project this form belongs to first.' }));
      return;
    }
    go.disabled = true;
    out.append(h('p', { class: 'msg', text: 'Checking the form...' }));
    try {
      const fd = new FormData();
      fd.append('file', file.files[0]);
      if (projectId) fd.append('project_id', String(projectId));
      const res = await api.upload('/api/forms', fd);
      let spec = res.spec || null;
      let previewNote = null;
      if (!spec) {
        try {
          spec = await api.get(`/api/forms/${encodeURIComponent(res.form_id)}/versions/${encodeURIComponent(res.version)}/spec`);
        } catch (e) {
          previewNote = e.status === 404
            ? "The server will not show this version's questions until it is published, so the preview is unavailable."
            : e.message;
        }
      }
      showResult(res, spec, previewNote);
    } catch (e) {
      const d = e instanceof ApiError ? e.detail : null;
      clear(out).append(e.status === 422 && d && typeof d === 'object' && d.error === 'project_required' ? projectChoices(d) : errorPanel(e));
    } finally { go.disabled = false; }
  }

  function showResult(res, spec, previewNote) {
    clear(out);
    out.append(h('h2', {}, 'Uploaded: ', h('code', { text: res.form_id }), ' version ', h('code', { text: res.version }), ' (not yet live)'));
    if (res.warnings && res.warnings.length) {
      out.append(h('div', { class: 'msg warn warnings' }, h('strong', { text: 'Warnings' }), h('ul', {}, res.warnings.map(w => h('li', { text: w })))));
    }
    if (spec) out.append(h('h3', { text: `${flattenNodes(spec).length} items in this form` }), questionList(spec));
    else out.append(h('p', { class: 'msg warn preview-missing', text: previewNote }));
    const status = h('div', { 'aria-live': 'polite' });
    const publish = h('button', { class: 'primary publish', type: 'button', text: `Publish version ${res.version}` });
    publish.addEventListener('click', async () => {
      publish.disabled = true;
      clear(status);
      try {
        await api.post(`/api/forms/${encodeURIComponent(res.form_id)}/publish`, { version: res.version });
        status.append(h('p', { class: 'msg ok published', text: `Published. Enumerators assigned to ${res.form_id} will get version ${res.version} next time they sync.` }));
      } catch (e) {
        publish.disabled = false;
        status.append(errorPanel(e));
      }
    });
    out.append(publish, status);
  }

  root.append(h('h1', { text: 'Upload a form' }),
    h('p', { class: 'hint', text: 'Upload the XLSForm for a project. You will see every question before anything goes live.' }),
    h('div', { class: 'card' }, projectRow, h('label', { for: 'xlsx', text: 'XLSForm (.xlsx)' }), file, go), out);
}
