// Browser tests for js/render.js: the screen an ASHA worker actually looks at.
// Real DOM, real canvas, real IndexedDB. Geolocation is a scripted stand-in because
// a test cannot walk outside; everything else is the browser's own.
import { FormEngine } from '../js/formengine.js';
import * as db from '../js/db.js';
import {
  renderNode, renderForm, captureLocation, downscaleImage, formatGeopoint, draftSaver, loadDraft, rememberMediaCap, mediaCap, FALLBACK_MEDIA_BYTES, SUPPORTED_TYPES,
} from '../js/render.js';

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Waits on a deadline of real time, not a count of timer ticks: a hidden pane throttles timers.
async function until(cond, ms = 20000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(25);
}
const fixture = async () => (await fetch(new URL('./fixtures/amb_asha_visit.spec.json', import.meta.url))).json();

// A single-language spec holding one node of every Phase 1 type.
const choices = { yn: [{ value: 'yes', label: { default: 'Yes' } }, { value: 'no', label: { default: 'No' } }] };
const lbl = text => ({ default: text });
function everyTypeSpec() {
  return {
    form_id: 't', version: '1', title: lbl('t'), languages: ['default'], default_language: 'default', choices,
    nodes: [
      { type: 'text', name: 'q_text', label: lbl('Text') },
      { type: 'integer', name: 'q_integer', label: lbl('Integer') },
      { type: 'decimal', name: 'q_decimal', label: lbl('Decimal') },
      { type: 'date', name: 'q_date', label: lbl('Date') },
      { type: 'time', name: 'q_time', label: lbl('Time') },
      { type: 'dateTime', name: 'q_datetime', label: lbl('DateTime') },
      { type: 'select_one', name: 'q_one', label: lbl('One'), choices_ref: 'yn' },
      { type: 'select_multiple', name: 'q_many', label: lbl('Many'), choices_ref: 'yn' },
      { type: 'geopoint', name: 'q_geo', label: lbl('Geo') },
      { type: 'image', name: 'q_image', label: lbl('Image') },
      { type: 'image', name: 'q_sign', label: lbl('Sign'), appearance: 'signature' },
      { type: 'audio', name: 'q_audio', label: lbl('Audio') },
      { type: 'video', name: 'q_video', label: lbl('Video') },
      { type: 'file', name: 'q_file', label: lbl('File') },
      { type: 'barcode', name: 'q_barcode', label: lbl('Barcode') },
      { type: 'note', name: 'q_note', label: lbl('Note') },
      { type: 'calculate', name: 'q_calc', calculate: '1 + 1' },
      { type: 'group', name: 'g', label: lbl('Group'), children: [{ type: 'text', name: 'g_text', label: lbl('In group') }] },
      { type: 'repeat', name: 'r', label: lbl('Repeat'), children: [{ type: 'text', name: 'r_text', label: lbl('In repeat') }] },
    ],
  };
}

const mount = el => { const host = document.createElement('div'); host.append(el); document.body.append(host); return host; };
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
function type(el, value) { el.value = value; fire(el, 'input'); }
const cssReady = new Promise(resolve => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/app.css', import.meta.url).href;
  link.onload = link.onerror = resolve;
  document.head.append(link);
});

// ---------------------------------------------------------------- renderers

export async function test_every_spec_type_renders_an_input() {
  const spec = everyTypeSpec();
  const engine = new FormEngine(spec);
  const controls = 'input, select, textarea, button, canvas';
  const kinds = new Set();
  for (const node of spec.nodes) {
    const el = renderNode(node, engine, 'default');
    assert(el instanceof HTMLElement, node.type + ' did not render an element');
    assert(!el.querySelector('.unsupported') && !el.classList.contains('unsupported'), node.type + ' rendered an unsupported placeholder');
    assert(el.textContent.trim() !== '' || node.type === 'calculate', node.type + ' rendered with no text');
    if (!['note', 'calculate', 'group'].includes(node.type)) {
      assert(el.querySelector(controls), node.type + ' rendered no control');
    }
    if (node.type === 'calculate') assert(el.hidden, 'a calculate must stay out of sight');
    kinds.add(node.type);
  }
  for (const t of SUPPORTED_TYPES) assert(kinds.has(t), t + ' is supported by the dispatcher but not covered by this test');
  // The signature pad is a canvas, not a file picker.
  assert(renderNode(spec.nodes.find(n => n.name === 'q_sign'), engine, 'default').querySelector('canvas'), 'signature needs a canvas');
  // And a whole form shows a control for every question the engine makes visible.
  const form = renderForm(engine, 'default', { geolocation: null });
  for (const name of ['q_text', 'q_integer', 'q_date', 'q_one', 'q_many', 'g_text']) {
    assert(form.querySelector(`[data-path="${name}"] ${controls}`), name + ' has no control in the form');
  }
  assert(!form.querySelector('[data-path="q_calc"]') || form.querySelector('[data-path="q_calc"]').hidden, 'calculate visible');
  // An unknown type is loud, never a blank.
  let threw = null;
  try { renderNode({ type: 'hologram', name: 'h', label: lbl('H') }, engine, 'default'); } catch (e) { threw = e; }
  assert(threw && /hologram/.test(threw.message), 'an unknown type must throw, naming the type');
}

