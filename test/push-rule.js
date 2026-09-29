// Checks the one rule the owner stated about notifications: a move the board
// makes on its own is announced; a move the owner made by tapping is not.
//
// It does this by standing up a fake push endpoint and counting what actually
// arrives there, rather than by trusting the code path.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { registerBody, loginBody, newAccount } from './browser.js';
import { subKeysFrom, encryptText } from '../public/crypto.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';
const CAPTURE_PORT = Number(process.env.CAPTURE_PORT || 3099);

let received = 0;
// web-push refuses to speak plain HTTP — Apple's endpoint is always TLS — so the
// stand-in has to present a certificate too. Self-signed, trusted only by the
// server process under test.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tls = {
  key: fs.readFileSync(path.join(HERE, 'key.pem')),
  cert: fs.readFileSync(path.join(HERE, 'cert.pem')),
};
const capture = https.createServer(tls, (req, res) => {
  req.resume();
  req.on('end', () => { received += 1; res.writeHead(201); res.end(); });
});
await new Promise((r) => capture.listen(CAPTURE_PORT, '127.0.0.1', r));

let cookie = '';
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

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nameOfState = (b, id) => (b.states.find((s) => String(s.id) === String(id)) || {}).name;
const slot0 = (b) => b.tasks.find((t) => t.slot === 0);

// A real P-256 key pair, because web-push encrypts the payload against it and
// a made-up string would be rejected before anything left the process.
const ecdh = crypto.createECDH('prime256v1');
const p256dh = ecdh.generateKeys().toString('base64url');
const auth = crypto.randomBytes(16).toString('base64url');

const email = `push${Date.now()}@example.com`;
let r = await call('/api/login', await loginBody(process.env.TEST_EMAIL || email, 'a-long-enough-password' ));
if (r.status !== 200) r = await call('/api/register', await registerBody( email, 'a-long-enough-password' ));
check('signed in', r.status === 200, JSON.stringify(r.data));

const me = (await call('/api/me')).data;
check('server has push keys configured', me.pushConfigured === true);

// Register the fake device straight into the database: the browser half of the
// handshake is not what is under test here.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: users } = await client.query('select id from users order by id desc limit 1');
await client.query(
  `insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
   on conflict (endpoint) do update set user_id = excluded.user_id,
         p256dh = excluded.p256dh, auth = excluded.auth`,
  [users[0].id, `https://127.0.0.1:${CAPTURE_PORT}/push`, p256dh, auth]
);

let board = (await call('/api/board')).data;
board = (await call('/api/task', { slot: 0, title: 'push の検証', matchKey: 'PushTest', expectedSeconds: 3 })).data;

console.log('a tap is not announced');
received = 0;
await call('/api/tap', { slot: 0, side: 'left' });    // Waiting -> On it
await call('/api/tap', { slot: 0, side: 'left' });    // On it -> Waiting
await wait(1500);
check('two manual moves sent nothing', received === 0, `received ${received}`);

console.log('a report from Claude is announced');
board = (await call('/api/board')).data;
// An instruction is what reaches the state a stop-report can move out of, and
// it is deliberately silent — nobody needs telling that the thing they just
// asked for has begun.
await call(`/hook/${board.webhookToken}`, { text: '*PushTest* — 作業中', event: 'start' });
await wait(800);
received = 0;
await call(`/hook/${board.webhookToken}`, { text: '*PushTest* — 入力待ちです' });
await wait(1500);
board = (await call('/api/board')).data;
check('the square moved', nameOfState(board, slot0(board).state_id) === 'Waiting');
check('exactly one notification went out', received === 1, `received ${received}`);

console.log('the estimate running out is announced');
// The sweep needs a state that counts down and has somewhere to go. None of
// the ones a board starts with is both, so On it is given a destination —
// the same thing anyone wanting the estimate to ring has to do.
{
  const onIt = board.states.find((st) => st.name === 'On it');
  const waiting = board.states.find((st) => st.name === 'Waiting');
  await call('/api/state', {
    id: onIt.id, name: 'On it', colour: onIt.colour, runsTimer: true,
    leftTo: waiting.id, rightTo: waiting.id, autoTo: waiting.id,
    sortOrder: onIt.sort_order,
  });
}
await call('/api/tap', { slot: 0, side: 'left' });
received = 0;
await wait(9000);
board = (await call('/api/board')).data;
check('the sweep moved it', nameOfState(board, slot0(board).state_id) === 'Waiting');
check('exactly one notification went out', received === 1, `received ${received}`);

console.log('a command square: the press is silent, what comes back is not');
{
  // A fresh account whose key this test holds, because the command has to be
  // sealed with it. Its phone is the same fake endpoint.
  const fresh = `pushdeck${Date.now()}@example.com`;
  const { keys, body } = await newAccount(fresh, 'a-long-enough-password');
  cookie = '';
  r = await call('/api/register', body);
  check('a second account was made', r.status === 200, JSON.stringify(r.data));
  const { dataKey } = await subKeysFrom(keys.masterRaw);
  const { rows: who } = await client.query('select id from users where email = $1', [fresh]);
  await client.query(
    `insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
     on conflict (endpoint) do update set user_id = excluded.user_id,
           p256dh = excluded.p256dh, auth = excluded.auth`,
    [who[0].id, `https://127.0.0.1:${CAPTURE_PORT}/push`, p256dh, auth]
  );

  board = (await call('/api/board')).data;
  const square = slot0(board);
  await call('/api/task', { taskId: square.id, page: board.page,
    commandSealed: await encryptText(dataKey, JSON.stringify({ kind: 'url', args: { url: 'https://example.com' } })) });
  const { token } = (await call('/api/agent/register', {})).data;

  // The PC, held open for the whole section.
  const controller = new AbortController();
  await fetch(`${BASE}/agent/${token}/events`, { signal: controller.signal });
  await wait(200);

  const press = async () => {
    const { id } = (await call('/api/job/new', { taskId: square.id })).data;
    await call('/api/job/submit', { id, page: board.page,
      sealed: await encryptText(dataKey, JSON.stringify({ id, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } })) });
    return id;
  };
  const agentPost = (path, payload) => fetch(`${BASE}/agent/${token}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });

  received = 0;
  const id = await press();
  await wait(800);
  check('the press itself rang nothing', received === 0, `received ${received}`);
  await agentPost(`/jobs/${id}/ack`);
  await wait(800);
  check('nor did the receipt', received === 0, `received ${received}`);
  await agentPost(`/jobs/${id}/result`, { ok: true });
  await wait(1500);
  check('the answer rang once', received === 1, `received ${received}`);

  received = 0;
  const id2 = await press();
  await agentPost(`/jobs/${id2}/ack`);
  await agentPost(`/jobs/${id2}/result`, { ok: false });
  await wait(1500);
  check('a failure rings once too', received === 1, `received ${received}`);

  received = 0;
  await press();                                  // never acknowledged
  await wait(7000);
  check('nobody collecting it rings once', received === 1, `received ${received}`);

  controller.abort();
}

await client.end();
capture.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
