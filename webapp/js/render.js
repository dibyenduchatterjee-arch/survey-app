// Question renderers, GPS capture and photo handling: the screen an ASHA worker looks at.
//
// She is in a courtyard, holding a phone in one hand and often a child in the other, on a
// cheap Android in bright sun. So: one column, big touch targets (css/app.css holds the 44px
// floor), large type, no hover, no dialogs, and nothing that loses her work.
//
// WHAT IS DECIDED HERE, AND WHY
//   * Geopoint is the ODK string "lat lon altitude accuracy", space separated: the one format
//     the server parses at intake and in export (server/app/intake/geopoint.py). Never a dict.
//   * captureLocation waits for a GOOD fix but never forever. On timeout it rejects with the
//     best fix so far attached (err.best), and the widget OFFERS it; it is stored only when the
//     worker taps accept. A bad fix is never stored silently, and a courtyard with poor sky view
//     never strands a visit.
//   * Photos are downscaled until they are under the SERVER's max_media_bytes, which the caller
//     passes in (it arrives in the bootstrap reply). This file has no cap of its own: a cap
//     written twice is a cap that will disagree, and the failure would be a photo refused after
//     a day's work. Only the starting edge (a sensible size, not a limit) lives here.
//   * The dispatcher THROWS on a question type it does not know. A blank where a question
//     should be is a silent hole in the data; a thrown error is found the first day.
//   * Drafts: draftSaver() writes the whole answer set on every answer, and the last write wins
//     even when writes overlap. A dead battery loses at most the answer being typed.
//
// Everything that touches the outside world (geolocation, the media map, the draft store) is a
// parameter so it can be tested with a scripted stand-in.

import { translate } from './i18n.js';

export const SUPPORTED_TYPES = [
  'text', 'integer', 'decimal', 'date', 'time', 'dateTime', 'select_one', 'select_multiple',
  'geopoint', 'image', 'audio', 'video', 'file', 'barcode', 'note', 'calculate', 'group', 'repeat',
];

// ---------------------------------------------------------------- the words on the screen

// The form's own labels come from the spec; these are the app's. Hindi is the default.
const UI = {
  hi: {
    required: 'यह जवाब ज़रूरी है',
    add_row: 'जोड़ें',
    remove_row: 'हटाएँ',
    sure_remove: 'पक्का हटाएँ?',
    row: 'प्रविष्टि',
    choose: 'चुनें',
    no_choices: 'पहले ऊपर का सवाल भरें',
    clear: 'साफ़ करें',
    capture: 'लोकेशन लें',
    recapture: 'दोबारा लोकेशन लें',
    capturing: 'लोकेशन ढूँढ रहे हैं…',
    accuracy: 'सटीकता: लगभग {n} मीटर',
    got_fix: 'लोकेशन मिल गई',
    weak_fix: 'सिग्नल कमज़ोर है, अभी सबसे अच्छी लोकेशन लगभग {n} मीटर तक सटीक है',
    accept: 'यही लोकेशन रखें',
    retry: 'फिर से कोशिश करें',
    no_fix: 'लोकेशन नहीं मिली। खुली जगह में जाकर फिर कोशिश करें',
    denied: 'फ़ोन में इस ऐप को लोकेशन की अनुमति दें, फिर कोशिश करें',
    unavailable: 'इस फ़ोन में लोकेशन उपलब्ध नहीं है',
    photo: 'फोटो लें',
    retake: 'दोबारा फोटो लें',
    audio: 'आवाज़ रिकॉर्ड करें',
    video: 'वीडियो बनाएँ',
    file: 'फ़ाइल चुनें',
    scan: 'बारकोड स्कैन करें',
    scan_failed: 'बारकोड नहीं पढ़ा गया, नंबर खुद लिखें',
    working: 'थोड़ा रुकें…',
    too_large: 'फ़ाइल बहुत बड़ी है ({n} एमबी से कम चाहिए)',
    bad_image: 'यह फोटो नहीं खुल पाई, दोबारा लें',
    sign_here: 'यहाँ उँगली से दस्तख़त करें',
    saved: 'सेव हो गया',
    broken_form: 'फ़ॉर्म में तकनीकी गड़बड़ी है। भरना जारी रख सकते हैं, इसे सुपरवाइज़र को बताएँ।',
    errors_left: '{n} जवाब ठीक करने बाकी हैं',
  },
  en: {
    required: 'This answer is required',
    add_row: 'Add',
    remove_row: 'Remove',
    sure_remove: 'Really remove?',
    row: 'Entry',
    choose: 'Choose',
    no_choices: 'Answer the question above first',
    clear: 'Clear',
    capture: 'Get location',
    recapture: 'Get location again',
    capturing: 'Finding location…',
    accuracy: 'Accuracy: about {n} m',
    got_fix: 'Location found',
    weak_fix: 'Weak signal: the best location so far is only accurate to about {n} m',
    accept: 'Keep this location',
    retry: 'Try again',
    no_fix: 'No location found. Move to open ground and try again',
    denied: 'Allow this app to use location in the phone settings, then try again',
    unavailable: 'This phone cannot give a location',
    photo: 'Take photo',
    retake: 'Retake photo',
    audio: 'Record audio',
    video: 'Record video',
    file: 'Choose file',
    scan: 'Scan barcode',
    scan_failed: 'Could not read the barcode, type the number',
    working: 'One moment…',
    too_large: 'File is too large (must be under {n} MB)',
    bad_image: 'This photo could not be opened, take it again',
    sign_here: 'Sign here with your finger',
    saved: 'Saved',
    broken_form: 'This form has a technical fault. You can keep filling it; tell your supervisor.',
    errors_left: '{n} answers still need fixing',
  },
};

