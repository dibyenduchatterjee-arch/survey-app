// The enumerator app: log in, pick a form, fill it, finish, watch the queue drain.
//
// Deliberately thin. The logic lives in the modules it wires together:
//   db.js (drafts, queue)  auth.js (login)  sync.js (bootstrap, upload)
//   formengine.js (answers, validation)  render.js (the screen, GPS, photos, drafts)
//
// Two rules that matter more than the rest:
//   * A draft is written on every answer (render.js draftSaver), so a dead battery loses at most
//     the character being typed.
//   * The submission's uuid IS the draft's id. If the phone dies after the submission is queued
//     but before the draft is deleted, finishing the resumed draft sends the same uuid and the
//     server answers 200 as a replay, never a duplicate household.

import * as db from './db.js';
import { login, logout } from './auth.js';
import { bootstrap, startSync, syncOnce, listRejected, retryRejected } from './sync.js';
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
    username: 'यूज़रनेम',
    password: 'पासवर्ड',
    login: 'लॉगिन करें',
    logging_in: 'लॉगिन हो रहा है…',
    login_failed: 'लॉगिन नहीं हो पाया',
    session_over: 'आपका लॉगिन समाप्त हो गया है। दोबारा लॉगिन करें। भरा हुआ काम फ़ोन में सुरक्षित है।',
    downloading: 'फ़ॉर्म डाउनलोड हो रहे हैं…',
    forms: 'फ़ॉर्म भरें',
    no_forms: 'अभी कोई फ़ॉर्म नहीं मिला। इंटरनेट चालू करके फिर खोलें।',
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
    logout: 'लॉग आउट',
    logout_pending: 'अभी {n} फ़ॉर्म भेजे नहीं गए। फिर भी लॉग आउट करें?',
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
  },
  en: {
    title: 'Evidence Action Survey',
    username: 'Username',
    password: 'Password',
    login: 'Log in',
    logging_in: 'Logging in…',
    login_failed: 'Could not log in',
    session_over: 'Your login has ended. Log in again. Your saved work is safe on this phone.',
    downloading: 'Downloading forms…',
    forms: 'Fill a form',
    no_forms: 'No forms yet. Turn on the internet and open this again.',
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
    logout: 'Log out',
    logout_pending: '{n} forms have not been sent yet. Log out anyway?',
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
  },
};

const state = { lang: store.get('evac.lang') === 'en' ? 'en' : 'hi', session: null, screen: null, poll: null };

