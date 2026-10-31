// Browser tests for js/db.js. Run through browser.html.
import * as db from '../js/db.js';

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
  }
}
async function fresh() { await db.deleteDB(); await db.openDB(); }
const sub = (uuid, extra = {}) => ({ uuid, form_id: 'hh', version: 1, answers: { q1: 'a' }, ...extra });
const blob = (text, type = 'image/jpeg') => new Blob([text], { type });
async function countMedia(uuid) { return (await db.getMedia(uuid)).length; }

export async function test_draft_survives_a_reopen() {
  await fresh();
  await db.saveDraft({ id: 'd1', form_id: 'hh', answers: { q1: 'x' } });
  await db.closeDB();
  await db.openDB();
  const d = await db.getDraft('d1');
  eq(d.answers, { q1: 'x' });
  eq((await db.listDrafts()).map(x => x.id), ['d1']);
  await db.deleteDraft('d1');
  eq(await db.getDraft('d1'), undefined);
}

export async function test_enqueue_stores_media_with_the_submission() {
  await fresh();
  await db.enqueue(sub('u1'), { photo: blob('PHOTO'), audio: blob('AUDIO', 'audio/webm') });
  eq(await db.queueLength(), 1);
  const m = await db.getMedia('u1');
  eq(m.map(x => x.question).sort(), ['audio', 'photo']);
  const photo = m.find(x => x.question === 'photo');
  assert(photo.blob instanceof Blob, 'media should come back as a Blob');
  eq(await photo.blob.text(), 'PHOTO');
  eq(photo.blob.type, 'image/jpeg');
}

export async function test_dequeue_removes_the_submission_and_its_media() {
  await fresh();
  await db.enqueue(sub('u1'), { photo: blob('1') });
  await db.enqueue(sub('u2'), { photo: blob('2') });
  await db.dequeue('u1');
  eq((await db.peekQueue(10)).map(s => s.uuid), ['u2']);
  eq(await countMedia('u1'), 0, 'media of u1 left behind');
  eq(await countMedia('u2'), 1, 'media of u2 must be untouched');
}

export async function test_queue_survives_a_page_reload() {
  await fresh();
  await db.enqueue(sub('r1', { answers: { name: 'सीता देवी' } }), { photo: blob('P') });
  await db.enqueue(sub('r2'), {});
  await db.closeDB();
  // A new document has fresh module state and a fresh connection, which is
  // what a page reload gives the app.
  const reply = await new Promise((resolve, reject) => {
    const f = document.createElement('iframe');
    const timer = setTimeout(() => reject(new Error('probe timed out')), 8000);
    window.addEventListener('message', function h(e) {
      if (e.data && e.data.probe === 'queue') {
        clearTimeout(timer); window.removeEventListener('message', h); f.remove(); resolve(e.data);
      }
    });
    f.src = 'browser.html?probe=queue';
    document.body.appendChild(f);
  });
  eq(reply.n, 2);
  eq(reply.uuids, ['r1', 'r2'], 'queue order must be preserved');
}

export async function test_a_second_enqueue_of_one_uuid_does_not_duplicate() {
  await fresh();
  await db.enqueue(sub('dup', { answers: { q1: 'first' } }), { photo: blob('OLD'), extra: blob('X') });
  await db.enqueue(sub('dup', { answers: { q1: 'second' } }), { photo: blob('NEW') });
  eq(await db.queueLength(), 1);
  const [s] = await db.peekQueue(5);
  eq(s.answers.q1, 'second');
  const m = await db.getMedia('dup');
  eq(m.map(x => x.question), ['photo'], 'stale media from first enqueue must not linger');
  eq(await m[0].blob.text(), 'NEW');
}

export async function test_devanagari_round_trips_through_indexeddb() {
  await fresh();
  const text = 'सीता देवी, ग्राम रामपुर — आईएफए गोली क्या है? ०१२३४५६७८९ क्ष त्र ज्ञ कृषि';
  await db.enqueue(sub('hi', { answers: { name: text } }), {});
  await db.saveDraft({ id: 'hd', answers: { name: text } });
  await db.putDataset('villages', [{ code: 1, name: text }]);
  await db.putSession({ id: 'current', user: text });
  eq((await db.peekQueue(1))[0].answers.name, text);
  eq((await db.getDraft('hd')).answers.name, text);
  eq((await db.getDataset('villages'))[0].name, text);
  eq((await db.getSession()).user, text);
}

export async function test_a_failed_enqueue_leaves_nothing_behind() {
  await fresh();
  // A function cannot be structured-cloned, so the second media write throws
  // after the submission and the first media record have been written. The
  // whole transaction must roll back.
  let threw = false;
  try {
    await db.enqueue(sub('bad'), { photo: blob('P'), broken: () => {} });
  } catch (e) { threw = true; }
  assert(threw, 'enqueue should reject');
  eq(await db.queueLength(), 0, 'submission leaked from aborted transaction');
  eq(await countMedia('bad'), 0, 'media leaked from aborted transaction');
}

export async function test_a_failed_reenqueue_keeps_the_original_intact() {
  await fresh();
  await db.enqueue(sub('keep', { answers: { q1: 'orig' } }), { photo: blob('ORIG') });
  try { await db.enqueue(sub('keep', { answers: { q1: 'new' } }), { photo: blob('N'), broken: () => {} }); } catch (e) {}
  const [s] = await db.peekQueue(5);
  eq(s.answers.q1, 'orig');
  const m = await db.getMedia('keep');
  eq(await m[0].blob.text(), 'ORIG');
}

export async function test_enqueue_rejects_a_submission_without_uuid() {
  await fresh();
  let threw = false;
  try { await db.enqueue({ form_id: 'hh' }, {}); } catch (e) { threw = true; }
  assert(threw, 'should reject');
  eq(await db.queueLength(), 0);
}

export async function test_quota_exceeded_is_reported_not_swallowed() {
  const err = db._classifyError(new DOMException('full', 'QuotaExceededError'));
  assert(err.quota === true, 'quota flag missing');
  assert(/storage/i.test(err.message), 'message should mention storage');
  const other = db._classifyError(new Error('x'));
  assert(!other.quota, 'non-quota error flagged as quota');
}

export async function test_peek_returns_oldest_first_and_respects_n() {
  await fresh();
  for (const u of ['zz', 'aa', 'mm']) await db.enqueue(sub(u), {});
  eq((await db.peekQueue(2)).map(s => s.uuid), ['zz', 'aa']);
  eq(await db.queueLength(), 3);
}

export async function test_forms_datasets_and_session_round_trip() {
  await fresh();
  await db.putForm({ form_id: 'hh', version: 2, title: 'घर' });
  await db.putForm({ form_id: 'hh', version: 1, title: 'old' });
  eq((await db.getForm('hh', 2)).title, 'घर');
  eq((await db.listForms()).length, 2);
  await db.putDataset('blocks', [{ a: 1 }]);
  eq(await db.getDataset('blocks'), [{ a: 1 }]);
  eq(await db.getDataset('nope'), undefined);
  eq(await db.getSession(), undefined);
  await db.putSession({ user: 'u' });
  eq((await db.getSession()).user, 'u');
  await db.clearSession();
  eq(await db.getSession(), undefined);
}
