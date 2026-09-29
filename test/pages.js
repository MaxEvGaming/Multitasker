// Squares live on pages, and neither the number of pages nor the number of
// squares on one is capped. Also pins the meaning of a zero estimate: not
// "unanswered", but "this square has no clock".
import pg from 'pg';
import { registerBody, loginBody, proofOf } from './browser.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nameOfState = (b, id) => (b.states.find((s) => String(s.id) === String(id)) || {}).name;
const at = (b, n) => b.tasks.find((t) => t.slot === n);

await call('/api/register', await registerBody(`pages${Date.now()}@example.com`, 'a-long-enough-password'));
let board = (await call('/api/board')).data;

console.log('a new account gets one page to start on');
check('exactly one page', board.pages.length === 1, `${board.pages.length} pages`);
check('fifteen squares on it', board.tasks.length === 15, `${board.tasks.length} squares`);
check('the board says which page it is showing', String(board.page) === String(board.pages[0].id));

const firstPage = board.pages[0].id;

console.log('a second page has its own squares');
{
  board = (await call('/api/page', { name: '個人' })).data;
  check('there are two pages now', board.pages.length === 2, `${board.pages.length}`);

  const second = board.pages.find((p) => p.name === '個人');
  check('the new page was named as asked', Boolean(second));

  board = (await call('/api/board?page=' + second.id)).data;
  check('the new page starts empty', board.tasks.length === 0, `${board.tasks.length} squares`);

  board = (await call('/api/slot/add', { page: second.id })).data;
  board = (await call('/api/slot/add', { page: second.id })).data;
  check('squares can be added to it', board.tasks.length === 2, `${board.tasks.length}`);

  const back = (await call('/api/board?page=' + firstPage)).data;
  check('the first page is untouched', back.tasks.length === 15, `${back.tasks.length}`);
}

console.log('the starting count was never a limit');
{
  board = (await call('/api/board?page=' + firstPage)).data;
  for (let i = 0; i < 5; i += 1) board = (await call('/api/slot/add', { page: firstPage })).data;
  check('twenty squares on one page', board.tasks.length === 20, `${board.tasks.length}`);
  check('the positions stay in order',
    board.tasks.every((t, i) => t.slot === board.tasks[0].slot + i),
    JSON.stringify(board.tasks.map((t) => t.slot)));

  const doomed = board.tasks[board.tasks.length - 1];
  board = (await call('/api/slot/delete', { taskId: doomed.id, page: firstPage })).data;
  check('and one can be removed again', board.tasks.length === 19, `${board.tasks.length}`);
}

console.log('a page can be renamed, and the last one cannot be deleted');
{
  board = (await call('/api/page', { id: firstPage, name: '仕事' })).data;
  check('the rename took', board.pages.find((p) => String(p.id) === String(firstPage)).name === '仕事');

  const second = board.pages.find((p) => p.name === '個人');
  board = (await call('/api/page/delete', { id: second.id })).data;
  check('a page can be deleted', board.pages.length === 1, `${board.pages.length}`);

  const r = await call('/api/page/delete', { id: firstPage });
  check('the last page is kept', r.status === 409, `status ${r.status}`);
}

console.log('a report finds its square on whichever page it is on');
{
  board = (await call('/api/page', { name: '二枚目' })).data;
  const second = board.pages.find((p) => p.name === '二枚目');
  board = (await call('/api/slot/add', { page: second.id })).data;

  const square = board.tasks[0];
  await call('/api/task', { taskId: square.id, page: second.id, title: '奥のページ', matchKey: 'FarAway' });
  await call(`/hook/${board.webhookToken}`, { text: '*FarAway* — 作業中', event: 'start' });

  // Looking at the other page entirely when the report arrives.
  await call('/api/board?page=' + firstPage);
  await call(`/hook/${board.webhookToken}`, { text: '*FarAway* — 入力待ちです' });

  const view = (await call('/api/board?page=' + second.id)).data;
  check('the square moved even though another page was in view',
    nameOfState(view, at(view, view.tasks[0].slot).state_id) === 'Waiting',
    `now ${nameOfState(view, view.tasks[0].state_id)}`);
}