export async function test_a_select_one_renders_its_choice_labels_in_hindi() {
  const spec = await fixture();
  const engine = new FormEngine(spec);
  const form = renderForm(engine, 'hi', { geolocation: null });
  const q = form.querySelector('[data-path="district"]');
  assert(q, 'district question missing');
  const text = q.textContent;
  for (const word of ['ज़िला', 'पटना', 'गया', 'मुज़फ़्फ़रपुर']) assert(text.includes(word), 'missing Hindi text: ' + word);
  assert(!/Muzaffarpur|District/.test(text), 'English leaked into the Hindi screen');
  // Choosing one answers the engine with the choice's value, not its label.
  const radio = [...q.querySelectorAll('input[type=radio]')].find(r => r.value === 'muzaffarpur');
  assert(radio, 'no radio for muzaffarpur');
  radio.checked = true; fire(radio, 'change');
  eq(engine.getAnswer('district'), 'muzaffarpur');
  // Switching language switches every label.
  const en = renderForm(engine, 'en', { geolocation: null });
  assert(en.querySelector('[data-path="district"]').textContent.includes('Muzaffarpur'), 'English labels missing');
}

export async function test_typing_an_answer_updates_the_engine() {
  const spec = everyTypeSpec();
  const engine = new FormEngine(spec);
  const form = renderForm(engine, 'default', { geolocation: null });
  mount(form);
  type(form.querySelector('[data-path="q_text"] input, [data-path="q_text"] textarea'), 'सीता देवी');
  eq(engine.getAnswer('q_text'), 'सीता देवी');
  const int = form.querySelector('[data-path="q_integer"] input');
  type(int, '7');
  eq(String(engine.getAnswer('q_integer')), '7');
  // Typing in a field must not lose focus to a re-render of the form.
  int.focus(); type(int, '72');
  assert(document.activeElement === int, 'the input lost focus while typing');
  // A multi-select stores a space separated string, as the server expects.
  const boxes = form.querySelectorAll('[data-path="q_many"] input[type=checkbox]');
  boxes[0].checked = true; fire(boxes[0], 'change');
  boxes[1].checked = true; fire(boxes[1], 'change');
  eq(engine.getAnswer('q_many'), 'yes no');
  // A repeat gets rows the enumerator can add and remove.
  form.querySelector('[data-path="r"] button').click();
  const row = form.querySelector('[data-path="r[1]/r_text"] input, [data-path="r[1]/r_text"] textarea');
  assert(row, 'adding a repeat row showed no question for it');
  type(row, 'one');
  eq(engine.getAnswer('r[1]/r_text'), 'one');
  form.remove();
}

export async function test_a_constraint_error_is_shown_next_to_the_question() {
  await cssReady;
  const spec = await fixture();
  const engine = new FormEngine(spec);
  const form = renderForm(engine, 'hi', { geolocation: null });
  mount(form);
  const q = form.querySelector('[data-path="household_children"]');
  assert(q.querySelector('.err') === null || q.querySelector('.err').textContent === '', 'an untouched question must not shout');
  type(q.querySelector('input'), '15');
  const err = q.querySelector('.err');
  assert(err && err.textContent.includes('कृपया शून्य से दस के बीच की संख्या डालें'), 'constraint message missing next to the question');
  assert(err.getAttribute('role') === 'alert' || q.getAttribute('aria-live') || err.getAttribute('aria-live'), 'the error is not announced');
  assert(q.querySelector('input').getAttribute('aria-invalid') === 'true', 'the field is not marked invalid');
  // Correcting it clears the message.
  type(q.querySelector('input'), '3');
  assert(q.querySelector('.err').textContent === '', 'the error stayed after the answer was corrected');
  // The other languages' messages follow the toggle.
  engine.setLanguage('en');
  const en = renderForm(engine, 'en', { geolocation: null });
  mount(en);
  type(en.querySelector('[data-path="household_children"] input'), '15');
  assert(en.querySelector('[data-path="household_children"] .err').textContent.includes('Enter a number from 0 to 10'));
  form.remove(); en.remove();
}

