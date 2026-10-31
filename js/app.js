// The enumerator app: enter a project code, pick a form, fill it, finish, watch the queue drain.
//
// Deliberately thin. The logic lives in the modules it wires together:
//   db.js (drafts, queue)  projects.js (project-code login, Apps Script calls)  sync.js (bootstrap, upload)
//   formengine.js (answers, validation)  render.js (the screen, GPS, photos, drafts)
//
// Two rules that matter more than the rest:
//   * A draft is written on every answer (render.js draftSaver), so a dead battery loses at most
//     the character being typed.
//   * The submission's uuid IS the draft's id. If the phone dies after the submission is queued
//     but before the draft is deleted, finishing the resumed draft sends the same uuid and the
//     server answers 200 as a replay, never a duplicate household.

import * as db from './db.js';
import { openProject, signOut, listProjects, isConfigured } from './projects.js';
import { bootstrap, startSync, syncOnce, listRejected, retryRejected, splitFormId } from './sync.js';
import { FormEngine } from './formengine.js';
import { availableLanguages, translate } from './i18n.js';
import { renderForm, draftSaver, loadDraft, deleteDraftFully, rememberMediaCap, mediaCap } from './render.js';

// ---------------------------------------------------------------- small helpers

const $ = (id) => document.getElementById(id);

function h(tag, className, props = {}, ...kids) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'onclick') node.addEventListener('click', v);
    else if (k === 'onsubmit') node.addEventListener('submit', v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) node.append(kid);
  return node;
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode: carry on without */ } },
};

// ---------------------------------------------------------------- the app's own words