// The app's own wording for a form language: Hindi unless the form is shown in English.
export function ui(lang, key, vars = {}) {
  const table = typeof lang === 'string' && lang.startsWith('en') ? UI.en : UI.hi;
  let text = table[key] ?? UI.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
}

// ---------------------------------------------------------------- small DOM helpers

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  return node;
}

function button(text, className, onClick) {
  const b = el('button', 'btn ' + (className || ''), { type: 'button', text });
  b.addEventListener('click', onClick);
  return b;
}

const text = (v) => (v === undefined || v === null ? '' : String(v));

// ---------------------------------------------------------------- GPS

// How good a fix must be, and how long to wait for it. Field defaults: 20 m is a household
// within its own compound; 45 s is long enough for a cold start and short enough that nobody
// stands in the sun for a minute. A form can override per question later (Phase 2).
export const GPS_DEFAULTS = { minAccuracy: 20, timeoutMs: 45000 };

// The canonical wire string. Unknown altitude is 0, as ODK writes it, which keeps accuracy
// in the fourth slot where the server looks for it.
export function formatGeopoint({ lat, lon, altitude, accuracy }) {
  const n = (v) => String(Number(Number(v).toFixed(7)));
  const alt = Number.isFinite(altitude) ? altitude : 0;
  return [n(lat), n(lon), n(alt), n(Number.isFinite(accuracy) ? accuracy : 0)].join(' ');
}

function geoError(code, message, best) {
  const err = new Error(message);
  err.code = code;
  err.best = best;
  return err;
}

// Watches the GPS and resolves {lat, lon, altitude, accuracy} at the first fix within
// `minAccuracy` metres. On timeout it REJECTS with err.code 'timeout' and err.best = the most
// accurate fix seen (or null), so the UI can offer it for deliberate acceptance. Other codes:
// 'denied' (permission refused), 'unavailable' (no API), 'error'. The watch is always cleared.
// `onFix(fix)` is called for every reading, for a live "accuracy: 45 m" read-out.
export function captureLocation({ minAccuracy = GPS_DEFAULTS.minAccuracy, timeoutMs = GPS_DEFAULTS.timeoutMs, onFix } = {},
  geolocation = globalThis.navigator && globalThis.navigator.geolocation) {
  return new Promise((resolve, reject) => {
    if (!geolocation || typeof geolocation.watchPosition !== 'function') {
      reject(geoError('unavailable', 'This device has no geolocation', null));
      return;
    }
    let best = null;
    let id;
    let timer;
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { if (id !== undefined) geolocation.clearWatch(id); } catch { /* the watch is going away anyway */ }
      fn(value);
    };
    timer = setTimeout(() => finish(reject, geoError('timeout', 'No fix good enough in time', best)), timeoutMs);
    try {
      id = geolocation.watchPosition(
        (pos) => {
          const c = pos.coords;
          const fix = { lat: c.latitude, lon: c.longitude, altitude: Number.isFinite(c.altitude) ? c.altitude : null, accuracy: c.accuracy };
          if (!Number.isFinite(fix.accuracy)) return;
          if (!best || fix.accuracy < best.accuracy) best = fix;
          if (onFix) { try { onFix(fix, best); } catch { /* a broken read-out must not stop the capture */ } }
          if (fix.accuracy <= minAccuracy) finish(resolve, fix);
        },
        (e) => {
          // 1 = permission denied. A timeout or unavailable position from the browser is not
          // final: keep waiting, our own timer decides.
          if (e && e.code === 1) finish(reject, geoError('denied', 'Location permission was refused', best));
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
      );
    } catch (e) {
      finish(reject, geoError('error', String((e && e.message) || e), best));
    }
  });
}

// ---------------------------------------------------------------- photos

// Where downscaling starts. A size that suits a form photo, not a cap: the cap is the caller's.
const START_EDGE = 1600;
const MIN_EDGE = 160;
const JPEG_QUALITY = 0.8;

const toBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode the image'))), type, quality);
});