export async function test_a_required_question_complains_only_once_the_worker_has_touched_it() {
  const spec = await fixture();
  const engine = new FormEngine(spec);
  const form = renderForm(engine, 'hi', { geolocation: null });
  mount(form);
  const q = form.querySelector('[data-path="asha_name"]');
  assert(q.querySelector('.err').textContent === '', 'required error shown before the worker did anything');
  const input = q.querySelector('input');
  input.dispatchEvent(new Event('blur'));   // a real blur needs window focus, which a test run may not have
  assert(q.querySelector('.err').textContent !== '', 'a required question left blank after a visit shows no error');
  // Finalising shows every outstanding error at once and says how many.
  const n = form.showAllErrors();
  assert(n >= 3, 'expected several outstanding errors, got ' + n);
  form.remove();
}

export async function test_every_failure_rule_is_surfaced() {
  const spec = {
    form_id: 't', version: '1', title: lbl('t'), languages: ['default'], default_language: 'default', choices,
    nodes: [
      { type: 'integer', name: 'a', label: lbl('A'), required: true, constraint: '. > 0', constraint_message: lbl('Must be positive') },
      { type: 'integer', name: 'b', label: lbl('B'), constraint: 'nonsense_fn(.)' },
    ],
  };
  const engine = new FormEngine(spec);
  const form = renderForm(engine, 'default', { geolocation: null });
  mount(form);
  type(form.querySelector('[data-path="a"] input'), '-1');       // constraint
  assert(form.querySelector('[data-path="a"] .err').textContent.includes('Must be positive'), 'constraint rule not shown');
  type(form.querySelector('[data-path="a"] input'), '');          // required
  form.showAllErrors();
  assert(form.querySelector('[data-path="a"] .err').textContent !== '', 'required rule not shown');
  type(form.querySelector('[data-path="b"] input'), '4');         // rule "error": the form itself is broken
  const banner = form.querySelector('.form-error');
  assert(banner && !banner.hidden && banner.textContent.trim() !== '', 'a broken form expression must show a banner, not vanish');
  form.remove();
}

export async function test_touch_targets_are_at_least_44px() {
  await cssReady;
  const spec = await fixture();
  const engine = new FormEngine(spec);
  const form = renderForm(engine, 'hi', { geolocation: null });
  const host = mount(form);
  host.style.width = '360px';   // a cheap phone
  const small = [];
  for (const el of form.querySelectorAll('input:not([type=radio]):not([type=checkbox]):not([type=file]):not([hidden]), select, textarea, button, label.choice')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.height < 44 - 0.5) small.push((el.className || el.tagName) + ' ' + Math.round(r.height) + 'px');
  }
  assert(small.length === 0, 'targets under 44px: ' + small.join(', '));
  assert(form.querySelectorAll('label.choice').length > 0, 'no choice rows found to measure');
  assert(form.scrollWidth <= 360, 'the form scrolls sideways on a 360px phone: ' + form.scrollWidth);
  form.remove();
}

// ---------------------------------------------------------------- GPS

// A scripted GPS. `fixes` is a list of [delayMs, accuracy]; it fires them in order.
function fakeGeo(fixes, { error } = {}) {
  const geo = { cleared: 0, watching: 0, lastOptions: null };
  geo.watchPosition = (ok, bad, options) => {
    geo.watching++; geo.lastOptions = options;
    const timers = fixes.map(([ms, accuracy], i) => setTimeout(() => ok({
      coords: { latitude: 25.6 + i / 1000, longitude: 85.1, altitude: 53, accuracy },
      timestamp: Date.now(),
    }), ms));
    if (error) timers.push(setTimeout(() => bad(error), 5));
    geo._timers = timers;
    return geo.watching;
  };
  geo.clearWatch = () => { geo.cleared++; (geo._timers || []).forEach(clearTimeout); };
  return geo;
}

