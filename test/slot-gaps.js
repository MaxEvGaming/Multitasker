// Square numbers close up (T-514 / T-515 = A). Deleting a square, or filing it
// under another page, leaves no hole in the numbers of the page it left; the
// order on that page stays as it was; no other page is touched. And the one-off
// migration that closes the holes already there does so without changing the
// order, and changes nothing the second time it runs.
//
// Walked against a real server and a real Postgres:
//
//   DATABASE_URL=... BASE=http://127.0.0.1:3040 node test/slot-gaps.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { registerBody } from './browser.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = fs.readFileSync(path.join(HERE, '..', 'sql', '017_compact_slots.sql'), 'utf8');

let cookie = '';
let failures = 0;

async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  try { return { status: res.status, data: text ? JSON.parse(text) : null }; }
  catch (_) { return { status: res.status, data: text }; }
}

const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const ids = (b) => b.tasks.map((t) => String(t.id));
const slots = (b) => b.tasks.map((t) => t.slot);
const gapless = (b) => b.tasks.every((t, i) => t.slot === i);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pageOf = async (id) => (await call('/api/board?page=' + id)).data;

await call('/api/register', await registerBody(`gaps${Date.now()}@example.com`, 'a-long-enough-password'));
let board = (await call('/api/board')).data;
const pageA = board.page;

board = (await call('/api/page', { name: '二枚目' })).data;
const pageB = board.pages.find((p) => p.name === '二枚目').id;
for (let i = 0; i < 3; i += 1) await call('/api/slot/add', { page: pageB });

console.log('deleting a square closes up the numbers behind it');
{
  const before = await pageOf(pageA);
  const otherBefore = await pageOf(pageB);
  check('the page starts without a gap', gapless(before), JSON.stringify(slots(before)));

  const doomed = before.tasks[4];
  const after = (await call('/api/slot/delete', { taskId: doomed.id, page: pageA })).data;

  check('one fewer square', after.tasks.length === before.tasks.length - 1,
    `${after.tasks.length}`);
  check('numbered from the start with no gap', gapless(after), JSON.stringify(slots(after)));
  check('the order is the same, less the deleted one',
    same(ids(after), ids(before).filter((id) => id !== String(doomed.id))),
    `${ids(before).join(',')} -> ${ids(after).join(',')}`);

  const otherAfter = await pageOf(pageB);
  check('the other page is untouched',
    same(otherAfter.tasks.map((t) => [String(t.id), t.slot]),
      otherBefore.tasks.map((t) => [String(t.id), t.slot])));
}

console.log('deleting the first and the last square also closes up');
{
  let before = await pageOf(pageA);
  let after = (await call('/api/slot/delete', { taskId: before.tasks[0].id, page: pageA })).data;
  check('after the first: no gap', gapless(after), JSON.stringify(slots(after)));
  check('after the first: same order', same(ids(after), ids(before).slice(1)));

  before = after;
  after = (await call('/api/slot/delete',
    { taskId: before.tasks[before.tasks.length - 1].id, page: pageA })).data;
  check('after the last: no gap', gapless(after), JSON.stringify(slots(after)));
  check('after the last: same order', same(ids(after), ids(before).slice(0, -1)));
}

console.log('filing a square under another page closes up the page it left');
{
  const before = await pageOf(pageA);
  const otherBefore = await pageOf(pageB);
  const moving = before.tasks[2];

  const r = await call('/api/slot/move', { taskId: moving.id, toPage: pageB, page: pageA });
  check('the move was accepted', r.status === 200, `status ${r.status}`);
  const after = r.data;

  check('the page it left has no gap', gapless(after), JSON.stringify(slots(after)));
  check('and keeps its order',
    same(ids(after), ids(before).filter((id) => id !== String(moving.id))),
    `${ids(before).join(',')} -> ${ids(after).join(',')}`);

  const otherAfter = await pageOf(pageB);
  check('it landed at the end of the other page',
    String(otherAfter.tasks[otherAfter.tasks.length - 1].id) === String(moving.id),
    ids(otherAfter).join(','));
  check('the squares already there kept their numbers',
    same(otherAfter.tasks.slice(0, -1).map((t) => [String(t.id), t.slot]),
      otherBefore.tasks.map((t) => [String(t.id), t.slot])));
  check('the other page has no gap either', gapless(otherAfter), JSON.stringify(slots(otherAfter)));
}

console.log('the migration closes the gaps already there, once');
{
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const order = ids(await pageOf(pageA));
  const otherBefore = await pageOf(pageB);

  // Holes the old server would have left: pushed out of the way first so the
  // unique positions never collide, then spread out with gaps between them.
  await db.query('update tasks set slot = slot + 1000 where page_id = $1', [pageA]);
  await db.query('update tasks set slot = (slot - 1000) * 3 + 7 where page_id = $1', [pageA]);
  const gapped = await pageOf(pageA);
  check('the page has gaps to close', !gapless(gapped), JSON.stringify(slots(gapped)));
  check('in the same order as before', same(ids(gapped), order));

  await db.query(MIGRATION);
  const closed = await pageOf(pageA);
  check('numbered from the start with no gap', gapless(closed), JSON.stringify(slots(closed)));
  check('and the order is unchanged', same(ids(closed), order),
    `${order.join(',')} -> ${ids(closed).join(',')}`);

  const otherAfter = await pageOf(pageB);
  check('a page without gaps is left as it was',
    same(otherAfter.tasks.map((t) => [String(t.id), t.slot]),
      otherBefore.tasks.map((t) => [String(t.id), t.slot])));

  const snapshot = async () => (await db.query(
    'select id::text, page_id::text, slot from tasks order by id')).rows;
  const once = await snapshot();
  const negatives = once.filter((row) => row.slot < 0);
  check('no square is left on a negative number', negatives.length === 0, `${negatives.length}`);

  await db.query(MIGRATION);
  const twice = await snapshot();
  check('running it a second time changes nothing', same(once, twice));

  await db.end();
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