const T = {
  hi: {
    title: 'Evidence Action सर्वे',
    code_title: 'प्रोजेक्ट कोड डालें',
    code_label: 'प्रोजेक्ट कोड',
    code_help: 'यह आपका अपना कोड है, जो सुपरवाइज़र ने दिया है। इससे सिर्फ़ आपके प्रोजेक्ट के फ़ॉर्म खुलेंगे, और भरे हुए फ़ॉर्म पर आपका नाम लगेगा।',
    code_go: 'प्रोजेक्ट खोलें',
    code_opening: 'खुल रहा है…',
    code_empty: 'पहले प्रोजेक्ट कोड डालें।',
    code_refused: 'यह कोड सही नहीं है, या इस प्रोजेक्ट की पहुँच बंद है। अपने सुपरवाइज़र से पूछें।',
    code_network: 'इंटरनेट नहीं चल रहा, या सर्वर जवाब नहीं दे रहा। थोड़ी देर बाद फिर कोशिश करें।',
    code_wait: 'बहुत ज़्यादा कोशिशें हुईं। कुछ मिनट बाद फिर कोशिश करें।',
    code_unset: 'यह ऐप अभी सेट नहीं हुआ है।',
    code_outdated: 'सर्वर का संस्करण पुराना है। जो व्यक्ति इसे चलाता है, उससे नया संस्करण लगाने को कहें।',
    setup_title: 'यह ऐप अभी सेट नहीं हुआ है',
    setup_body: 'सर्वर का पता अभी ऐप में डाला नहीं गया है, इसलिए कुछ भी भेजा या खोला नहीं जा सकता। जिसने यह ऐप दिया है, उसे बताएँ। आपका भरा हुआ काम इस फ़ोन में सुरक्षित है।',
    setup_tech: 'तकनीकी जानकारी: webapp/config.js में appsScriptUrl अभी भी PASTE-... वाला नमूना है। उसकी जगह Apps Script Web App का पता (जो /exec पर खत्म होता है) डालें।',
    code_cancel: 'वापस जाएँ',
    add_project: 'दूसरा प्रोजेक्ट जोड़ें',
    my_projects: 'आपके प्रोजेक्ट',
    project_open: 'खुला है',
    project_lost: 'पहुँच बंद है',
    remove_project: 'हटाएँ',
    sure_remove: 'पक्का हटाएँ?',
    no_projects: 'अभी कोई प्रोजेक्ट नहीं खुला है।',
    access_lost: 'इस प्रोजेक्ट की पहुँच बंद हो गई है: {p}। सही कोड फिर से डालें। भरा हुआ काम फ़ोन में सुरक्षित है।',
    logging_in: 'खुल रहा है…',
    downloading: 'फ़ॉर्म डाउनलोड हो रहे हैं…',
    forms: 'फ़ॉर्म भरें',
    no_forms: 'अभी कोई फ़ॉर्म नहीं मिला। इंटरनेट चालू करके "फ़ॉर्म अपडेट करें" दबाएँ।',
    drafts: 'अधूरे फ़ॉर्म',
    resume: 'जारी रखें',
    discard: 'मिटाएँ',
    sure_discard: 'पक्का मिटाएँ?',
    pending: '{n} फ़ॉर्म भेजने बाकी',
    all_sent: 'सब फ़ॉर्म भेजे जा चुके हैं',
    send_now: 'अभी भेजें',
    sending: 'भेज रहे हैं…',
    offline: 'ऑफ़लाइन',
    online: 'ऑनलाइन',
    rejected: 'सर्वर ने ये फ़ॉर्म नहीं लिए',
    retry: 'फिर भेजें',
    logout: 'सभी प्रोजेक्ट से बाहर निकलें',
    logout_pending: 'अभी {n} फ़ॉर्म भेजे नहीं गए। भेजे नहीं गए फ़ॉर्म फ़ोन में रहेंगे। फिर भी बाहर निकलें?',
    finish: 'पूरा करें',
    home: 'होम',
    saved: 'सेव हो गया',
    saving_failed: 'सेव नहीं हो पाया, जगह की जाँच करें',
    done_title: 'फ़ॉर्म सेव हो गया',
    done_queue: 'भेजने के लिए कतार में: {n}',
    done_sent: 'सब भेजा जा चुका है',
    done_offline: 'इंटरनेट आने पर अपने आप चला जाएगा',
    fill_another: 'एक और फ़ॉर्म भरें',
    errors_left: '{n} जवाब ठीक करने बाकी हैं',
    version: 'संस्करण',
    fail: 'कुछ गड़बड़ हुई: {m}',
    refresh: 'फ़ॉर्म अपडेट करें (Refresh forms)',
    refreshing: 'फ़ॉर्म अपडेट हो रहे हैं… इंटरनेट चालू रखें',
    refresh_offline: 'इंटरनेट नहीं है। इंटरनेट चालू करके फिर कोशिश करें।',
    refresh_failed: 'फ़ॉर्म अपडेट नहीं हो पाए। इंटरनेट देखें और फिर कोशिश करें।',
    refresh_partial: 'कुछ चीज़ें अपडेट नहीं हो पाईं ({n} दिक्कतें)। नए फ़ॉर्म मिले: {f}। फिर से दबाकर कोशिश करें।',
    refresh_ok: 'अपडेट हो गया: नए फ़ॉर्म {f}, डेटासेट {d}। अधूरे फ़ॉर्म वैसे ही रहेंगे।',
    refresh_ok_data: 'फ़ॉर्म पहले से नए हैं। डेटासेट अपडेट हुए: {d}।',
    refresh_uptodate: 'सब कुछ पहले से अपडेट है।',
  },
  en: {
    title: 'Evidence Action Survey',
    code_title: 'Enter your project code',
    code_label: 'Project code',
    code_help: 'This is your own code from your supervisor. It opens only the forms of your project, and the forms you fill carry your name.',
    code_go: 'Open project',
    code_opening: 'Opening…',
    code_empty: 'Enter the project code first.',
    code_refused: 'This code is not right, or access to this project has been switched off. Ask your supervisor.',
    code_network: 'No internet, or the server did not answer. Try again in a little while.',
    code_wait: 'Too many tries. Try again in a few minutes.',
    code_unset: 'This app has not been set up yet.',
    code_outdated: 'The survey server is an old version. Ask the person who runs it to deploy the new version.',
    setup_title: 'This app has not been set up yet',
    setup_body: 'The address of the survey server has not been put into the app, so nothing can be opened or sent. Tell the person who gave you this app. Anything you have already filled in is safe on this phone.',
    setup_tech: 'For the person setting it up: in webapp/config.js, appsScriptUrl is still the PASTE-... placeholder. Replace it with your Apps Script Web App address (it ends in /exec).',
    code_cancel: 'Back',
    add_project: 'Add another project',
    my_projects: 'Your projects',
    project_open: 'Open',
    project_lost: 'Access switched off',
    remove_project: 'Remove',
    sure_remove: 'Really remove?',
    no_projects: 'No project is open yet.',
    access_lost: 'Access to this project has been switched off: {p}. Enter the right code again. Your saved work is safe on this phone.',
    logging_in: 'Opening…',
    downloading: 'Downloading forms…',
    forms: 'Fill a form',
    no_forms: 'No forms yet. Turn on the internet and tap "Refresh forms".',
    drafts: 'Unfinished forms',
    resume: 'Continue',
    discard: 'Delete',
    sure_discard: 'Really delete?',
    pending: '{n} forms waiting to be sent',
    all_sent: 'Everything has been sent',
    send_now: 'Send now',
    sending: 'Sending…',
    offline: 'Offline',
    online: 'Online',
    rejected: 'The server did not accept these forms',
    retry: 'Send again',
    logout: 'Leave all projects',
    logout_pending: '{n} forms have not been sent yet. They stay on this phone. Leave anyway?',
    finish: 'Finish',
    home: 'Home',
    saved: 'Saved',
    saving_failed: 'Could not save, check storage space',
    done_title: 'Form saved',
    done_queue: 'Waiting to be sent: {n}',
    done_sent: 'Everything has been sent',
    done_offline: 'It will go by itself when the internet comes back',
    fill_another: 'Fill another form',
    errors_left: '{n} answers still need fixing',
    version: 'Version',
    fail: 'Something went wrong: {m}',
    refresh: 'Refresh forms (फ़ॉर्म अपडेट करें)',
    refreshing: 'Refreshing forms… keep the internet on',
    refresh_offline: 'No internet. Connect to the internet and try again.',
    refresh_failed: 'Could not refresh the forms. Check your internet and try again.',
    refresh_partial: 'Some things did not refresh ({n} problems). New forms received: {f}. Tap again to try again.',
    refresh_ok: 'Updated: {f} new forms, {d} datasets. Unfinished forms stay as they were.',
    refresh_ok_data: 'Forms are already up to date. Datasets refreshed: {d}.',
    refresh_uptodate: 'Everything is already up to date.',
  },
};

