import { registerBody, loginBody, proofOf } from './browser.js';
// The four states the board starts with are a starting point, not a fixture.
// They can be renamed, added to, removed, and rewired, and the arrows between
// them must survive all of it — which they do because an arrow points at a row,
// not at a word. Also covers reissuing the inlet address.
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

const named = (b, n) => b.states.find((s) => s.name === n);
const byId = (b, id) => b.states.find((s) => String(s.id) === String(id));
const nameOf = (b, id) => (byId(b, id) || {}).name;
const slot0 = (b) => b.tasks.find((t) => t.slot === 0);

// Saving a state means sending the whole row back, so this keeps the callers
// honest about which field they meant to change.
const save = (st, changes = {}) => call('/api/state', {
  id: st.id, name: st.name, colour: st.colour, runsTimer: st.runs_timer,
  leftTo: st.left_to, rightTo: st.right_to, autoTo: st.auto_to, startTo: st.start_to,
  sortOrder: st.sort_order, ...changes,
});

await call('/api/register', await registerBody(`states${Date.now()}@example.com`, 'a-long-enough-password'));
let board = (await call('/api/board')).data;

console.log('a state is a row with an identity, not a word');
{
  const running = named(board, 'Running');
  const waiting = named(board, 'Waiting');
  check('the arrow out of it points at a row', String(running.auto_to) === String(waiting.id),
    `${running.auto_to} vs ${waiting.id}`);

  // Rename the state the arrow points AT.
  board = (await save(waiting, { name: 'あがり' })).data;
  const renamed = byId(board, waiting.id);
  check('the rename took', renamed.name === 'あがり', renamed.name);
  check('the arrow still points at the same row',
    String(byId(board, running.id).auto_to) === String(waiting.id));
  check('and now reads as the new name',
    nameOf(board, byId(board, running.id).auto_to) === 'あがり');
}

console.log('renaming does not disturb the squares sitting in it');
{
  const state = slot0(board).state_id;
  check('the square still points at its row', String(state) === String(named(board, 'あがり').id));
  check('and shows the new name', nameOf(board, state) === 'あがり');
}

console.log('the set is not fixed at four');
{
  board = (await call('/api/state', { name: 'レビュー中', colour: '#7c5cff', sortOrder: 9 })).data;
  check('a fifth can be added', board.states.length === 5, `${board.states.length} states`);

  const review = named(board, 'レビュー中');
  const stopped = named(board, 'Stopped');
  board = (await save(stopped, { rightTo: review.id })).data;
  check('an existing state can point at the new one',
    nameOf(board, named(board, 'Stopped').right_to) === 'レビュー中');

  // And removed again, once nothing points at it from a square.
  board = (await call('/api/state/delete', { id: review.id })).data;
  check('it can be removed', board.states.length === 4, `${board.states.length} states`);
  check('the arrow that pointed at it is cleared, not left dangling',
    named(board, 'Stopped').right_to === null,
    String(named(board, 'Stopped').right_to));
}

console.log('two states cannot share a name');
{
  const attending = named(board, 'On it');
  const r = await save(attending, { name: 'あがり' });
  check('the clash is refused', r.status === 409, `status ${r.status}`);
  check('and says why', typeof r.data.error === 'string' && r.data.error.length > 0,
    JSON.stringify(r.data));

  board = (await call('/api/board')).data;
  check('nothing was changed by the refusal', named(board, 'On it') !== undefined);
}

console.log('a state can keep its own name while being saved');
{
  const attending = named(board, 'On it');
  const r = await save(attending, { colour: '#ff8800' });
  check('saving without renaming is not treated as a clash', r.status === 200, `status ${r.status}`);
  check('the colour changed', named(r.data, 'On it').colour === '#ff8800');
  board = r.data;
}

console.log('the inlet can be reissued');
{
  const before = board.webhookToken;
  const r = await call('/api/webhook/regenerate', {});
  check('a new address is returned', r.status === 200 && r.data.webhookToken !== before,
    `${before} -> ${r.data && r.data.webhookToken}`);
  board = r.data;

  const old = await fetch(`${BASE}/hook/${before}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '*x* — 入力待ちです' }),
  });
  check('the old address stops working at once', old.status === 404, `status ${old.status}`);

  const fresh = await fetch(`${BASE}/hook/${board.webhookToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '*x* — 入力待ちです' }),
  });
  // 422, not 200: the name `x` belongs to no square. What matters here is that
  // it is not 404 — that is the answer for an address that does not exist, and
  // this one does. The two codes are what tells a wrong URL from a wrong name.
  check('the new one works', fresh.status === 422, `status ${fresh.status}`);

  const again = await call('/api/webhook/regenerate', {});
  check('there is still exactly one address', Boolean(again.data.webhookToken)
    && again.data.webhookToken !== board.webhookToken);
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