// Returns a JPEG under `maxBytes` (the server's max_media_bytes), shrinking the longest edge
// and retrying until it fits. A photo already a small JPEG under the cap is returned as it is.
// Throws if even the smallest size does not fit. `maxBytes` not a number means the caller does
// not know the cap yet: one pass at the starting edge, no size check.
export async function downscaleImage(file, maxBytes, startEdge = START_EDGE) {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity;
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (file.type === 'image/jpeg' && file.size <= cap && longest <= startEdge) return file;
    let edge = Math.min(longest, startEdge);
    for (;;) {
      const scale = edge / longest;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';               // a transparent PNG must not come out black
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
      if (blob.size <= cap) return blob;
      if (edge <= MIN_EDGE) throw new Error(`The photo cannot be made smaller than ${cap} bytes`);
      // File size follows area, so shrink by the square root of the overshoot, with margin.
      const next = Math.floor(edge * Math.min(0.85, Math.sqrt(cap / blob.size) * 0.95));
      edge = Math.max(MIN_EDGE, Math.min(next, edge - 1));
    }
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------- drafts

// Saves the whole answer set on every answer. Writes are serialised and coalesced: if one is
// in flight, the next snapshot waits and replaces any older waiting one, so the LAST answer
// always lands. saver(engine, media) is what renderForm calls; saver.flush() waits for disk.
//
// PHOTOS ARE NOT REWRITTEN ON EVERY KEYSTROKE. IndexedDB replaces a whole record on put, so a
// draft that carried its photos would copy several megabytes per character typed on a cheap
// phone. The answers go in the draft record (every answer); the blobs go in a companion record
// `<id>:media`, written only when the set of photos actually changed (compared by identity).
// loadDraft() puts them back together; deleteDraftFully() removes both.
export const mediaDraftId = (id) => `${id}:media`;

export async function loadDraft(store, id) {
  const draft = await store.getDraft(id);
  if (!draft) return draft;
  const rec = await store.getDraft(mediaDraftId(id));
  return { ...draft, media: rec && rec.media ? rec.media : (draft.media || {}) };
}

export async function deleteDraftFully(store, id) {
  await store.deleteDraft(mediaDraftId(id));
  await store.deleteDraft(id);
}

export function draftSaver({ id, spec, userId, store, extra = () => ({}), media: initialMedia }) {
  let waiting = null;
  let waitingMedia = null;
  let running = null;
  // What is already on disk, by identity. A restored draft starts from what it restored.
  let onDisk = new Map(initialMedia || []);
  const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  const drain = async () => {
    try {
      while (waiting || waitingMedia) {
        const mediaRec = waitingMedia;
        const snapshot = waiting;
        waitingMedia = null;
        waiting = null;
        try {
          if (mediaRec) await store.saveDraft(mediaRec.record);
          if (mediaRec) onDisk = mediaRec.map;
          if (snapshot) await store.saveDraft(snapshot);
        } catch (e) {
          waitingMedia = waitingMedia || mediaRec;   // try again with the next answer
          waiting = waiting || snapshot;
          throw e;
        }
      }
    } finally {
      running = null;
    }
  };
  const saver = (engine, media) => {
    const { data, repeats } = engine.toSubmission();
    const current = new Map(media || []);
    if (!same(current, onDisk)) {
      waitingMedia = { map: current, record: { id: mediaDraftId(id), kind: 'media', draft_id: id, media: Object.fromEntries(current) } };
    }
    waiting = {
      id,
      form_id: spec.form_id,
      version: String(spec.version),
      user_id: userId,
      data,
      repeats,
      ...extra(),
    };
    if (!running) running = drain();
    return running;
  };
  saver.flush = () => running || Promise.resolve();
  return saver;
}

// ---------------------------------------------------------------- the question frame

const entryOf = (x) => (x && x.node ? x : { node: x, name: x && x.name, path: x && x.name, depth: 0 });

function normalise(engine, lang, ctx = {}) {
  if (ctx.__ready) return ctx;
  return {
    __ready: true,
    engine,
    lang,
    media: ctx.media || new Map(),
    maxMediaBytes: ctx.maxMediaBytes,
    geolocation: 'geolocation' in ctx ? ctx.geolocation : (globalThis.navigator && globalThis.navigator.geolocation),
    gps: { ...GPS_DEFAULTS, ...(ctx.gps || {}) },
    touched: ctx.touched || new Set(),
    showAll: false,
    changed: ctx.changed || (() => {}),
  };
}

const capBytes = (ctx) => (typeof ctx.maxMediaBytes === 'function' ? ctx.maxMediaBytes() : ctx.maxMediaBytes);

// Every control answers through here, so draft saving, error display and visibility all follow
// from one call.
function answer(ctx, path, value) {
  ctx.engine.setAnswer(path, value);
  ctx.touched.add(path);
  ctx.changed(path);
}

function markTouchedOnBlur(control, ctx, path) {
  control.addEventListener('blur', () => {
    if (ctx.touched.has(path)) return;
    ctx.touched.add(path);
    ctx.changed(path);
  });
}

// A text-like <input> bound to one answer. Returns {control, sync}.
function textControl(entry, ctx, { tag = 'input', inputType = 'text', inputmode, transform = (v) => v, show = (v) => v, className = '' } = {}) {
  const input = el(tag, 'control ' + className, { type: tag === 'input' ? inputType : undefined, inputmode, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  if (tag === 'textarea') input.rows = 3;
  input.addEventListener('input', () => answer(ctx, entry.path, transform(input.value)));
  markTouchedOnBlur(input, ctx, entry.path);
  const sync = () => {
    const current = ctx.engine.getAnswer(entry.path);
    const shown = current === undefined ? '' : show(text(current));
    if (document.activeElement !== input && input.value !== shown) input.value = shown;
  };
  return { control: input, sync, input };
}

// Local UTC offset as +05:30, so a dateTime answer is never naive.
function offsetOf(date) {
  const mins = -date.getTimezoneOffset();
  const sign = mins >= 0 ? '+' : '-';
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

function choiceLabel(choice, ctx) {
  return translate(choice.label, ctx.lang, ctx.engine.fallbackLang) || text(choice.value);
}

// ---------------------------------------------------------------- the builders, one per type

// Each builder gets (entry, ctx) and returns {body, sync} or {body, sync, bare:true}.
const BUILDERS = {
  text(entry, ctx) {
    const multiline = /multiline/.test(text(entry.node.appearance));
    const { control, sync } = textControl(entry, ctx, { tag: multiline ? 'textarea' : 'input' });
    return { body: control, sync, control, aria: control };
  },

  integer(entry, ctx) {
    // A text box with a numeric keypad, not type=number: Chrome refuses Devanagari digits in
    // number inputs, and a Hindi keyboard types them. The engine reads both.
    const { control, sync } = textControl(entry, ctx, { inputmode: 'numeric' });
    return { body: control, sync, control, aria: control };
  },

  decimal(entry, ctx) {
    const { control, sync } = textControl(entry, ctx, { inputmode: 'decimal' });
    return { body: control, sync, control, aria: control };
  },

  date(entry, ctx) {
    const { control, sync } = textControl(entry, ctx, { inputType: 'date' });
    return { body: control, sync, control, aria: control };
  },

  time(entry, ctx) {
    // The picker gives HH:MM; the wire form carries seconds.
    const { control, sync } = textControl(entry, ctx, {
      inputType: 'time',
      transform: (v) => (/^\d\d:\d\d$/.test(v) ? v + ':00' : v),
      show: (v) => v.slice(0, 5),
    });
    return { body: control, sync, control, aria: control };
  },

  dateTime(entry, ctx) {
    // The picker gives local time with no zone; the answer carries the device offset.
    const { control, sync } = textControl(entry, ctx, {
      inputType: 'datetime-local',
      transform: (v) => (v ? `${v.length === 16 ? v + ':00' : v}${offsetOf(new Date(v))}` : v),
      show: (v) => v.slice(0, 16),
    });
    return { body: control, sync, control, aria: control };
  },

  select_one(entry, ctx) {
    const path = entry.path;
    const body = el('div', 'choices', { role: 'group' });
    let shown = null;
    let kind = null;
    let controlEl = null;
    const rebuild = (choices) => {
      body.textContent = '';
      if (choices.length === 0) {   // a filtered list can be empty until an earlier answer narrows it
        kind = 'none';
        body.append(el('p', 'hint', { text: ui(ctx.lang, 'no_choices') }));
        controlEl = null;
        return;
      }
      kind = choices.length > 6 ? 'select' : 'radio';
      if (kind === 'select') {
        const select = el('select', 'control');
        select.append(el('option', '', { value: '', text: ui(ctx.lang, 'choose') }));
        for (const c of choices) select.append(el('option', '', { value: text(c.value), text: choiceLabel(c, ctx) }));
        select.addEventListener('change', () => answer(ctx, path, select.value));
        markTouchedOnBlur(select, ctx, path);
        body.append(select);
        controlEl = select;
      } else {
        const group = el('div', 'radio-group', { role: 'radiogroup' });
        for (const c of choices) {
          const row = el('label', 'choice');
          const input = el('input', '', { type: 'radio', name: 'r_' + path, value: text(c.value) });
          input.addEventListener('change', () => { if (input.checked) answer(ctx, path, text(c.value)); });
          row.append(input, el('span', 'choice-text', { text: choiceLabel(c, ctx) }));
          group.append(row);
        }
        body.append(group);
        controlEl = group.querySelector('input');
        if (!entry.node.required) {
          const clear = button(ui(ctx.lang, 'clear'), 'btn-quiet clear', () => answer(ctx, path, ''));
          body.append(clear);
        }
      }
    };
    const sync = () => {
      const choices = ctx.engine.choices(path);
      const sig = JSON.stringify(choices.map((c) => c.value));
      if (sig !== shown) { shown = sig; rebuild(choices); }
      const current = text(ctx.engine.getAnswer(path));
      if (kind === 'none') return;
      if (kind === 'select') body.querySelector('select').value = current;
      else {
        for (const r of body.querySelectorAll('input[type=radio]')) r.checked = r.value === current && current !== '';
        const clear = body.querySelector('.clear');
        if (clear) clear.hidden = current === '';
      }
    };
    return { body, sync, aria: body, get control() { return controlEl; } };
  },

  select_multiple(entry, ctx) {
    const path = entry.path;
    const body = el('div', 'choices', { role: 'group' });
    let shown = null;
    const chosen = () => [...body.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => c.value);
    const rebuild = (choices) => {
      body.textContent = '';
      for (const c of choices) {
        const row = el('label', 'choice');
        const input = el('input', '', { type: 'checkbox', value: text(c.value) });
        input.addEventListener('change', () => answer(ctx, path, chosen()));
        row.append(input, el('span', 'choice-text', { text: choiceLabel(c, ctx) }));
        body.append(row);
      }
    };
    const sync = () => {
      const choices = ctx.engine.choices(path);
      const sig = JSON.stringify(choices.map((c) => c.value));
      if (sig !== shown) { shown = sig; rebuild(choices); }
      const current = new Set(text(ctx.engine.getAnswer(path)).split(/\s+/).filter(Boolean));
      for (const box of body.querySelectorAll('input[type=checkbox]')) box.checked = current.has(box.value);
    };
    return { body, sync, aria: body, get control() { return body.querySelector('input'); } };
  },

  geopoint(entry, ctx) {
    const path = entry.path;
    const body = el('div', 'geo');
    const status = el('p', 'geo-status', { 'aria-live': 'polite' });
    const capture = button(ui(ctx.lang, 'capture'), 'btn-primary capture', start);
    const accept = button(ui(ctx.lang, 'accept'), 'btn-primary accept', () => {
      if (!offered) return;
      answer(ctx, path, formatGeopoint(offered));
      offered = null;
      weak(false);
    });
    const retry = button(ui(ctx.lang, 'retry'), 'retry', start);
    accept.hidden = true;
    retry.hidden = true;
    body.append(capture, status, accept, retry);
    let offered = null;
    let running = false;

    function weak(on) { accept.hidden = !on; retry.hidden = !on; }

    function start() {
      if (running) return;
      running = true;
      offered = null;
      weak(false);
      capture.disabled = true;
      status.textContent = ui(ctx.lang, 'capturing');
      status.className = 'geo-status';
      captureLocation({
        ...ctx.gps,
        onFix: (fix) => { status.textContent = ui(ctx.lang, 'capturing') + ' ' + ui(ctx.lang, 'accuracy', { n: Math.round(fix.accuracy) }); },
      }, ctx.geolocation).then((fix) => {
        answer(ctx, path, formatGeopoint(fix));
      }, (err) => {
        status.className = 'geo-status geo-weak';
        if (err.code === 'timeout' && err.best) {
          offered = err.best;
          status.textContent = ui(ctx.lang, 'weak_fix', { n: Math.round(err.best.accuracy) });
          weak(true);
        } else {
          status.textContent = ui(ctx.lang, err.code === 'denied' ? 'denied' : err.code === 'unavailable' ? 'unavailable' : 'no_fix');
          retry.hidden = err.code === 'unavailable';
        }
      }).finally(() => {
        running = false;
        capture.disabled = false;
        sync();
      });
    }

    function sync() {
      const current = ctx.engine.getAnswer(path);
      capture.textContent = ui(ctx.lang, current ? 'recapture' : 'capture');
      if (running || offered) return;
      if (current) {
        const parts = text(current).split(' ');
        status.className = 'geo-status geo-ok';
        status.textContent = ui(ctx.lang, 'got_fix') + (parts[3] !== undefined ? ' · ' + ui(ctx.lang, 'accuracy', { n: Math.round(Number(parts[3])) }) : '');
      }
      // With no answer, whatever message is showing (an error) stays until the next attempt.
    }
    return { body, sync, control: capture };
  },

  image(entry, ctx) {
    if (/signature/.test(text(entry.node.appearance))) return signaturePad(entry, ctx);
    return mediaPicker(entry, ctx, { kind: 'image', accept: 'image/*', capture: 'environment', label: 'photo', retake: 'retake' });
  },
  audio(entry, ctx) {
    return mediaPicker(entry, ctx, { kind: 'audio', accept: 'audio/*', capture: true, label: 'audio', retake: 'retake' });
  },
  video(entry, ctx) {
    return mediaPicker(entry, ctx, { kind: 'video', accept: 'video/*', capture: 'environment', label: 'video', retake: 'retake' });
  },
  file(entry, ctx) {
    return mediaPicker(entry, ctx, { kind: 'file', accept: 'image/*,application/pdf', capture: false, label: 'file', retake: 'file' });
  },

  barcode(entry, ctx) {
    const { control, sync, input } = textControl(entry, ctx, { className: 'mono' });
    const body = el('div', 'barcode');
    body.append(control);
    if (typeof globalThis.BarcodeDetector === 'function') {
      const note = el('p', 'hint');
      const pick = el('input', 'visually-hidden', { type: 'file', accept: 'image/*', capture: 'environment', tabindex: '-1' });
      pick.addEventListener('change', async () => {
        const file = pick.files && pick.files[0];
        if (!file) return;
        try {
          const bitmap = await createImageBitmap(file);
          const found = await new globalThis.BarcodeDetector().detect(bitmap);
          bitmap.close();
          if (!found.length) throw new Error('none');
          input.value = found[0].rawValue;
          answer(ctx, entry.path, found[0].rawValue);
          note.textContent = '';
        } catch {
          note.textContent = ui(ctx.lang, 'scan_failed');
        }
        pick.value = '';
      });
      body.append(button(ui(ctx.lang, 'scan'), 'scan', () => pick.click()), pick, note);
    }
    return { body, sync, control: input, aria: input };
  },

  note(entry, ctx) {
    return { body: null, sync() {}, control: null };
  },
};

// An <input type=file> that captures from the camera or mic, keeps the file for upload under
// the question's name (the server matches media parts to questions by name), and answers with
// the file's name.
function mediaPicker(entry, ctx, { kind, accept, capture, label, retake }) {
  const path = entry.path;
  const name = entry.node.name;
  const body = el('div', 'media');
  const input = el('input', 'visually-hidden', { type: 'file', accept, capture: capture === true ? '' : capture || undefined, tabindex: '-1' });
  if (capture === true) input.setAttribute('capture', '');
  const trigger = button(ui(ctx.lang, label), 'btn-primary pick', () => input.click());
  const status = el('p', 'media-status', { 'aria-live': 'polite' });
  const preview = el('div', 'preview');
  const clear = button(ui(ctx.lang, 'clear'), 'btn-quiet clear', () => {
    ctx.media.delete(name);
    answer(ctx, path, '');
  });
  body.append(trigger, input, status, preview, clear);
  let url = null;
  let previewed = null;

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    status.className = 'media-status';
    status.textContent = ui(ctx.lang, 'working');
    trigger.disabled = true;
    try {
      let blob = file;
      const cap = capBytes(ctx);
      if (kind === 'image') {
        try {
          blob = await downscaleImage(file, cap);
        } catch (e) {
          if (/cannot be made smaller/.test(e.message)) throw Object.assign(new Error('too_large'), { cap });
          throw Object.assign(new Error('bad_image'), {});
        }
      } else if (kind === 'file' && file.type.startsWith('image/')) {
        blob = await downscaleImage(file, cap);
      }
      if (Number.isFinite(cap) && blob.size > cap) throw Object.assign(new Error('too_large'), { cap });
      ctx.media.set(name, blob);
      answer(ctx, path, `${name}.${extensionOf(blob, file)}`);
      status.textContent = '';
    } catch (e) {
      status.className = 'media-status media-bad';
      status.textContent = e.message === 'too_large'
        ? ui(ctx.lang, 'too_large', { n: Math.floor((e.cap || 0) / 1048576) })
        : ui(ctx.lang, 'bad_image');
    } finally {
      trigger.disabled = false;
      input.value = '';
    }
  });

  const sync = () => {
    const have = ctx.media.get(name);
    const answered = ctx.engine.getAnswer(path) !== undefined;
    clear.hidden = !answered;
    trigger.textContent = ui(ctx.lang, answered ? retake : label);
    if (have !== previewed) {
      previewed = have;
      if (url) URL.revokeObjectURL(url);
      url = null;
      preview.textContent = '';
      if (have && kind === 'image') {
        url = URL.createObjectURL(have);
        preview.append(el('img', 'photo', { src: url, alt: '' }));
      }
    }
  };
  return { body, sync, control: trigger };
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf' };
function extensionOf(blob, file) {
  return EXTENSIONS[blob.type] || EXTENSIONS[file.type] || (/\.([a-z0-9]{1,5})$/i.exec(file.name || '') || [])[1] || 'bin';
}

// A signature is an image drawn on a canvas, stored as a small PNG.
function signaturePad(entry, ctx) {
  const path = entry.path;
  const name = entry.node.name;
  const body = el('div', 'signature');
  const canvas = el('canvas', 'pad', { width: 720, height: 280, 'aria-label': ui(ctx.lang, 'sign_here') });
  const hint = el('p', 'hint', { text: ui(ctx.lang, 'sign_here') });
  const clear = button(ui(ctx.lang, 'clear'), 'btn-quiet clear', () => {
    pad.clearRect(0, 0, canvas.width, canvas.height);
    ctx.media.delete(name);
    drawn = null;
    answer(ctx, path, '');
  });
  body.append(canvas, hint, clear);
  const pad = canvas.getContext('2d');
  pad.lineWidth = 5; pad.lineCap = 'round'; pad.lineJoin = 'round'; pad.strokeStyle = '#111';
  let down = false;
  let inked = false;
  let drawn = null;
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
  };
  canvas.addEventListener('pointerdown', (e) => {
    down = true; inked = true;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    pad.beginPath(); pad.moveTo(x, y); pad.lineTo(x + 0.01, y); pad.stroke();
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    const [x, y] = at(e);
    pad.lineTo(x, y); pad.stroke();
    e.preventDefault();
  });
  const finish = async () => {
    if (!down) return;
    down = false;
    if (!inked) return;
    const blob = await toBlob(canvas, 'image/png');
    drawn = blob;
    ctx.media.set(name, blob);
    answer(ctx, path, `${name}.png`);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  const sync = () => {
    clear.hidden = ctx.engine.getAnswer(path) === undefined;
    const have = ctx.media.get(name);
    if (have && have !== drawn) {   // a draft was restored: put the signature back on the pad
      drawn = have;
      createImageBitmap(have).then((b) => { pad.drawImage(b, 0, 0, canvas.width, canvas.height); b.close(); inked = true; }, () => {});
    }
  };
  return { body, sync, control: canvas };
}

// ---------------------------------------------------------------- the dispatcher

// Renders one question (or group, repeat, note, calculate) as an element. `entryOrNode` is a
// visibleNodes() entry {node, path, ...} or a bare spec node. Throws on an unknown type.
// The returned element has .refresh(failures) to bring it in line with the engine, and
// .control, the main focusable control, when there is one.
export function renderNode(entryOrNode, engine, lang, ctxIn) {
  const entry = entryOf(entryOrNode);
  const node = entry.node;
  const ctx = normalise(engine, lang, ctxIn);
  if (!node || !SUPPORTED_TYPES.includes(node.type)) {
    throw new Error(`Unsupported question type "${node && node.type}" for "${entry.path}"`);
  }
  const q = el('div', `q q-${node.type}`);
  q.dataset.path = entry.path;
  q.dataset.type = node.type;
  q.dataset.depth = String(entry.depth || 0);
  const title = translate(node.label, lang, engine.fallbackLang);
  const hintText = translate(node.hint, lang, engine.fallbackLang);

  if (node.type === 'calculate') {
    q.hidden = true;
    q.refresh = () => {};
    return q;
  }

  if (node.type === 'group') {
    q.append(el('h2', 'group-title', { text: title }));
    q.refresh = () => {};
    return q;
  }

  if (node.type === 'repeat') {
    q.append(el('h2', 'group-title', { text: title }));
    const count = el('span', 'row-count');
    const add = button(ui(lang, 'add_row'), 'btn-primary add-row', () => {
      engine.addRepeatRow(entry.path);
      ctx.changed(entry.path);
    });
    const bar = el('div', 'repeat-bar');
    bar.append(count, add);
    q.append(bar);
    q.refresh = () => { count.textContent = String(engine.rowCount(entry.path)); };
    q.refresh();
    return q;
  }

  const built = BUILDERS[node.type](entry, ctx);
  built.sync();   // choice lists are built on first sync, so the controls exist from here on
  const id = 'q_' + entry.path.replace(/[^A-Za-z0-9_]/g, '_');
  const labelEl = el('div', 'q-label');
  labelEl.append(el('span', 'q-title', { text: title, id: id + '_t' }));
  if (node.required) labelEl.append(el('span', 'req', { text: ' *', 'aria-hidden': 'true' }));
  q.append(labelEl);
  if (hintText) q.append(el('p', 'hint', { text: hintText, id: id + '_h' }));
  if (built.body) q.append(built.body);
  const err = el('p', 'err', { role: 'alert', id: id + '_err' });
  q.append(err);
  if (built.aria) {
    built.aria.setAttribute('aria-labelledby', id + '_t');
    built.aria.setAttribute('aria-describedby', (hintText ? id + '_h ' : '') + id + '_err');
    if (node.required) built.aria.setAttribute('aria-required', 'true');
  }
  Object.defineProperty(q, 'control', { get: () => built.control });
  q.refresh = (failures) => {
    built.sync();
    const list = failures || engine.errors();
    const own = list.find((f) => f.question === entry.path && (f.rule === 'required' || f.rule === 'constraint'));
    const visible = own && (ctx.showAll || ctx.touched.has(entry.path));
    err.textContent = visible ? (own.message || ui(lang, 'required')) : '';
    q.classList.toggle('has-error', Boolean(visible));
    if (built.aria) built.aria.setAttribute('aria-invalid', visible ? 'true' : 'false');
  };
  q.refresh();
  return q;
}

// ---------------------------------------------------------------- the whole form

// Renders every visible question as one column and keeps it in step with the engine. Inputs
// the worker is typing in are KEPT (never rebuilt) so focus and the keyboard stay put.
// Options: media (Map of question name to Blob), maxMediaBytes (number or function),
// geolocation (default navigator.geolocation), gps {minAccuracy, timeoutMs},
// onAnswer(engine, media, path) called after every answer (wire draftSaver here),
// onSaveError(err).
// Returns the root element with .engine, .media, .refresh(), .showAllErrors().
export function renderForm(engine, lang, opts = {}) {
  if (engine.lang !== lang) engine.setLanguage(lang);
  const root = el('div', 'form');
  const banner = el('div', 'form-error', { role: 'alert' });
  banner.hidden = true;
  const list = el('div', 'form-list');
  root.append(banner, list);

  const ctx = normalise(engine, lang, {
    media: opts.media,
    maxMediaBytes: opts.maxMediaBytes,
    geolocation: 'geolocation' in opts ? opts.geolocation : (globalThis.navigator && globalThis.navigator.geolocation),
    gps: opts.gps,
    changed: (path) => {
      if (opts.onAnswer) {
        try {
          Promise.resolve(opts.onAnswer(engine, ctx.media, path)).catch((e) => (opts.onSaveError || console.error)(e));
        } catch (e) {
          (opts.onSaveError || console.error)(e);
        }
      }
      refresh();
    },
  });

  const cache = new Map();   // key -> element, kept while the key stays visible

  function rowHead(prefix, repeats) {
    const key = 'row:' + prefix;
    let head = cache.get(key);
    const m = /^(.*)\[(\d+)\]$/.exec(prefix);
    const repeatPath = m[1];
    const n = Number(m[2]);
    const name = repeatPath.split('/').pop();
    const repeat = repeats.get(name);
    if (!head) {
      head = el('div', 'row-head');
      head.dataset.row = prefix;
      head.append(el('span', 'row-title'));
      let armed = null;
      const remove = button(ui(lang, 'remove_row'), 'btn-quiet remove-row', () => {
        if (!armed) {
          remove.textContent = ui(lang, 'sure_remove');
          remove.classList.add('armed');
          armed = setTimeout(() => { armed = null; remove.textContent = ui(lang, 'remove_row'); remove.classList.remove('armed'); }, 4000);
          return;
        }
        clearTimeout(armed);
        engine.removeRepeatRow(head.dataset.repeat, Number(head.dataset.n) - 1);
        ctx.changed(head.dataset.repeat);
      });
      head.append(remove);
      cache.set(key, head);
    }
    head.dataset.repeat = repeatPath;
    head.dataset.n = String(n);
    head.querySelector('.row-title').textContent = `${repeat ? translate(repeat.node.label, lang, engine.fallbackLang) : ui(lang, 'row')} ${n}`;
    return head;
  }

  function refresh() {
    const entries = engine.visibleNodes();
    const failures = engine.errors();
    const repeats = new Map(entries.filter((e) => e.node.type === 'repeat').map((e) => [e.name, e]));
    const wanted = [];
    const seen = new Set();
    const emitted = new Set();
    for (const entry of entries) {
      // A row header the first time one of its questions (or nested repeats) appears.
      const segments = entry.path.split('/');
      let acc = '';
      for (let i = 0; i < segments.length - 1; i++) {
        acc = acc ? `${acc}/${segments[i]}` : segments[i];
        if (/\[\d+\]$/.test(segments[i]) && !emitted.has(acc)) {
          emitted.add(acc);
          wanted.push(rowHead(acc, repeats));
          seen.add('row:' + acc);
        }
      }
      let node = cache.get(entry.path);
      if (!node || node.dataset.type !== entry.node.type) {
        node = renderNode(entry, engine, lang, ctx);
        cache.set(entry.path, node);
      }
      wanted.push(node);
      seen.add(entry.path);
    }
    for (const [key, node] of cache) {
      if (!seen.has(key)) { node.remove(); cache.delete(key); }
    }
    wanted.forEach((node, i) => { if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null); });
    for (const node of wanted) if (node.refresh) node.refresh(failures);

    // A broken expression is the form author's fault, not the worker's. Say so, don't block.
    const broken = failures.filter((f) => f.rule === 'error');
    banner.hidden = broken.length === 0;
    banner.textContent = '';
    if (broken.length) {
      banner.append(el('strong', '', { text: ui(lang, 'broken_form') }));
      for (const f of broken) banner.append(el('small', 'detail', { text: f.message || '' }));
    }
  }

  root.engine = engine;
  root.media = ctx.media;
  root.refresh = refresh;
  // Shows every outstanding required/constraint error, scrolls to the first, and returns how
  // many there are. Called when she taps Finish.
  root.showAllErrors = () => {
    ctx.showAll = true;
    refresh();
    const count = engine.errors().filter((f) => f.rule === 'required' || f.rule === 'constraint').length;
    const first = list.querySelector('.has-error');
    if (first) {
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (first.control && first.control.focus) first.control.focus({ preventScroll: true });
    }
    return count;
  };
  refresh();
  return root;
}