const state = { lang: store.get('evac.lang') === 'en' ? 'en' : 'hi', session: null, screen: null, poll: null };

function t(key, vars = {}) {
  let s = (T[state.lang] || T.hi)[key] ?? T.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// ---------------------------------------------------------------- refresh forms
//
// One tap re-runs bootstrap(). It writes new form versions ALONGSIDE the old ones and never reads
// or writes drafts, the queue or the rejected store, so an open draft keeps the version it started
// on and unsent work is untouched. This code adds no writes of its own.

const tIn = (lang, key, vars = {}) => {
  let s = (T[lang] || T.hi)[key] ?? T.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};

export const refreshLabel = (lang) => tIn(lang, 'refresh');

// -> { status: 'offline' | 'failed' | 'partial' | 'ok', newForms, datasets, problems, boot }
export async function refreshForms({ online = () => navigator.onLine !== false } = {}) {
  const none = { newForms: 0, datasets: 0, problems: 0, boot: null };
  if (!online()) return { status: 'offline', ...none };
  let boot;
  try { boot = await bootstrap(); } catch { return { status: 'failed', ...none }; }
  const problems = boot.errors.length;
  return {
    status: problems ? 'partial' : 'ok',
    newForms: boot.forms.filter((f) => f.downloaded).length,
    datasets: boot.datasets.length,
    problems,
    boot,
  };
}

export function refreshMessage(r, lang) {
  const vars = { f: r.newForms, d: r.datasets, n: r.problems };
  if (r.status === 'ok') {
    if (r.newForms) return tIn(lang, 'refresh_ok', vars);
    return tIn(lang, r.datasets ? 'refresh_ok_data' : 'refresh_uptodate', vars);
  }
  return tIn(lang, 'refresh_' + r.status, vars);
}

export function refreshButton({ lang, onrefresh }) {
  return h('button', 'btn', { type: 'button', id: 'refresh-forms', text: refreshLabel(lang), onclick: onrefresh });
}

const LANG_NAMES = { hi: 'हिंदी', en: 'English' };

// The language toggle in the header. On the form screen it offers the form's own languages.
function setLangToggle(langs, current, onPick) {
  const box = $('lang');
  box.textContent = '';
  if (langs.length < 2) return;
  for (const l of langs) {
    box.append(h('button', '', {
      type: 'button',
      'aria-pressed': String(l === current),
      text: LANG_NAMES[l] || l,
      onclick: () => onPick(l),
    }));
  }
}

function useChromeToggle(rerender) {
  setLangToggle(['hi', 'en'], state.lang, (l) => {
    state.lang = l;
    store.set('evac.lang', l);
    rerender();
  });
}

// ---------------------------------------------------------------- the media cap

// The server's max_media_bytes arrives in bootstrap()'s `config` and is remembered on the phone
// (render.js rememberMediaCap / mediaCap, which also holds the fallback for a phone that has
// never heard it). The same number is what downscaleImage sizes photos to.
const maxMediaBytes = () => mediaCap(localStorage);
const rememberCap = (boot) => rememberMediaCap(boot, localStorage);

// Who is using the phone, in the shape the rest of the app reads. user.id is the DEVICE's id (stable
// across projects, so drafts stay visible whichever project is open). The person's NAME comes from
// their code, per project (projects[].person), and is stamped on the rows by the backend. Null when
// no project is open: the first screen asks for a code.
async function readSession() {
  let held = [];
  try { held = await listProjects(); } catch { /* treated as nothing open */ }
  if (!held.length) return null;
  return { user: { id: deviceId() }, projects: held };
}

function deviceId() {
  let id = store.get('evac.device');
  if (!id) { id = crypto.randomUUID(); store.set('evac.device', id); }
  return id;
}

// ---------------------------------------------------------------- the status pill

async function refreshStatus() {
  const pill = $('net');
  let n = 0;
  try { n = await db.queueLength(); } catch { /* db busy: show what we know */ }
  const off = navigator.onLine === false;
  pill.textContent = (off ? t('offline') : t('online')) + (n ? ` · ${n}` : '');
  pill.classList.toggle('offline', off);
  return n;
}

// ---------------------------------------------------------------- screens

function screen(name, title, ...kids) {
  state.screen = name;
  $('title').textContent = title || t('title');
  const main = $('app');
  main.textContent = '';
  main.append(...kids.flat().filter(Boolean));
  document.querySelector('.form-footer')?.remove();
  window.scrollTo(0, 0);
  refreshStatus();
}

function showNotSetUp() {
  useChromeToggle(showNotSetUp);
  screen('setup', t('title'), h('section', 'card', { id: 'not-set-up' },
    h('div', 'notice bad', { role: 'alert', text: t('setup_title') }),
    h('p', '', { text: t('setup_body') }),
    h('p', 'muted', { text: t('setup_tech') })));
}

// The first screen, and the "add another project" screen. A wrong code stores nothing.
function showCode(message, { canCancel = false } = {}) {
  useChromeToggle(() => showCode(message, { canCancel }));
  const err = h('p', 'err', { role: 'alert' });
  const code = h('input', 'control', { type: 'text', id: 'project-code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': t('code_label') });
  const go = h('button', 'btn btn-primary', { type: 'submit', text: t('code_go') });
  const form = h('form', 'card', { novalidate: true },
    h('h2', '', { text: t('code_title') }),
    h('p', 'muted', { text: t('code_help') }),
    h('div', 'field', {}, h('label', '', { for: 'project-code' }, t('code_label')), code),
    err, go);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    if (!code.value.trim()) { err.textContent = t('code_empty'); return; }
    go.disabled = true;
    go.textContent = t('code_opening');
    try {
      await openProject(code.value);          // stores nothing unless the backend accepts the code
      await afterOpen();
    } catch (ex) {
      const c = ex && ex.code;
      err.textContent = c === 'refused' ? t('code_refused')
        : c === 'too_many_attempts' ? t('code_wait')
        : c === 'not_configured' ? t('code_unset')
        : c === 'server_outdated' ? t('code_outdated')
        : t('code_network');
      go.disabled = false;
      go.textContent = t('code_go');
    }
  });
  const back = canCancel ? h('button', 'btn btn-quiet', { type: 'button', text: t('code_cancel'), onclick: () => showHome() }) : null;
  screen('code', t('title'), message ? h('div', 'notice', { text: message }) : null, form, back);
}