export async function test_capture_location_rejects_when_accuracy_never_improves() {
  const geo = fakeGeo([[0, 120], [20, 70], [40, 90]]);   // best is 70, the last is 90
  let err = null;
  try { await captureLocation({ minAccuracy: 20, timeoutMs: 200 }, geo); } catch (e) { err = e; }
  assert(err, 'must reject when accuracy never reaches the target');
  eq(err.code, 'timeout');
  assert(err.best && err.best.accuracy === 70, 'the best fix so far (70 m) must ride on the error, got ' + JSON.stringify(err.best));
  assert(Math.abs(err.best.lat - 25.601) < 1e-9 && err.best.lon === 85.1, 'the best fix must carry its own coordinates');
  eq(geo.cleared, 1, 'the watch must be cleared or the phone keeps its GPS on');
  // No signal at all: rejects, with nothing to offer.
  const none = fakeGeo([]);
  let err2 = null;
  const t0 = performance.now();
  try { await captureLocation({ minAccuracy: 20, timeoutMs: 100 }, none); } catch (e) { err2 = e; }
  assert(err2 && err2.code === 'timeout' && err2.best === null, 'no fix at all: reject with best = null');
  assert(performance.now() - t0 < 1000, 'must not block past its timeout');
  // Permission refused: a distinct code, so the UI can say what to do.
  const denied = fakeGeo([[0, 500]], { error: { code: 1, message: 'denied' } });
  let err3 = null;
  try { await captureLocation({ minAccuracy: 20, timeoutMs: 300 }, denied); } catch (e) { err3 = e; }
  assert(err3 && err3.code === 'denied', 'a refusal must say denied, got ' + (err3 && err3.code));
  // No geolocation API at all (an old browser).
  let err4 = null;
  try { await captureLocation({ minAccuracy: 20, timeoutMs: 100 }, null); } catch (e) { err4 = e; }
  assert(err4 && err4.code === 'unavailable', 'no API: unavailable');
}

export async function test_capture_location_returns_accuracy_alongside_the_point() {
  const geo = fakeGeo([[0, 60], [20, 12], [40, 5]]);
  const fix = await captureLocation({ minAccuracy: 20, timeoutMs: 1000 }, geo);
  eq(fix.accuracy, 12, 'resolves at the first fix within the target, with its accuracy');
  assert(Math.abs(fix.lat - 25.601) < 1e-9 && fix.lon === 85.1, 'point missing');
  eq(geo.cleared, 1, 'watch must be cleared on success too');
  assert(geo.lastOptions && geo.lastOptions.enableHighAccuracy === true, 'must ask for high accuracy');
  // Canonical ODK string, lat lon altitude accuracy, space separated.
  eq(formatGeopoint(fix), '25.601 85.1 53 12');
  eq(formatGeopoint({ lat: 25.6, lon: 85.1, altitude: null, accuracy: 30.5 }), '25.6 85.1 0 30.5', 'unknown altitude is 0, keeping accuracy in the 4th slot');
  eq(formatGeopoint({ lat: -1.25, lon: 0, altitude: -3, accuracy: 4 }), '-1.25 0 -3 4');
}

export async function test_the_geopoint_widget_stores_a_poor_fix_only_when_accepted() {
  const spec = everyTypeSpec();
  const engine = new FormEngine(spec);
  const geo = fakeGeo([[0, 120], [20, 70]]);
  const form = renderForm(engine, 'default', { geolocation: geo, gps: { minAccuracy: 20, timeoutMs: 150 } });
  mount(form);
  const q = form.querySelector('[data-path="q_geo"]');
  q.querySelector('button.capture').click();
  await sleep(400);
  assert(engine.getAnswer('q_geo') === undefined, 'a 70 m fix was stored without the worker deciding');
  const accept = q.querySelector('button.accept');
  assert(accept && !accept.hidden, 'the best fix must be offered for acceptance');
  assert(q.textContent.includes('70'), 'the offered accuracy must be shown');
  accept.click();
  eq(engine.getAnswer('q_geo'), '25.601 85.1 53 70');
  // A good fix is stored straight away.
  const geo2 = fakeGeo([[0, 8]]);
  const form2 = renderForm(new FormEngine(spec), 'default', { geolocation: geo2, gps: { minAccuracy: 20, timeoutMs: 500 } });
  mount(form2);
  form2.querySelector('[data-path="q_geo"] button.capture').click();
  await sleep(100);
  eq(form2.engine.getAnswer('q_geo'), '25.6 85.1 53 8');
  form.remove(); form2.remove();
}