console.log('a zero estimate means no clock, not an unanswered question');
{
  board = (await call('/api/board?page=' + firstPage)).data;
  const square = board.tasks[0];

  board = (await call('/api/task', { taskId: square.id, page: firstPage, expectedSeconds: 0 })).data;
  const stored = board.tasks.find((t) => String(t.id) === String(square.id));
  check('zero is stored as zero, not thrown away', stored.expected_seconds === 0,
    String(stored.expected_seconds));

  // Into the state that counts down, and left there well past any deadline.
  // On it is the one that counts; it is given somewhere to go here so the
  // sweep would fire if a zero were ever treated as a deadline.
  {
    const onIt = board.states.find((st) => st.name === 'On it');
    const waiting = board.states.find((st) => st.name === 'Waiting');
    await call('/api/state', {
      id: onIt.id, name: 'On it', colour: onIt.colour, runsTimer: true,
      leftTo: waiting.id, rightTo: waiting.id, autoTo: waiting.id,
      sortOrder: onIt.sort_order,
    });
  }
  await call('/api/tap', { taskId: square.id, page: firstPage, side: 'left' });
  board = (await call('/api/board?page=' + firstPage)).data;
  check('it is in the counting state',
    nameOfState(board, board.tasks.find((t) => String(t.id) === String(square.id)).state_id) === 'On it');

  await wait(9000);
  board = (await call('/api/board?page=' + firstPage)).data;
  check('nothing timed it out',
    nameOfState(board, board.tasks.find((t) => String(t.id) === String(square.id)).state_id) === 'On it',
    'it moved, so a zero was treated as a deadline');

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query(
    "select count(*)::int as n from moves where cause = 'timeout' and task_id = $1", [square.id]);
  check('and no timeout was recorded', rows[0].n === 0, `${rows[0].n} timeouts`);
  await db.end();
}

console.log('a square can be filed under the page beside it');
{
  board = (await call('/api/board')).data;
  const here = board.pages.find((p) => String(p.id) === String(board.page));
  const other = board.pages.find((p) => String(p.id) !== String(board.page));

  // Something worth keeping, so that losing any of it in the move would show.
  const square = board.tasks[0];
  await call('/api/task', {
    taskId: square.id, page: board.page,
    title: 'something to carry', matchKey: 'CarryMe', expectedSeconds: 300,
  });
  await call('/api/tap', { taskId: square.id, page: board.page, side: 'left' });

  const before = (await call('/api/board')).data;
  const carried = before.tasks.find((t) => t.id === square.id);
  const wasIn = carried.state_id;
  const countHere = before.tasks.length;

  const r = await call('/api/slot/move', { taskId: square.id, toPage: other.id, page: board.page });
  check('the move was accepted', r.status === 200, `status ${r.status}`);

  const left = r.data;
  check('it is gone from the page it was on',
    !left.tasks.some((t) => t.id === square.id), `${left.tasks.length} left`);
  check('and nothing else left with it', left.tasks.length === countHere - 1);

  const arrived = (await call(`/api/board?page=${other.id}`)).data;
  const there = arrived.tasks.find((t) => t.id === square.id);
  check('it is on the other page now', Boolean(there), `page ${other.id}`);
  check('with its name', there && there.title === 'something to carry', there && there.title);
  check('its session', there && there.match_key === 'CarryMe');
  check('its estimate', there && there.expected_seconds === 300, there && there.expected_seconds);
  check('and still in the state it was in', there && there.state_id === wasIn);
  check('it landed at the end rather than on top of something',
    there && arrived.tasks.filter((t) => t.slot === there.slot).length === 1,
    `slot ${there && there.slot}`);

  // The page id comes from a browser, so it is checked against the account
  // rather than taken at its word.
  const stranger = await call('/api/slot/move', { taskId: square.id, toPage: 999999, page: other.id });
  check('a page that is not yours is refused', stranger.status === 400, `status ${stranger.status}`);

  const backHome = (await call(`/api/board?page=${here.id}`)).data;
  check('and the refusal moved nothing', !backHome.tasks.some((t) => t.id === square.id));
}

console.log('squares can be slid up and down the page');
{
  board = (await call(`/api/board`)).data;
  const first = board.tasks[0];
  const second = board.tasks[1];

  const r = await call('/api/slot/reorder', { taskId: second.id, direction: 'earlier', page: board.page });
  check('the move was accepted', r.status === 200, `status ${r.status}`);
  check('the second square is now first', r.data.tasks[0].id === second.id,
    r.data.tasks.map((t) => t.id).join(','));
  check('and the first one took its place', r.data.tasks[1].id === first.id);
  check('nothing else changed places', r.data.tasks.length === board.tasks.length);

  const back = await call('/api/slot/reorder', { taskId: second.id, direction: 'later', page: board.page });
  check('and it goes back the way it came', back.data.tasks[0].id === first.id);

  const top = await call('/api/slot/reorder', { taskId: first.id, direction: 'earlier', page: board.page });
  check('the first square has nowhere earlier to go, and says so quietly',
    top.status === 200 && top.data.tasks[0].id === first.id, `status ${top.status}`);

  const last = board.tasks[board.tasks.length - 1];
  const bottom = await call('/api/slot/reorder', { taskId: last.id, direction: 'later', page: board.page });
  check('nor the last one later',
    bottom.status === 200 && bottom.data.tasks[bottom.data.tasks.length - 1].id === last.id);
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