async function afterOpen() {
  state.session = await readSession();
  screen('boot', t('title'), h('p', 'card', { text: t('downloading') }));
  let boot = null;
  if (navigator.onLine !== false) {
    try { boot = await bootstrap(); rememberCap(boot); } catch { /* offline after all: use what is on the phone */ }
  }
  startSync();
  await showHome(boot);
}

// The newest version of each form this phone holds. A draft stays on its own version.
// Only forms of projects this phone currently holds (and that are not switched off) are listed:
// a project that was removed or revoked shows nothing, though its stored forms and any queued
// work stay on the phone. Form ids are namespaced by project, so each project's form is its own.
async function latestForms() {
  const live = new Set((await listProjects()).filter((p) => !p.revoked).map((p) => p.key));
  const all = (await db.listForms()).filter((spec) => spec._project && live.has(spec._project.id));
  const best = new Map();
  for (const spec of all) {
    const cur = best.get(spec.form_id);
    if (!cur || compareVersions(spec.version, cur.version) > 0) best.set(spec.form_id, spec);
  }
  return [...best.values()].sort((a, b) => String(a._project.name).localeCompare(String(b._project.name)));
}

function compareVersions(a, b) {
  const x = String(a);
  const y = String(b);
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
  return x < y ? -1 : x > y ? 1 : 0;
}

