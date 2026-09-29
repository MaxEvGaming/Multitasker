import { registerBody, loginBody, proofOf } from './browser.js';
// The square only moves when the name on it matches the name in the report, and
// that match failed in practice on three of the owner's first four squares: a
// missing space, a misspelling, and a phrase typed twice. Two things are checked
// here — that near-misses of the mechanical kind still meet, and that every name
// the board is told about is remembered so it can be offered rather than typed.
const BASE = process.env.BASE || 'http://127.0.0.1:3040';

let cookie = '';
let failures = 0;

async function call(path, body) {
  // Squares are addressed by identity now, not by position. The tests still
  // read better in terms of "the first square", so the translation happens here
  // rather than in every call.
  if (body && body.slot !== undefined) {
    const view = await (await fetch(BASE + '/api/board',
      { headers: cookie ? { Cookie: cookie } : {} })).json();
    const found = (view.tasks || []).find((t) => t.slot === body.slot);
    const { slot, ...rest } = body;
    body = { ...rest, taskId: found && found.id, page: view.page };
  }

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nameOfState = (b, id) => (b.states.find((s) => String(s.id) === String(id)) || {}).name;
const slot = (b, n) => b.tasks.find((t) => t.slot === n);
const named = (b, name) => b.states.find((s) => s.name === name);

await call('/api/register', await registerBody(`naming${Date.now()}@example.com`, 'a-long-enough-password'));
let board = (await call('/api/board')).data;
const token = board.webhookToken;

// Into the state that has somewhere automatic to go. No tap reaches it any
// more — an instruction is what puts a square there, which is the point of it.
async function intoRunning(n, name) {
  await call(`/hook/${token}`, { text: `*${name}* — 作業中`, event: 'start' });
  await wait(200);
  return (await call('/api/board')).data;
}

console.log('names that differ only mechanically still meet');
{
  // Saved with spaces around it and a full-width letter; reported plainly.
  board = (await call('/api/task',
    { slot: 0, title: '折り合わせ', matchKey: '  ＰｒｏｊｅｃｔOne ', expectedSeconds: 600 })).data;
  check('the stored name is folded on the way in', slot(board, 0).match_key === 'ProjectOne',
    JSON.stringify(slot(board, 0).match_key));

  board = await intoRunning(0, 'ProjectOne');
  check('the square is running', nameOfState(board, slot(board, 0).state_id) === 'Running');

  await call(`/hook/${token}`, { text: '*ProjectOne* — 入力待ちです' });
  board = (await call('/api/board')).data;
  check('a plain report reaches the folded name',
    nameOfState(board, slot(board, 0).state_id) === 'Waiting',
    `now ${nameOfState(board, slot(board, 0).state_id)}`);
}

console.log('a curly apostrophe from a phone keyboard meets a straight one');
{
  board = (await call('/api/task',
    { slot: 1, title: '引用符', matchKey: 'Texas Hold’em EV calculator tool', expectedSeconds: 600 })).data;
  board = await intoRunning(1, 'Texas Hold’em EV calculator tool');

  await call(`/hook/${token}`, { text: "*Texas Hold'em EV calculator tool* — 入力待ちです" });
  board = (await call('/api/board')).data;
  check('the two apostrophes are treated as one',
    nameOfState(board, slot(board, 1).state_id) === 'Waiting',
    `now ${nameOfState(board, slot(board, 1).state_id)}`);
}

console.log('a genuinely different name still does not match');
{
  board = (await call('/api/task',
    { slot: 2, title: '別名', matchKey: 'AnotherThing', expectedSeconds: 600 })).data;
  board = await intoRunning(2, 'AnotherThing');

  // A missing space is a different name, and quietly matching it would be worse
  // than not matching: the wrong square would move.
  await call(`/hook/${token}`, { text: '*Another Thing* — 入力待ちです' });
  board = (await call('/api/board')).data;
  check('a space in the middle is not silently forgiven',
    nameOfState(board, slot(board, 2).state_id) === 'Running',
    `now ${nameOfState(board, slot(board, 2).state_id)}`);
}

console.log('every name the board is told about is remembered');
{
  board = (await call('/api/board')).data;
  const seen = (board.seenNames || []).map((s) => s.name);
  check('the names that matched are listed', seen.includes('ProjectOne'), JSON.stringify(seen));
  check('the name that matched nothing is listed too', seen.includes('Another Thing'),
    JSON.stringify(seen));

  await call(`/hook/${token}`, { text: '*ProjectOne* — 入力待ちです' });
  board = (await call('/api/board')).data;
  const mtg = (board.seenNames || []).find((s) => s.name === 'ProjectOne');
  check('repeats are counted rather than duplicated', mtg && mtg.hits >= 2,
    JSON.stringify(mtg));
}

console.log('a state with nowhere automatic to go does not move');
{
  // This is the behaviour that confused the owner: all four squares sat in
  // On it, which by default has no automatic destination, so reports arrived
  // and nothing happened. It is a setting, not a fault, so it is pinned here.
  board = (await call('/api/board')).data;
  check('On it has no automatic destination by default',
    named(board, 'On it').auto_to === null,
    `auto_to = ${named(board, 'On it').auto_to}`);

  await call('/api/tap', { slot: 0, side: 'left' });          // Waiting -> On it
  board = (await call('/api/board')).data;
  check('the square is in On it', nameOfState(board, slot(board, 0).state_id) === 'On it');

  await call(`/hook/${token}`, { text: '*ProjectOne* — 入力待ちです' });
  await wait(300);
  board = (await call('/api/board')).data;
  check('a report leaves it where it is',
    nameOfState(board, slot(board, 0).state_id) === 'On it',
    `now ${nameOfState(board, slot(board, 0).state_id)}`);

  // ...until the owner gives On it somewhere to go, which is what the settings
  // screen is for.
  const waiting = named(board, 'Waiting');
  const attending = named(board, 'On it');
  await call('/api/state', {
    id: attending.id, name: 'On it', colour: attending.colour,
    runsTimer: attending.runs_timer, leftTo: attending.left_to,
    rightTo: attending.right_to, autoTo: waiting.id, sortOrder: attending.sort_order,
  });
  await call(`/hook/${token}`, { text: '*ProjectOne* — 入力待ちです' });
  board = (await call('/api/board')).data;
  check('once it has a destination, the same report moves it',
    nameOfState(board, slot(board, 0).state_id) === 'Waiting',
    `now ${nameOfState(board, slot(board, 0).state_id)}`);
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