// ---------------------------------------------------------------- photos

// A photo a phone camera would hand over: big, noisy, so JPEG cannot squash it.
async function bigPhoto(w = 4000, h = 3000) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const bytes = new Uint32Array(img.data.buffer);
  let s = 2463534242;
  for (let i = 0; i < bytes.length; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; bytes[i] = (s | 0xff000000) >>> 0; }
  ctx.putImageData(img, 0, 0);
  return new Promise(resolve => c.toBlob(resolve, 'image/jpeg', 1.0));
}
const dims = async blob => { const b = await createImageBitmap(blob); const d = [b.width, b.height]; b.close(); return d; };

export async function test_downscale_reduces_a_large_photo_below_max_media_bytes() {
  const photo = await bigPhoto();
  const cap = 5 * 1024 * 1024;   // what the server's max_media_bytes defaults to; passed in, never read from render.js
  assert(photo.size > cap, 'test photo is not big enough to prove anything: ' + photo.size);
  const out = await downscaleImage(photo, cap);
  assert(out.size <= cap, 'still over the cap: ' + out.size);
  eq(out.type, 'image/jpeg');
  const [w, h] = await dims(out);
  assert(Math.max(w, h) < 4000, 'was not scaled down');
  assert(w / h > 1.3 && w / h < 1.37, 'aspect ratio changed: ' + w + 'x' + h);
  // A tight cap forces the retry loop to keep shrinking until it fits.
  const tight = 150 * 1024;
  const small = await downscaleImage(photo, tight);
  assert(small.size <= tight, 'the retry loop gave up above the cap: ' + small.size);
  // A small photo already under the cap is not degraded.
  const tiny = await downscaleImage(await bigPhoto(300, 200), cap);
  eq(await dims(tiny), [300, 200]);
}

// Split out of the test above: exhausting the retry loop re-encodes the photo at every
// step, so bundling it with the other cases pushed one test past the harness timeout as
// the suite grew. The behaviour it pins is that an unreachable cap fails loudly rather
// than quietly returning a file the server will reject.
export async function test_a_cap_nothing_can_meet_throws_rather_than_returning_an_oversize_file() {
  const photo = await bigPhoto();
  let threw = false;
  try { await downscaleImage(photo, 200); } catch { threw = true; }
  assert(threw, 'an impossible cap must throw');
}

export async function test_a_photo_taken_in_the_form_is_downscaled_and_kept_for_upload() {
  const spec = everyTypeSpec();
  const engine = new FormEngine(spec);
  const media = new Map();
  const form = renderForm(engine, 'default', { geolocation: null, media, maxMediaBytes: 400 * 1024 });
  mount(form);
  const input = form.querySelector('[data-path="q_image"] input[type=file]');
  assert(input && input.accept.includes('image'), 'image question needs an image file input');
  const dt = new DataTransfer();
  dt.items.add(new File([await bigPhoto(2400, 1800)], 'IMG_1.jpg', { type: 'image/jpeg' }));
  input.files = dt.files; fire(input, 'change');
  await until(() => media.has('q_image'));
  assert(media.has('q_image'), 'the photo was not kept for upload');
  assert(media.get('q_image').size <= 400 * 1024, 'the kept photo is over the cap');
  assert(/^q_image\.jpg$/.test(engine.getAnswer('q_image')), 'the answer must name the file, got ' + engine.getAnswer('q_image'));
  assert(form.querySelector('[data-path="q_image"] img'), 'no preview of the photo');
  form.remove();
}

// ---------------------------------------------------------------- drafts