const specTitle = (spec) => translate(spec.title, state.lang, spec.default_language) || spec._form_id || splitFormId(spec.form_id).form;

// A project's NAME for display. The key is an opaque id and is never shown; a project this phone
// no longer holds has no name to show.
const projectName = (session, key) => ((session.projects || []).find((p) => p.key === key) || {}).name || '';
const withProject = (label, name) => (name ? `${label} (${name})` : label);

function lostText(session, keys) {
  const names = (keys || []).map((k) => projectName(session, k) || '?');
  return t('access_lost', { p: names.join(', ') });
}

async function showHome(boot, note) {
  useChromeToggle(() => showHome(boot, note));
  const session = (state.session = await readSession());
  if (!session) { showCode(); return; }
  const uid = session.user && session.user.id;

  const forms = await latestForms();
  const heldKeys = new Set(session.projects.filter((p) => !p.revoked).map((p) => p.key));
  const drafts = (await db.listDrafts()).filter((d) => d.kind !== 'media').filter((d) => d.user_id === undefined || d.user_id === uid)
    .filter((d) => heldKeys.has(splitFormId(d.form_id).project))
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  const pending = await db.queueLength();
  const rejected = await listRejected().catch(() => []);

  const parts = [];
  if (boot && boot.errors && boot.errors.length) {
    parts.push(h('div', 'notice', { text: boot.errors.map((e) => `${e.file || e.project || e.form_id || e.dataset}: ${e.error}`).join('\n') }));
  }

  // Queue
  const sendBtn = h('button', 'btn', {
    type: 'button',
    text: t('send_now'),
    onclick: async () => {
      sendBtn.disabled = true;
      sendBtn.textContent = t('sending');
      let sent = null;
      try { sent = await syncOnce(); } catch { /* shown by the count below */ }
      // A project whose code was switched off: say which one. The queue has not been touched.
      if (sent && sent.authRequired) { showHome(boot, { kind: 'bad', text: lostText(session, sent.lostProjects) }); return; }
      showHome(boot);
    },
  });
  parts.push(h('section', 'card', {},
    h('p', 'big-number', { text: String(pending) }),
    h('p', pending ? '' : 'muted', { text: pending ? t('pending', { n: pending }) : t('all_sent') }),
    pending ? sendBtn : null));

  // Refresh forms: one tap fetches the assigned forms and datasets again.
  const lostNote = !note && session.projects.some((p) => p.revoked)
    ? { kind: 'bad', text: lostText(session, session.projects.filter((p) => p.revoked).map((p) => p.key)) } : null;
  if (lostNote) note = lostNote;
  const status = h('p', note ? 'notice ' + note.kind : 'muted', { role: 'status', 'aria-live': 'polite', text: note ? note.text : '' });
  status.hidden = !note;
  const refreshBtn = refreshButton({
    lang: state.lang,
    onrefresh: async () => {
      refreshBtn.disabled = true;
      status.hidden = false;
      status.className = 'muted';
      status.textContent = t('refreshing');
      let r;
      try { r = await refreshForms(); } catch { r = { status: 'failed', newForms: 0, datasets: 0, problems: 0, boot: null }; }
      if (r.boot) rememberCap(r.boot);
      await showHome(r.boot || boot, { kind: r.status === 'ok' ? 'good' : r.status === 'partial' ? '' : 'bad', text: refreshMessage(r, state.lang) });
    },
  });
  parts.push(h('section', 'card', {}, refreshBtn, status));

  // Projects held on this phone. Adding one never replaces another.
  const projList = h('ul', 'list');
  for (const p of session.projects) {
    let armed = false;
    const rm = h('button', 'btn btn-quiet', { type: 'button', text: t('remove_project') });
    rm.addEventListener('click', async () => {
      if (!armed) { armed = true; rm.textContent = t('sure_remove'); return; }
      await signOut(p.key);            // this project only; the queue, drafts and forms stay
      showHome(boot);
    });
    projList.append(h('li', 'btn-row', {},
      h('span', '', { text: p.name + (p.person ? ' · ' + p.person : '') + ' · ' + (p.revoked ? t('project_lost') : t('project_open')) }), rm));
  }
  parts.push(h('section', 'card', {}, h('h2', '', { text: t('my_projects') }), projList,
    h('button', 'btn', { type: 'button', id: 'add-project', text: t('add_project'), onclick: () => showCode(null, { canCancel: true }) })));

  // Forms
  const formList = h('ul', 'list');
  for (const spec of forms) {
    formList.append(h('li', '', {}, h('button', 'btn btn-primary', {
      type: 'button',
      onclick: () => openForm(spec, null),
    }, specTitle(spec), h('small', 'project-tag', { text: spec._project.name, style: 'display:block;font-weight:400;opacity:.8' }))));
  }
  parts.push(h('section', 'card', {}, h('h2', '', { text: t('forms') }),
    forms.length ? formList : h('p', 'muted', { text: t('no_forms') })));

  // Drafts
  if (drafts.length) {
    const list = h('ul', 'list');
    for (const d of drafts) {
      const when = d.updated_at ? new Date(d.updated_at).toLocaleString(state.lang === 'en' ? 'en-IN' : 'hi-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
      const sp = splitFormId(d.form_id);
      const label = `${withProject(sp.form, projectName(session, sp.project))} · ${when}`;
      let armed = false;
      const del = h('button', 'btn btn-quiet', { type: 'button', text: t('discard') });
      del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = t('sure_discard'); return; }
        await deleteDraftFully(db, d.id);
        showHome(boot);
      });
      list.append(h('li', 'btn-row', {},
        h('button', 'btn', {
          type: 'button',
          text: `${t('resume')}: ${label}`,
          onclick: async () => {
            const spec = await db.getForm(d.form_id, d.version);
            if (spec) openForm(spec, await loadDraft(db, d.id));
          },
        }), del));
    }
    parts.push(h('section', 'card', {}, h('h2', '', { text: t('drafts') }), list));
  }

  // Refused by the server: shown with the reason, and a way to send again once fixed.
  if (rejected.length) {
    const list = h('ul', 'list');
    for (const r of rejected) {
      list.append(h('li', '', {},
        h('p', '', { text: `${withProject(splitFormId(r.form_id).form, projectName(session, splitFormId(r.form_id).project))}: ${r.message || r.code || r.status}` }),
        h('button', 'btn', { type: 'button', text: t('retry'), onclick: async () => { await retryRejected(r.uuid); showHome(boot); } })));
    }
    parts.push(h('section', 'card', {}, h('div', 'notice bad', { text: t('rejected') }), list));
  }

  // Logout
  let sure = false;
  const out = h('button', 'btn btn-quiet', { type: 'button', text: t('logout') });
  out.addEventListener('click', async () => {
    if (pending && !sure) { sure = true; out.textContent = t('logout_pending', { n: pending }); return; }
    await signOut();           // forgets the project codes only; the queue, drafts and forms stay
    showCode();
  });
  parts.push(out);
  screen('home', t('title'), parts);
}

