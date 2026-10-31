// Re-keying stored data from a project's NAME to its stable ID.
//
// Older builds keyed every project by its name: session record `project:<name>`, forms stored as
// `<name>::<form id>` with `_project.id = <name>`, and queue, draft and rejected records carrying
// that same form id. The backend now sends a stable `project_id`; these pure helpers say what a
// stored record becomes. db.js applies them in one transaction; the tests' in-memory store applies
// the same functions, so there is one definition of the rule.
//
// Nothing here ever changes a uuid, a version, an answer or a photo: only the project part of the
// form id (and the `_project` tag on a form).

export const SEP = '::';

// `<old>::visit` -> `<new>::visit`; null when the form id does not belong to the old key.
export function rekeyFormId(formId, oldKey, newKey) {
  const s = String(formId === undefined || formId === null ? '' : formId);
  const head = oldKey + SEP;
  return s.startsWith(head) ? newKey + SEP + s.slice(head.length) : null;
}

// A stored form spec under the new key, or null when it is not this project's.
export function rekeySpec(spec, oldKey, newKey, name) {
  const form_id = spec && rekeyFormId(spec.form_id, oldKey, newKey);
  return form_id === null || form_id === undefined ? null : { ...spec, form_id, _project: { id: newKey, name } };
}

// A queue or draft record under the new key, or null when it is not this project's.
export function rekeyRecord(rec, oldKey, newKey) {
  const form_id = rec && rekeyFormId(rec.form_id, oldKey, newKey);
  return form_id === null || form_id === undefined ? null : { ...rec, form_id };
}

// A rejected-submission record (it also keeps a copy of the submission itself).
export function rekeyRejected(rec, oldKey, newKey) {
  const out = rekeyRecord(rec, oldKey, newKey);
  if (!out) return null;
  if (out.submission && typeof out.submission === 'object') {
    out.submission = { ...out.submission, form_id: rekeyFormId(out.submission.form_id, oldKey, newKey) || out.submission.form_id };
  }
  return out;
}

// The session records after the move: the project record under its new id (an existing record
// under the new id wins, it is the fresher login), no record under the old key, and the
// active-project marker following the project.
export function rekeySession({ legacy, current, active }, oldKey, newKey, name) {
  const next = current || (legacy && { ...legacy, id: 'project:' + newKey, key: newKey, name, by_id: true });
  const nextActive = active && active.key === oldKey ? { ...active, key: newKey } : null;
  return { project: next || null, active: nextActive };
}