export async function test_a_draft_is_saved_on_every_answer() {
  await db.deleteDB(); await db.openDB();
  const spec = everyTypeSpec();
  const engine = new FormEngine(spec);
  const saver = draftSaver({ id: 'draft-1', spec, userId: 7, store: db });
  const form = renderForm(engine, 'default', { geolocation: null, onAnswer: saver });
  mount(form);
  type(form.querySelector('[data-path="q_text"] input, [data-path="q_text"] textarea'), 'पहला');
  await saver.flush();
  let d = await db.getDraft('draft-1');
  eq(d.data.q_text, 'पहला');
  eq([d.form_id, d.version, d.user_id], ['t', '1', 7]);
  // Each further keystroke lands, and the last one wins even when writes overlap.
  const input = form.querySelector('[data-path="q_integer"] input');
  for (const v of ['1', '12', '123']) type(input, v);
  await saver.flush();
  d = await db.getDraft('draft-1');
  eq(String(d.data.q_integer), '123');
  eq(d.data.q_text, 'पहला');
  // A draft restores into a working engine.
  const back = new FormEngine(spec, { data: d.data, repeats: d.repeats });
  eq(back.getAnswer('q_text'), 'पहला');
  form.remove();
  await db.deleteDB();
}

export async function test_typing_after_attaching_a_photo_does_not_rewrite_the_blob() {
  await db.deleteDB(); await db.openDB();
  const spec = everyTypeSpec();
  const engine = new FormEngine(spec);
  const media = new Map();
  const writes = [];
  const store = { ...db, saveDraft: (d) => { writes.push(d); return db.saveDraft(d); }, getDraft: db.getDraft };
  const saver = draftSaver({ id: 'd2', spec, userId: 1, store, media });
  const form = renderForm(engine, 'default', { geolocation: null, media, maxMediaBytes: 400 * 1024, onAnswer: saver });
  mount(form);
  const input = form.querySelector('[data-path="q_image"] input[type=file]');
  const dt = new DataTransfer();
  dt.items.add(new File([await bigPhoto(1200, 900)], 'a.jpg', { type: 'image/jpeg' }));
  input.files = dt.files; fire(input, 'change');
  await until(() => media.has('q_image'));
  await saver.flush();
  const mediaWrites = () => writes.filter(w => w.kind === 'media').length;
  eq(mediaWrites(), 1, 'the photo is written once when it is attached');
  const text = form.querySelector('[data-path="q_text"] input, [data-path="q_text"] textarea');
  for (const v of ['a', 'ab', 'abc', 'abcd']) type(text, v);
  await saver.flush();
  eq(mediaWrites(), 1, 'typing must not rewrite the photo');
  assert(writes.filter(w => w.kind !== 'media').length >= 2, 'answers must still be saved after the photo and after the typing');
  assert(writes.filter(w => w.kind !== 'media').every(w => !('media' in w)), 'the answer record must not carry blobs');
  const back = await loadDraft(db, 'd2');
  eq(back.data.q_text, 'abcd');
  assert(back.media.q_image instanceof Blob && back.media.q_image.size > 0, 'the photo comes back with the draft');
  // Retaking replaces it, and that is a write.
  const dt2 = new DataTransfer();
  dt2.items.add(new File([await bigPhoto(1000, 700)], 'b.jpg', { type: 'image/jpeg' }));
  input.files = dt2.files; fire(input, 'change');
  await until(() => mediaWrites() >= 2);
  await saver.flush();
  eq(mediaWrites(), 2, 'a changed photo is written');
  form.remove();
  await db.deleteDB();
}

const memoryStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };
async function attachPhoto(form, w, h) {
  const input = form.querySelector('[data-path="q_image"] input[type=file]');
  const dt = new DataTransfer();
  dt.items.add(new File([await bigPhoto(w, h)], 'p.jpg', { type: 'image/jpeg' }));
  input.files = dt.files; fire(input, 'change');
}

export async function test_the_servers_cap_from_a_bootstrap_result_reaches_downscale_image() {
  const store = memoryStorage();
  // bootstrap() returns {forms, datasets, config, errors}; the cap is at config.max_media_bytes.
  assert(rememberMediaCap({ forms: [], datasets: [], config: { max_media_bytes: 120 * 1024 }, errors: [] }, store), 'cap not remembered');
  eq(mediaCap(store), 120 * 1024);
  const media = new Map();
  const form = renderForm(new FormEngine(everyTypeSpec()), 'default', { geolocation: null, media, maxMediaBytes: () => mediaCap(store) });
  mount(form);
  await attachPhoto(form, 2400, 1800);   // noise: far over 120 KB at any default size
  await until(() => media.has('q_image'));
  assert(media.has('q_image'), 'photo not kept');
  assert(media.get('q_image').size <= 120 * 1024, 'photo is over the server cap: ' + media.get('q_image').size);
  assert(media.get('q_image').size > 20 * 1024, 'photo shrunk far below the cap, so the cap was not what sized it');
  form.remove();
}

