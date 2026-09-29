// A sign-in from a device the account has not seen cuts every PC off, when a
// PC asked for that (T-073); the board's emergency stop cuts them off whether
// or not one asked (T-077); and only the PC's own road switches the guard or
// brings a PC back (T-075). Walked against a real server and a real Postgres,
// with the PCs played over the same stream and addresses the program uses.
//
//   DATABASE_URL=... BASE=http://127.0.0.1:3040 node test/guard.js
import pg from 'pg';
import { newAccount, loginBody } from './browser.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One browser: every cookie the server sets is kept, because this test is
// about the one that is not the session — `known_device` — and about what a
// browser that has none of them looks like.
function browser() {
  const jar = new Map();
  const call = async (path, body) => {
    const res = await fetch(BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = await res.text();
    try { return { status: res.status, data: text ? JSON.parse(text) : null }; }
    catch (_) { return { status: res.status, data: text }; }
  };
  call.jar = jar;
  return call;
}

// The PC's road: no cookie, the token is the address.
const agentPost = async (token, path, payload) => {
  const res = await fetch(`${BASE}/agent/${token}${path}`, {
    method: 'POST',
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, text: (await res.text()).trim() };
};

// A stream held open, whether the server has closed it, and what it said
// first (`head`: the first blocks, for the `event: guard` the board opens with).
async function openStream(token) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/agent/${token}/events`, { signal: controller.signal });
  const state = { status: res.status, closed: false, body: '', head: '' };
  if (res.ok) {
    (async () => {
      try {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (state.head.length < 400) state.head += decoder.decode(value, { stream: true });
        }
      } catch (_) { /* aborted */ }
      state.closed = true;
    })();
  } else {
    state.body = (await res.text()).trim();
    state.closed = true;
  }
  state.close = () => controller.abort();
  return state;
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const stamp = Date.now();
const email = `guard${stamp}@example.com`;
const PASSWORD = 'a-long-enough-password';
const first = browser();
const { keys, body } = await newAccount(email, PASSWORD);
let r = await first('/api/register', body);
check('an account is made', r.status === 200, JSON.stringify(r.data));
check('and the browser that made it is marked as known', first.jar.has('known_device'));

const pcs = (b) => b.agents || [];
const pc = (b, id) => pcs(b).find((a) => String(a.id) === String(id));

console.log('two PCs on the account');
r = await first('/api/agent/register', { name: 'desk' });
const token = r.data.token; const pcId = r.data.id;
r = await first('/api/agent/register', { name: 'laptop' });
const token2 = r.data.token; const pcId2 = r.data.id;
check('both are registered', pcs(r.data.board).length === 2);
// On from the start (T-082, sql/014_guard_default_on.sql): nobody has to
// find the switch for the cut to be there.
check('and both start with the guard on — the default — and not cut off',
  pcs(r.data.board).every((a) => a.guard === true && a.suspended_at === null),
  JSON.stringify(pcs(r.data.board)));

console.log('the guard is switched from the PC\'s road only');
{
  r = await first('/api/agent/guard', { id: pcId, on: false });
  check('the board\'s session cannot switch it', r.status === 404, `status ${r.status}`);
  let p = await agentPost(token, '/guard', { on: 'yes' });
  check('a body that is not {on: true|false} is refused', p.status === 400, `${p.status} ${p.text}`);
  p = await agentPost(token2, '/guard', { on: false });
  check('the second PC switches its own off', p.status === 200 && p.text === 'ok: guard off', `${p.status} ${p.text}`);
  const board = (await first('/api/board')).data;
  check('and the board shows it, read only — the first PC still on, as it started',
    pc(board, pcId).guard === true && pc(board, pcId2).guard === false, JSON.stringify(pcs(board)));

  // The read (T-085): the board says the switch at the top of every stream,
  // so the PC's own copy can follow it. The frame comes before any ping.
  const on = await openStream(token);
  const offStream = await openStream(token2);
  await wait(300);
  check('a stream opens with the board\'s word on the switch: on for the first PC',
    on.head.includes('event: guard\ndata: {"on":true}\n\n'), JSON.stringify(on.head));
  check('and off for the second', offStream.head.includes('event: guard\ndata: {"on":false}\n\n'),
    JSON.stringify(offStream.head));
  check('said once, right after the connected comment',
    on.head.startsWith(': connected\n\nevent: guard\n') && on.head.split('event: guard').length === 2,
    JSON.stringify(on.head));
  on.close(); offStream.close();
  await wait(200);
}

console.log('a sign-in from a device the account knows changes nothing');
{
  const one_ = await openStream(token);
  const two = await openStream(token2);
  await first('/api/logout');
  check('signing out keeps the mark', first.jar.has('known_device'));
  r = await first('/api/login', await loginBody(email, PASSWORD));
  check('the sign-in is accepted', r.status === 200, JSON.stringify(r.data));
  await wait(300);
  const board = (await first('/api/board')).data;
  check('no PC is cut off', pcs(board).every((a) => a.suspended_at === null), JSON.stringify(pcs(board)));
  check('and both streams are still open', !one_.closed && !two.closed);
  one_.close(); two.close();
  await wait(200);
}

console.log('a sign-in from a new device cuts every PC off');
{
  const one_ = await openStream(token);
  const two = await openStream(token2);
  const stranger = browser();
  r = await stranger('/api/login', await loginBody(email, PASSWORD));
  check('the sign-in itself is accepted', r.status === 200, JSON.stringify(r.data));
  check('and that browser is marked as known from now on', stranger.jar.has('known_device'));
  await wait(300);
  const board = (await stranger('/api/board')).data;
  check('both PCs are cut off — the one that asked and the one that did not',
    pcs(board).every((a) => a.suspended_at !== null), JSON.stringify(pcs(board)));
  check('both streams were closed by the server', one_.closed && two.closed);

  const again = await openStream(token2);
  check('a stream while cut off is refused with 403 suspended', again.status === 403 && again.body === 'suspended',
    `${again.status} ${again.body}`);
  const ack = await agentPost(token2, '/jobs/1/ack');
  check('so is a receipt', ack.status === 403 && ack.text === 'suspended', `${ack.status} ${ack.text}`);
  const result = await agentPost(token2, '/jobs/1/result', { ok: true });
  check('and a verdict', result.status === 403 && result.text === 'suspended', `${result.status} ${result.text}`);

  // A press while every PC is cut off finds nobody: the square goes the way
  // it goes when no PC came for the instruction.
  const { rows } = await db.query('select id, slot from tasks where user_id = (select id from users where email = $1) and slot = 0', [email]);
  const square = rows[0];
  const fresh = (await stranger('/api/board')).data;
  const { subKeysFrom, encryptText } = await import('../public/crypto.js');
  const { dataKey } = await subKeysFrom(keys.masterRaw);
  await stranger('/api/task', { taskId: square.id, page: fresh.page,
    commandSealed: await encryptText(dataKey, JSON.stringify({ kind: 'url', args: { url: 'https://example.com' } })) });
  const { id } = (await stranger('/api/job/new', { taskId: square.id })).data;
  await stranger('/api/job/submit', { id, page: fresh.page,
    sealed: await encryptText(dataKey, JSON.stringify({ id, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } })) });
  await wait(5600);
  const job = (await db.query('select status from jobs where id = $1', [id])).rows[0];
  check('an instruction pressed meanwhile expires — no PC is handed it', job.status === 'expired', JSON.stringify(job));

  console.log('coming back is the PC\'s road only');
  r = await stranger('/api/agent/resume', { id: pcId });
  check('the board\'s session cannot bring a PC back', r.status === 404, `status ${r.status}`);
  const p = await agentPost(token, '/resume');
  check('the PC brings itself back', p.status === 200 && p.text === 'ok: resumed', `${p.status} ${p.text}`);
  const back = await openStream(token);
  check('and its stream opens again', back.status === 200);
  const other = await openStream(token2);
  check('while the other PC stays cut off', other.status === 403);
  const now = (await stranger('/api/board')).data;
  check('which the board shows', pc(now, pcId).suspended_at === null && pc(now, pcId2).suspended_at !== null,
    JSON.stringify(pcs(now)));
  back.close();
  await agentPost(token2, '/resume');
  await wait(200);
}

console.log('the recovery key is a sign-in too');
{
  const stranger = browser();
  r = await stranger('/api/account/recover', { email, recoveryToken: keys.recoveryToken });
  check('the way in with the key is accepted', r.status === 200, JSON.stringify(r.data));
  await wait(300);
  const board = (await stranger('/api/board')).data;
  check('and from a new device it cuts the PCs off as well', pcs(board).every((a) => a.suspended_at !== null),
    JSON.stringify(pcs(board)));
  await agentPost(token, '/resume');
  await agentPost(token2, '/resume');
}

console.log('with every guard switched off, a new device changes nothing');
{
  // Off is something a PC has to ask for now, on each of them.
  await agentPost(token2, '/guard', { on: false });
  const p = await agentPost(token, '/guard', { on: false });
  check('the PC switches it off', p.status === 200 && p.text === 'ok: guard off', `${p.status} ${p.text}`);
  const off = (await first('/api/board')).data;
  check('and no PC of the account has it on', pcs(off).every((a) => a.guard === false), JSON.stringify(pcs(off)));
  const one_ = await openStream(token);
  const stranger = browser();
  r = await stranger('/api/login', await loginBody(email, PASSWORD));
  check('the sign-in is accepted', r.status === 200);
  await wait(300);
  const board = (await stranger('/api/board')).data;
  check('no PC is cut off', pcs(board).every((a) => a.suspended_at === null), JSON.stringify(pcs(board)));
  check('and the stream stayed open', !one_.closed);
  one_.close();
  await wait(200);
}

console.log('the emergency stop on the board');
{
  const one_ = await openStream(token);
  const two = await openStream(token2);
  r = await first('/api/agents/kill', {});
  check('is accepted from the board\'s session', r.status === 200, JSON.stringify(r.data));
  await wait(300);
  check('and cuts every PC off although no guard is on', pcs(r.data).every((a) => a.suspended_at !== null),
    JSON.stringify(pcs(r.data)));
  check('closing both streams', one_.closed && two.closed);
  const again = await openStream(token);
  check('which are refused with 403 suspended until the PC resumes', again.status === 403 && again.body === 'suspended');
  const p = await agentPost(token, '/resume');
  check('and the PC\'s road brings it back', p.status === 200);
  const back = await openStream(token);
  check('with a stream that opens', back.status === 200);
  back.close();
  await agentPost(token2, '/resume');
  await wait(200);
}

console.log('a token nobody has');
{
  const p = await agentPost('no-such-token', '/guard', { on: true });
  check('cannot switch anything', p.status === 404);
  const q_ = await agentPost('no-such-token', '/resume');
  check('nor resume anything', q_.status === 404);
}

await db.end();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
