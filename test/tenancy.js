// Two people, the same session name, one report. Nothing may cross.
//
// Session names are chosen by whoever owns the square and are often the obvious
// word for the job — "ProjectOne", "web", "bot" — so collisions between accounts
// are not unlikely, they are expected. What keeps them apart is that a report
// arrives through an address that already names its owner, and the square is
// looked up within that owner. This checks that, rather than assuming it.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { registerBody, loginBody } from './browser.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tls = {
  key: fs.readFileSync(path.join(HERE, 'key.pem')),
  cert: fs.readFileSync(path.join(HERE, 'cert.pem')),
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A separate phone per person, so it is visible who was told.
const rung = { a: 0, b: 0 };
function phone(port, who) {
  const server = https.createServer(tls, (req, res) => {
    req.resume();
    req.on('end', () => { rung[who] += 1; res.writeHead(201); res.end(); });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}
const phoneA = await phone(3096, 'a');
const phoneB = await phone(3097, 'b');

function person() {
  let cookie = '';
  return async function call(path, body) {
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
  };
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function giveAPhone(email, port) {
  const ecdh = crypto.createECDH('prime256v1');
  const { rows } = await db.query('select id from users where lower(email) = lower($1)', [email]);
  await db.query(
    `insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
     on conflict (endpoint) do update set user_id = excluded.user_id,
           p256dh = excluded.p256dh, auth = excluded.auth`,
    [rows[0].id, `https://127.0.0.1:${port}/push`,
      ecdh.generateKeys().toString('base64url'), crypto.randomBytes(16).toString('base64url')]
  );
}

const stamp = Date.now();
const emailA = `alice${stamp}@example.com`;
const emailB = `bob${stamp}@example.com`;
const SHARED = 'web';                    // the sort of name two people both pick

const alice = person();
const bob = person();
await alice('/api/register', await registerBody(emailA, 'a-long-enough-password' ));
await bob('/api/register', await registerBody(emailB, 'a-long-enough-password' ));
await giveAPhone(emailA, 3096);
await giveAPhone(emailB, 3097);

let boardA = (await alice('/api/board')).data;
let boardB = (await bob('/api/board')).data;

const nameOfState = (b, id) => (b.states.find((s) => String(s.id) === String(id)) || {}).name;
const slot0 = (b) => b.tasks.find((t) => t.slot === 0);

console.log('the two addresses are not the same');
check('each account got its own inlet', boardA.webhookToken !== boardB.webhookToken);
check('the token is long enough not to be guessed', boardA.webhookToken.length >= 30,
  `${boardA.webhookToken.length} characters`);

console.log('both people call their square the same thing');
boardA = (await alice('/api/task', { slot: 0, title: 'アリスの web', matchKey: SHARED })).data;
boardB = (await bob('/api/task', { slot: 0, title: 'ボブの web', matchKey: SHARED })).data;
check('both squares carry the same session name',
  slot0(boardA).match_key === SHARED && slot0(boardB).match_key === SHARED);

// Into the running state, which an instruction is what reaches — no tap goes
// there. Both, so both have somewhere to go when a stop arrives.
for (const board of [boardA, boardB]) {
  await fetch(`${BASE}/hook/${board.webhookToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `*${SHARED}* — 作業中`, event: 'start' }),
  });
}
await new Promise((r) => setTimeout(r, 400));
boardA = (await alice('/api/board')).data;
boardB = (await bob('/api/board')).data;
check('both are running', nameOfState(boardA, slot0(boardA).state_id) === 'Running'
  && nameOfState(boardB, slot0(boardB).state_id) === 'Running');

console.log('a report through one inlet touches only that board');
rung.a = 0; rung.b = 0;
await fetch(`${BASE}/hook/${boardA.webhookToken}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: `*${SHARED}* — 入力待ちです` }),
});
await wait(1500);
boardA = (await alice('/api/board')).data;
boardB = (await bob('/api/board')).data;

check('the sending account square moved', nameOfState(boardA, slot0(boardA).state_id) === 'Waiting',
  `now ${nameOfState(boardA, slot0(boardA).state_id)}`);
check('the other account square did NOT move',
  nameOfState(boardB, slot0(boardB).state_id) === 'Running',
  `now ${nameOfState(boardB, slot0(boardB).state_id)}`);
check('only the sending account phone rang', rung.a === 1 && rung.b === 0,
  `alice ${rung.a}, bob ${rung.b}`);

console.log('the same is true of the start signal');
rung.a = 0; rung.b = 0;
await fetch(`${BASE}/hook/${boardB.webhookToken}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: `*${SHARED}* — 作業中`, event: 'start' }),
});
await wait(1200);
boardA = (await alice('/api/board')).data;
check('the other board is untouched by a start too',
  nameOfState(boardA, slot0(boardA).state_id) === 'Waiting',
  `now ${nameOfState(boardA, slot0(boardA).state_id)}`);
check('and nobody was rung, as starts are silent', rung.a === 0 && rung.b === 0,
  `alice ${rung.a}, bob ${rung.b}`);

console.log('the names each board has been told are its own');
{
  const seenA = ((await alice('/api/board')).data.seenNames || []).map((s) => s.name);
  const { rows } = await db.query(
    `select count(*)::int as n from seen_names s join users u on u.id = s.user_id
      where lower(u.email) = lower($1)`, [emailB]);
  check('the sending account board remembers the name', seenA.includes(SHARED), JSON.stringify(seenA));
  check('the other board only remembers what came through its own inlet', rows[0].n === 1,
    `${rows[0].n} names`);
}

console.log('an inlet that belongs to nobody is refused');
{
  const res = await fetch(`${BASE}/hook/${'x'.repeat(32)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `*${SHARED}* — 入力待ちです` }),
  });
  check('a made-up address is turned away', res.status === 404, `status ${res.status}`);
}

await db.end();
phoneA.close();
phoneB.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