export async function test_an_empty_config_falls_back_rather_than_downscaling_to_undefined() {
  const store = memoryStorage();
  assert(!rememberMediaCap({ config: {}, errors: [{ config: true, error: 'x' }] }, store), 'empty config must not store anything');
  assert(!rememberMediaCap({}, store) && !rememberMediaCap(null, store) && !rememberMediaCap({ config: { max_media_bytes: 'abc' } }, store));
  eq(mediaCap(store), FALLBACK_MEDIA_BYTES, 'never told: use the fallback, a real number');
  assert(Number.isFinite(mediaCap(store)) && mediaCap(store) > 0);
  // A value once received survives a later failed bootstrap.
  rememberMediaCap({ config: { max_media_bytes: 777000 } }, store);
  rememberMediaCap({ config: {} }, store);
  eq(mediaCap(store), 777000, 'the last known cap must be kept when config is empty');
  // And the fallback really is applied to the photo.
  const media = new Map();
  const form = renderForm(new FormEngine(everyTypeSpec()), 'default', { geolocation: null, media, maxMediaBytes: () => mediaCap(memoryStorage()) });
  mount(form);
  await attachPhoto(form, 3000, 2400);
  await until(() => media.has('q_image'));
  assert(media.has('q_image') && media.get('q_image').size <= FALLBACK_MEDIA_BYTES, 'photo not sized to the fallback');
  form.remove();
}

// ---------------------------------------------------------------- Refresh forms (home screen)
// app.js is imported lazily so a missing export fails these tests only, not the whole module.
import * as syncMod from '../js/sync.js';
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const formSpec = (id, version, title = id) => ({ form_id: id, version, title: lbl(title), languages: ['default'], default_language: 'default', choices: {}, nodes: [{ type: 'text', name: 'q', label: lbl('Q') }] });

// A server holding `forms` ({ id: version }) and optional broken pieces.
function refreshServer({ forms, failList = false, failSpecFor = null, datasets = ['villages'] } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith('/api/forms')) return failList ? jsonRes(500, {}) : jsonRes(200, Object.entries(forms).map(([form_id, v]) => ({ form_id, current_version: v })));
    const m = u.match(/\/api\/forms\/([^/]+)\/versions\/([^/]+)\/spec$/);
    if (m) return m[1] === failSpecFor ? jsonRes(500, {}) : jsonRes(200, formSpec(m[1], m[2]));
    if (u.endsWith('/api/config')) return jsonRes(200, { max_media_bytes: 100000 });
    if (u.endsWith('/api/datasets')) return jsonRes(200, datasets.map(name => ({ name, version: 1, project_id: 1 })));
    if (/\/api\/datasets\//.test(u)) return jsonRes(200, { rows: [{ a: 1 }] });
    return jsonRes(404, {});
  };
}
async function freshDb() {
  syncMod._resetSyncState();
  await db.deleteDB(); await db.openDB();
  await db.putSession({ access_token: 'A1', refresh_token: 'R1', user: { id: 1, role: 'enumerator' } });
}

export async function test_refresh_stores_the_new_form_version_and_reports_what_changed() {
  const app = await import('../js/app.js');
  await freshDb();
  await db.putForm(formSpec('hh', '1'));
  const r = await app.refreshForms({ fetchImpl: refreshServer({ forms: { hh: '2', other: '1' } }), online: () => true });
  eq(r.status, 'ok');
  assert(await db.getForm('hh', '2') && await db.getForm('other', '1') && await db.getForm('hh', '1'), 'new versions stored, old kept');
  eq(r.newForms, 2);
  assert(app.refreshMessage(r, 'en').includes('2'), 'message must carry the count');
  // A second refresh finds nothing new and says so plainly, in both languages.
  const r2 = await app.refreshForms({ fetchImpl: refreshServer({ forms: { hh: '2', other: '1' } }), online: () => true });
  eq(r2.status, 'ok');
  eq(r2.newForms, 0);
  assert(/up to date/i.test(app.refreshMessage(r2, 'en')), app.refreshMessage(r2, 'en'));
  assert(/[ऀ-ॿ]/.test(app.refreshMessage(r2, 'hi')), 'Hindi message must be Devanagari');
}