function t(key, vars = {}) {
  let s = (T[state.lang] || T.hi)[key] ?? T.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
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

function showLogin(message) {
  useChromeToggle(() => showLogin(message));
  const user = h('input', 'control', { id: 'u', type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', required: true });
  const pass = h('input', 'control', { id: 'p', type: 'password', autocomplete: 'current-password', required: true });
  const err = h('p', 'err', { role: 'alert' });
  const go = h('button', 'btn btn-primary', { type: 'submit', text: t('login') });
  const form = h('form', 'card', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      go.disabled = true;
      go.textContent = t('logging_in');
      try {
        await login(user.value.trim(), pass.value);
        await afterLogin();
      } catch (ex) {
        err.textContent = `${t('login_failed')}: ${ex.message || ex}`;
        go.disabled = false;
        go.textContent = t('login');
      }
    },
  },
  h('div', 'field', {}, h('label', '', { for: 'u', text: t('username') }), user),
  h('div', 'field', {}, h('label', '', { for: 'p', text: t('password') }), pass),
  err, go);
  screen('login', t('title'), message ? h('div', 'notice', { text: message }) : null, form);
}

async function afterLogin() {
  state.session = await db.getSession();
  screen('boot', t('title'), h('p', 'card', { text: t('downloading') }));
  let boot = null;
  if (navigator.onLine !== false) {
    try { boot = await bootstrap(); rememberCap(boot); } catch { /* offline after all: use what is on the phone */ }
  }
  startSync();
  await showHome(boot);
}

// The newest version of each form this phone holds. A draft stays on its own version.
async function latestForms() {
  const all = await db.listForms();
  const best = new Map();
  for (const spec of all) {
    const cur = best.get(spec.form_id);
    if (!cur || compareVersions(spec.version, cur.version) > 0) best.set(spec.form_id, spec);
  }
  return [...best.values()];
}

function compareVersions(a, b) {
  const x = String(a);
  const y = String(b);
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
  return x < y ? -1 : x > y ? 1 : 0;
}

const specTitle = (spec) => translate(spec.title, state.lang, spec.default_language) || spec.form_id;

async function showHome(boot) {
  useChromeToggle(() => showHome(boot));
  const session = (state.session = await db.getSession());
  if (!session || session.needs_login) { showLogin(t('session_over')); return; }
  const uid = session.user && session.user.id;

  const forms = await latestForms();
  const drafts = (await db.listDrafts()).filter((d) => d.kind !== 'media').filter((d) => d.user_id === undefined || d.user_id === uid)
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  const pending = await db.queueLength();
  const rejected = await listRejected().catch(() => []);

  const parts = [];
  if (boot && boot.errors && boot.errors.length) {
    parts.push(h('div', 'notice', { text: boot.errors.map((e) => `${e.form_id || e.dataset}: ${e.error}`).join('\n') }));
  }

  // Queue
  const sendBtn = h('button', 'btn', {
    type: 'button',
    text: t('send_now'),
    onclick: async () => {
      sendBtn.disabled = true;
      sendBtn.textContent = t('sending');
      try { await syncOnce(); } catch { /* shown by the count below */ }
      showHome(boot);
    },
  });
  parts.push(h('section', 'card', {},
    h('p', 'big-number', { text: String(pending) }),
    h('p', pending ? '' : 'muted', { text: pending ? t('pending', { n: pending }) : t('all_sent') }),
    pending ? sendBtn : null));

  // Forms
  const formList = h('ul', 'list');
  for (const spec of forms) {
    formList.append(h('li', '', {}, h('button', 'btn btn-primary', {
      type: 'button',
      text: specTitle(spec),
      onclick: () => openForm(spec, null),
    })));
  }
  parts.push(h('section', 'card', {}, h('h2', '', { text: t('forms') }),
    forms.length ? formList : h('p', 'muted', { text: t('no_forms') })));

  // Drafts
  if (drafts.length) {
    const list = h('ul', 'list');
    for (const d of drafts) {
      const when = d.updated_at ? new Date(d.updated_at).toLocaleString(state.lang === 'en' ? 'en-IN' : 'hi-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
      const label = `${d.form_id} · ${when}`;
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
        h('p', '', { text: `${r.form_id}: ${r.message || r.code || r.status}` }),
        h('button', 'btn', { type: 'button', text: t('retry'), onclick: async () => { await retryRejected(r.uuid); showHome(boot); } })));
    }
    parts.push(h('section', 'card', {}, h('div', 'notice bad', { text: t('rejected') }), list));
  }

  // Logout
  let sure = false;
  const out = h('button', 'btn btn-quiet', { type: 'button', text: t('logout') });
  out.addEventListener('click', async () => {
    if (pending && !sure) { sure = true; out.textContent = t('logout_pending', { n: pending }); return; }
    await logout();
    showLogin();
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
        user_id: uid,                   // the sync queue skips submissions that belong to another user
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
  try {
    await db.openDB();
  } catch (e) {
    screen('fatal', t('title'), h('div', 'notice bad', { text: t('fail', { m: (e && e.message) || e }) }));
    return;
  }
  const session = await db.getSession();
  if (!session) { showLogin(); return; }
  if (session.needs_login) { showLogin(t('session_over')); return; }
  state.session = session;
  startSync();
  await showHome();
}

main();
