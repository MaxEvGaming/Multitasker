// How long a square usually runs before it wants you again.
//
// This is the last of the original asks — see how long until each thing needs a
// hand — and the first answer to it was wrong: ask the person to estimate.
// Nobody knows, and a typed number that is wrong is worse than no number, since
// it also fires a notification when it runs out.
//
// The board has been recording the real thing all along. A 'start' is an
// instruction going in; the next move is it coming back. This checks the middle
// of those, and the two ways it can mislead: too few runs to mean anything, and
// one session left going overnight.
import pg from 'pg';
import { registerBody, loginBody, proofOf } from './browser.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';

let cookie = '';
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

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

await call('/api/register', await registerBody(`typical${Date.now()}@example.com`, 'a-long-enough-password'));
let board = (await call('/api/board')).data;
const square = board.tasks[0];
const other = board.tasks[1];

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const me = (await db.query('select id from users order by id desc limit 1')).rows[0].id;

// Written straight in, because the alternative is a test that takes hours.
const run = async (taskId, agoMinutes, lastingMinutes) => {
  // Seconds, because make_interval wants whole numbers for minutes and some of
  // these are deliberately fractions of one.
  const ago = Math.round(agoMinutes * 60);
  const lasting = Math.round(lastingMinutes * 60);
  await db.query(
    `insert into moves(user_id, task_id, from_state, to_state, cause, at)
     values ($1, $2, 'a', 'b', 'start', now() - make_interval(secs => $3))`,
    [me, taskId, ago]);
  await db.query(
    `insert into moves(user_id, task_id, from_state, to_state, cause, at)
     values ($1, $2, 'b', 'a', 'signal', now() - make_interval(secs => $3))`,
    [me, taskId, ago - lasting]);
};

console.log('two runs is an anecdote, not an estimate');
{
  await run(square.id, 600, 10);
  await run(square.id, 500, 12);
  board = (await call('/api/board')).data;
  const row = (board.typical || {})[square.id];
  check('it is counted', row && row.samples === 2, JSON.stringify(row));
  // The board only shows it from three, which is the page's rule rather than
  // the server's — the server reports what it has and says how much.
  check('and the count comes with it so the page can decide', row && row.samples < 3);
}

console.log('a few runs give a middle');
{
  await run(square.id, 400, 14);
  board = (await call('/api/board')).data;
  const row = board.typical[square.id];
  check('three runs of 10, 12 and 14 minutes', row.samples === 3, JSON.stringify(row));
  check('the middle one is the answer', Math.abs(row.seconds - 12 * 60) < 90, `${row.seconds}s`);
}

console.log('one long night does not move it');
{
  // The mean of 10, 12, 14 and 600 is over two and a half hours. The median is
  // still a quarter of an hour, which is what somebody actually wants to know.
  await run(square.id, 2000, 600);
  board = (await call('/api/board')).data;
  const row = board.typical[square.id];
  check('four runs now', row.samples === 4, JSON.stringify(row));
  check('and the answer is still about a quarter of an hour',
    row.seconds < 20 * 60, `${Math.round(row.seconds / 60)}m`);
}

console.log('what is not counted');
{
  await run(other.id, 300, 0.1);                       // six seconds
  await run(other.id, 200, 20 * 60);                   // twenty hours
  board = (await call('/api/board')).data;
  const row = (board.typical || {})[other.id];
  check('a six second run is noise, and a twenty hour one is a night off',
    !row || row.samples === 0, JSON.stringify(row));
}

console.log('one board does not learn from another');
{
  const mine = (await call('/api/board')).data;
  cookie = '';
  await call('/api/register', await registerBody(`typical${Date.now()}b@example.com`, 'a-long-enough-password'));
  const theirs = (await call('/api/board')).data;
  const overlap = Object.keys(theirs.typical || {}).filter((id) => id in (mine.typical || {}));
  check('no timings cross over', overlap.length === 0, overlap.join(', '));
}

await db.end();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