// ---------------------------------------------------------------- filling a form

// Names of questions that have an answer, anywhere in the submission, so only the photos still
// in use are queued (a worker may have retaken or cleared one).
function answeredNames(sub) {
  const names = new Set();
  const walk = (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.every((x) => x && typeof x === 'object')) v.forEach(walk);
      else if (v !== undefined && v !== null && v !== '') names.add(k);
    }
  };
  walk(sub.data);
  for (const rows of Object.values(sub.repeats)) rows.forEach(walk);
  return names;
}

// The first top-level geopoint, split out for the submission's own gps_* fields.
function firstFix(spec, data) {
  const find = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'geopoint' && typeof data[n.name] === 'string') return data[n.name];
      if (n.type === 'group') { const inner = find(n.children || []); if (inner) return inner; }
    }
    return null;
  };
  const raw = find(spec.nodes || []);
  if (!raw) return {};
  const [lat, lon, , acc] = raw.split(' ').map(Number);
  return { gps_lat: lat, gps_lon: lon, ...(Number.isFinite(acc) ? { gps_accuracy: acc } : {}) };
}

function openForm(spec, draft) {
  const uid = state.session.user && state.session.user.id;
  const id = draft ? draft.id : crypto.randomUUID();
  const startedAt = draft ? draft.started_at : new Date().toISOString();
  const engine = new FormEngine(spec, draft ? { data: draft.data, repeats: draft.repeats } : {});
  const media = new Map(draft && draft.media ? Object.entries(draft.media) : []);
  const saveState = h('span', 'save-state');
  const saver = draftSaver({ id, spec, userId: uid, store: db, media, extra: () => ({ started_at: startedAt }) });
  const langs = availableLanguages(spec);
  const langFor = () => (langs.includes(state.lang) ? state.lang : langs[0]);

  let form;
  const notice = h('div', 'notice bad', { role: 'alert' });
  notice.hidden = true;

  const mount = () => {
    const lang = langFor();
    setLangToggle(langs, lang, (l) => { state.lang = l; store.set('evac.lang', l); mount(); });
    form = renderForm(engine, lang, {
      media,
      maxMediaBytes,
      onAnswer: async (eng, m) => {
        try { await saver(eng, m); saveState.textContent = t('saved'); } catch (e) { saveState.textContent = t('saving_failed'); throw e; }
      },
      onSaveError: () => {},
    });
    const holder = $('app').querySelector('.form-holder');
    if (holder) { holder.textContent = ''; holder.append(form); }
    return form;
  };

  const finish = h('button', 'btn btn-primary', { type: 'button', text: t('finish') });
  finish.addEventListener('click', async () => {
    const n = form.showAllErrors();
    if (n > 0) {
      notice.hidden = false;
      notice.textContent = t('errors_left', { n });
      return;
    }
    notice.hidden = true;
    finish.disabled = true;
    try {
      await saver.flush().catch(() => {});
      const sub = engine.toSubmission();
      const names = answeredNames(sub);
      const blobs = {};
      for (const [name, blob] of media) if (names.has(name)) blobs[name] = blob;
      const submission = {
        uuid: id,                       // the draft's id: finishing twice can never make two records
        form_id: spec.form_id,
        version: String(spec.version),
        data: sub.data,
        repeats: sub.repeats,
        device_id: deviceId(),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        user_id: uid,                   // the device
        person: ((state.session.projects || []).find((p) => p.key === spec._project.id) || {}).person || '',   // whose code this was filled under
        ...firstFix(spec, sub.data),
      };
      await db.enqueue(submission, blobs);   // submission and photos commit together
      await deleteDraftFully(db, id);
      syncOnce().catch(() => {});
      showDone();
    } catch (e) {
      finish.disabled = false;
      notice.hidden = false;
      notice.textContent = t('fail', { m: (e && e.message) || e });
    }
  });

  const home = h('button', 'btn', { type: 'button', text: t('home'), onclick: () => showHome() });
  const footer = h('div', 'form-footer', {}, h('div', 'inner', {}, home, finish, saveState));
  screen('form', specTitle(spec), notice, h('div', 'form-holder'));
  mount();
  document.body.append(footer);
  // Whatever the worker was in the middle of must reach disk if the tab is hidden or closed.
  const flush = () => { saver.flush().catch(() => {}); };
  window.addEventListener('pagehide', flush, { once: true });
  document.addEventListener('visibilitychange', flush);
}