export async function test_refresh_leaves_an_open_draft_on_its_original_version() {
  const app = await import('../js/app.js');
  await freshDb();
  await db.putForm(formSpec('hh', '1'));
  await db.saveDraft({ id: 'd1', form_id: 'hh', version: '1', user_id: 1, data: { q: 'सीता' }, repeats: {} });
  const before = JSON.stringify(await db.getDraft('d1'));
  await app.refreshForms({ fetchImpl: refreshServer({ forms: { hh: '2' } }), online: () => true });
  eq(JSON.stringify(await db.getDraft('d1')), before, 'the draft record must be byte-for-byte unchanged');
  assert(await db.getForm('hh', '1'), 'the version the draft started on must still be there to resume on');
  assert(await db.getForm('hh', '2'), 'the new version is available for new forms');
  eq((await db.listDrafts()).length, 1);
}

export async function test_refresh_leaves_the_queue_and_rejected_untouched() {
  const app = await import('../js/app.js');
  await freshDb();
  await db.enqueue({ uuid: 'q1', form_id: 'hh', version: '1', data: { q: 'a' }, repeats: {} }, { p: new Blob(['x'], { type: 'image/jpeg' }) });
  await db.putRejected({ uuid: 'r1', form_id: 'hh', version: '1', status: 422, message: 'no', submission: { uuid: 'r1' }, media: [] });
  const snap = async () => JSON.stringify([await db.peekQueue(10), await db.listRejected(), (await db.getMedia('q1')).length]);
  const before = await snap();
  for (const fetchImpl of [refreshServer({ forms: { hh: '2' } }), refreshServer({ forms: {}, failList: true }), refreshServer({ forms: { hh: '2' }, failSpecFor: 'hh' })]) {
    await app.refreshForms({ fetchImpl, online: () => true });
  }
  await app.refreshForms({ fetchImpl: refreshServer({ forms: {} }), online: () => false });
  eq(await snap(), before, 'queue, media and rejected must be identical after any refresh');
}

export async function test_a_partial_refresh_is_reported_as_partial_not_success() {
  const app = await import('../js/app.js');
  await freshDb();
  const r = await app.refreshForms({ fetchImpl: refreshServer({ forms: { good: '1', bad: '1' }, failSpecFor: 'bad' }), online: () => true });
  eq(r.status, 'partial');
  assert(await db.getForm('good', '1'), 'the form that did download is kept');
  eq(r.newForms, 1);
  const en = app.refreshMessage(r, 'en');
  assert(/not|could/i.test(en) && /again/i.test(en), 'partial message must say something failed and offer retry: ' + en);
  assert(!/^everything|^done/i.test(en), 'must not read as success');
  assert(en.includes('1'), 'still says what did update');
}

export async function test_a_refresh_that_cannot_list_forms_says_it_failed_and_can_be_retried() {
  const app = await import('../js/app.js');
  await freshDb();
  const r = await app.refreshForms({ fetchImpl: refreshServer({ forms: {}, failList: true }), online: () => true });
  eq(r.status, 'failed');
  assert(/again/i.test(app.refreshMessage(r, 'en')));
  const thrown = await app.refreshForms({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, online: () => true });
  eq(thrown.status, 'failed', 'a network exception is a failure, not a crash');
}

export async function test_an_offline_refresh_says_a_connection_is_needed_and_does_not_fetch() {
  const app = await import('../js/app.js');
  await freshDb();
  let calls = 0;
  const r = await app.refreshForms({ fetchImpl: async () => { calls++; return jsonRes(200, []); }, online: () => false });
  eq(r.status, 'offline');
  eq(calls, 0, 'offline must not even try');
  assert(/internet/i.test(app.refreshMessage(r, 'en')) && /[ऀ-ॿ]/.test(app.refreshMessage(r, 'hi')));
}

export async function test_the_home_screen_has_a_refresh_button_in_both_languages_with_a_44px_target() {
  const app = await import('../js/app.js');
  await cssReady;
  for (const lang of ['en', 'hi']) {
    const label = app.refreshLabel(lang);
    assert(label && label !== 'refresh', 'label missing in ' + lang);
    if (lang === 'hi') assert(/[ऀ-ॿ]/.test(label));
  }
  assert(/refresh forms/i.test(app.refreshLabel('en')));
  const btn = app.refreshButton({ lang: 'en', onrefresh() {} });
  const host = mount(btn);
  assert(btn.getBoundingClientRect().height >= 44, 'touch target under 44px: ' + btn.getBoundingClientRect().height);
  host.remove();
}
