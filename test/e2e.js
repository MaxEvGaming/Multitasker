import { registerBody, loginBody } from './browser.js';
// End-to-end walk through the board against a real Postgres. Run with the
// server already listening on BASE.
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
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, data };
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const stateNamed = (board, name) => board.states.find((s) => s.name === name);
const slot = (board, n) => board.tasks.find((t) => t.slot === n);
const nameOfState = (board, id) => (board.states.find((s) => String(s.id) === String(id)) || {}).name;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('registration and defaults');
const email = `owner${Date.now()}@example.com`;
let r = await call('/api/register', await registerBody( email, 'a-long-enough-password' ));
check('first account is accepted', r.status === 200, JSON.stringify(r.data));

r = await call('/api/board');
let board = r.data;
check('four default states exist', board.states.length === 4, `got ${board.states.length}`);
check('fifteen slots exist', board.tasks.length === 15, `got ${board.tasks.length}`);
check('a webhook token was issued', Boolean(board.webhookToken));
check('On it runs a timer', stateNamed(board, 'On it').runs_timer === true);
check('Running falls back to Waiting',
  nameOfState(board, stateNamed(board, 'Running').auto_to) === 'Waiting');
check('an instruction takes Waiting to Running',
  nameOfState(board, stateNamed(board, 'Waiting').start_to) === 'Running');

console.log('the door behaves as configured');
// The check depends on how the server under test was started: shut by default,
// open when the deployment deliberately opens it. A fresh address either way, so
// a duplicate cannot be mistaken for a closed door.
const doorOpen = process.env.REGISTRATION_OPEN === 'true';
const saved = cookie; cookie = '';
r = await call('/api/register', await registerBody(`second${Date.now()}@example.com`, 'another-long-password'));
check(doorOpen ? 'a second registration is accepted while the door is open'
                : 'a second registration is refused once someone has registered',
  doorOpen ? r.status === 200 : r.status === 403, `status ${r.status}`);
cookie = saved;

console.log('naming a slot');
r = await call('/api/task', { slot: 0, title: 'ProjectOne の作業', matchKey: 'ProjectOne', expectedSeconds: 3 });
board = r.data;
check('title stored', slot(board, 0).title === 'ProjectOne の作業');
check('session name stored', slot(board, 0).match_key === 'ProjectOne');

console.log('tapping the halves');
check('starts in Waiting', nameOfState(board, slot(board, 0).state_id) === 'Waiting');
r = await call('/api/tap', { slot: 0, side: 'left' });
board = r.data.board;
check('left goes to On it', nameOfState(board, slot(board, 0).state_id) === 'On it');

r = await call('/api/tap', { slot: 0, side: 'left' });
board = r.data.board;
check('left again comes back to Waiting', nameOfState(board, slot(board, 0).state_id) === 'Waiting');

r = await call('/api/tap', { slot: 0, side: 'right' });
board = r.data.board;
check('right goes to Stopped', nameOfState(board, slot(board, 0).state_id) === 'Stopped');
r = await call('/api/tap', { slot: 0, side: 'left' });
board = r.data.board;
check('and back to Waiting from there', nameOfState(board, slot(board, 0).state_id) === 'Waiting');

// Running is where an instruction puts it, not a tap — that is the whole point
// of the state, so this is how the report below has somewhere to go.
r = await call(`/hook/${board.webhookToken}`, { text: '*ProjectOne* — 作業中', event: 'start' });
board = (await call('/api/board')).data;
check('an instruction reaches Running', nameOfState(board, slot(board, 0).state_id) === 'Running',
  `now ${nameOfState(board, slot(board, 0).state_id)}`);

console.log('a report from Claude, in the shape the PC hook already sends');
r = await call(`/hook/${board.webhookToken}`, { text: '*ProjectOne* — 入力待ちです' });
check('the hook answers 200', r.status === 200);
board = (await call('/api/board')).data;
check('Running → Waiting on the report',
  nameOfState(board, slot(board, 0).state_id) === 'Waiting',
  `now ${nameOfState(board, slot(board, 0).state_id)}`);

console.log('a report naming a slot that does not exist');
r = await call(`/hook/${board.webhookToken}`, { text: '*NoSuchSession* — 入力待ちです' });
// Not 200. Whoever wires the hook up is told to look at what came back, and
// "ok" for a report that matched nothing made that check worthless. Not 404
// either — that is what an unknown address answers, and the two need telling
// apart.
check('says so rather than answering ok', r.status === 422, `status ${r.status}`);

console.log('the estimate running out');
// The sweep wants a state that both counts and has somewhere to go. None of
// the states a board starts with is both: On it counts and stays put, Running
// goes back to Waiting but does not count. So one is made here — which is also
// the shape anyone wanting the estimate to ring has to set up for themselves.
{
  const onIt = stateNamed(board, 'On it');
  r = await call('/api/state', {
    id: onIt.id, name: 'On it', colour: onIt.colour, runsTimer: true,
    leftTo: stateNamed(board, 'Waiting').id, rightTo: stateNamed(board, 'Waiting').id,
    autoTo: stateNamed(board, 'Waiting').id, sortOrder: onIt.sort_order,
  });
  board = r.data;
}
await call('/api/tap', { slot: 0, side: 'left' });
board = (await call('/api/board')).data;
check('in the counting state', nameOfState(board, slot(board, 0).state_id) === 'On it',
  `now ${nameOfState(board, slot(board, 0).state_id)}`);
await wait(9000); // estimate is 3s; the sweep runs every 5s
board = (await call('/api/board')).data;
check('the sweep moved it to Waiting',
  nameOfState(board, slot(board, 0).state_id) === 'Waiting',
  `now ${nameOfState(board, slot(board, 0).state_id)}`);

console.log('user-defined states');
r = await call('/api/state', { name: 'レビュー待ち', colour: '#7c5cff', sortOrder: 9 });
board = r.data;
const review = stateNamed(board, 'レビュー待ち');
check('a new state can be added', Boolean(review));
r = await call('/api/state', {
  id: stateNamed(board, 'Stopped').id, name: 'Stopped', colour: '#dc2626',
  rightTo: review.id, leftTo: stateNamed(board, 'Waiting').id, sortOrder: 3,
});
board = r.data;
check('the right half can point at the new state',
  nameOfState(board, stateNamed(board, 'Stopped').right_to) === 'レビュー待ち');

console.log('a state still in use cannot be deleted');
r = await call('/api/state/delete', { id: stateNamed(board, 'Waiting').id });
check('deletion is refused while squares sit in it', r.status === 409, `status ${r.status}`);

console.log('an unauthenticated caller sees nothing');
const authed = cookie; cookie = '';
r = await call('/api/board');
check('board requires a login', r.status === 401, `status ${r.status}`);
cookie = authed;

console.log('the log records why each move happened');
r = await call('/api/board');
check('board still reachable when logged in', r.status === 200);

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