async function showDone() {
  useChromeToggle(showDone);
  const body = h('section', 'card');
  const render = async () => {
    const n = await refreshStatus();
    body.textContent = '';
    body.append(
      h('h2', '', { text: t('done_title') }),
      h('p', 'big-number', { text: String(n) }),
      h('p', '', { text: n ? t('done_queue', { n }) : t('done_sent') }),
      ...(n && navigator.onLine === false ? [h('p', 'muted', { text: t('done_offline') })] : []));
    return n;
  };
  const again = h('button', 'btn btn-primary', { type: 'button', text: t('fill_another'), onclick: () => showHome() });
  screen('done', t('title'), body, again, h('button', 'btn', { type: 'button', text: t('home'), onclick: () => showHome() }));
  await render();
  // Watch the queue drain while she is looking at it.
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    if (state.screen !== 'done') { clearInterval(state.poll); return; }
    const n = await render();
    if (n === 0) clearInterval(state.poll);
  }, 2000);
}

// ---------------------------------------------------------------- start

async function main() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('online', refreshStatus);
  window.addEventListener('offline', refreshStatus);
  setInterval(refreshStatus, 5000);
  // Before anything else: if config.js still holds the placeholder, say so in plain words. Nothing
  // else can work, and a silent network error nobody can diagnose is worse than this screen.
  if (!(await isConfigured())) { showNotSetUp(); return; }
  try {
    await db.openDB();
  } catch (e) {
    screen('fatal', t('title'), h('div', 'notice bad', { text: t('fail', { m: (e && e.message) || e }) }));
    return;
  }
  const session = await readSession();
  if (!session) { showCode(); return; }
  state.session = session;
  startSync();
  await showHome();
}

// Not started when imported by the browser tests, which have no #app to draw into.
if (document.getElementById('app')) main();
