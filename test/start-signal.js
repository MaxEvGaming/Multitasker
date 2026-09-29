// The other direction. A report without an `event` means the session has
// stopped, which is what the board has always understood; `event: "start"` means
// the person has just given the session something to do.
//
// The distinction matters twice: it uses a different arrow out of the state, and
// it must not ring — the person was typing when it happened.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { registerBody, loginBody, proofOf } from './browser.js';

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
const named = (b, n) => b.states.find((s) => s.name === n);

// Counts what actually leaves for a phone, rather than trusting the branch.
let pushes = 0;
// TLS, because web-push will not speak anything else — Apple's endpoint never
// does. Self-signed, trusted only by the server under test.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const capture = https.createServer({
  key: fs.readFileSync(path.join(HERE, 'key.pem')),
  cert: fs.readFileSync(path.join(HERE, 'cert.pem')),
}, (req, res) => {
  req.resume();
  req.on('end', () => { pushes += 1; res.writeHead(201); res.end(); });
});
await new Promise((r) => capture.listen(3098, '127.0.0.1', r));

await call('/api/register', await registerBody(`start${Date.now()}@example.com`, 'a-long-enough-password'));
let board = (await call('/api/board')).data;
const token = board.webhookToken;

console.log('a new board knows where work goes when it starts');
check('Waiting points at Running when an instruction arrives',
  nameOfState(board, named(board, 'Waiting').start_to) === 'Running',
  String(named(board, 'Waiting').start_to));
// On it is somewhere you put a square yourself, and an instruction arriving
// while you are on it is not a reason to take it away from you.
check('On it stays put on an instruction',
  named(board, 'On it').start_to === null,
  String(named(board, 'On it').start_to));
check('Running has nowhere further to go on a start',
  named(board, 'Running').start_to === null);

console.log('an instruction moves the square');
{
  board = (await call('/api/task', { slot: 0, title: '開始の検証', matchKey: 'StartTest' })).data;
  check('it begins in Waiting', nameOfState(board, slot(board, 0).state_id) === 'Waiting');

  await call(`/hook/${token}`, { text: '*StartTest* — 作業中', event: 'start' });
  board = (await call('/api/board')).data;
  check('it is now Running', nameOfState(board, slot(board, 0).state_id) === 'Running',
    `now ${nameOfState(board, slot(board, 0).state_id)}`);
}

console.log('and the report that follows sends it back');
{
  await call(`/hook/${token}`, { text: '*StartTest* — 入力待ちです' });
  board = (await call('/api/board')).data;
  check('back in Waiting', nameOfState(board, slot(board, 0).state_id) === 'Waiting',
    `now ${nameOfState(board, slot(board, 0).state_id)}`);
}

console.log('starting is silent; stopping is not');
{
  // A device to notify, registered straight into the store.
  const ecdh = crypto.createECDH('prime256v1');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query('select id from users order by id desc limit 1');
  await client.query(
    `insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
     on conflict (endpoint) do update set user_id = excluded.user_id,
           p256dh = excluded.p256dh, auth = excluded.auth`,
    [rows[0].id, 'https://127.0.0.1:3098/push', ecdh.generateKeys().toString('base64url'),
      crypto.randomBytes(16).toString('base64url')]
  );

  pushes = 0;
  await call(`/hook/${token}`, { text: '*StartTest* — 作業中', event: 'start' });
  await wait(1500);
  board = (await call('/api/board')).data;
  check('the square moved on the start', nameOfState(board, slot(board, 0).state_id) === 'Running');
  check('and nothing was sent to the phone', pushes === 0, `sent ${pushes}`);

  pushes = 0;
  await call(`/hook/${token}`, { text: '*StartTest* — 入力待ちです' });
  await wait(1500);
  check('the stop still announces itself', pushes === 1, `sent ${pushes}`);

  await client.end();
}

console.log('an unknown name at the start of a turn is not worth a notification');
{
  pushes = 0;
  await call(`/hook/${token}`, { text: '*NobodyClaimsThis* — 作業中', event: 'start' });
  await wait(1200);
  check('silent when nothing claims the name', pushes === 0, `sent ${pushes}`);

  pushes = 0;
  await call(`/hook/${token}`, { text: '*NobodyClaimsThis* — 入力待ちです' });
  await wait(1200);
  check('but a stop from an unknown name still says so', pushes === 1, `sent ${pushes}`);
}

console.log('the log distinguishes the two');
{
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    'select cause, count(*)::int as n from moves group by cause order by cause');
  const byCause = Object.fromEntries(rows.map((r) => [r.cause, r.n]));
  check('starts are recorded as their own cause', (byCause.start || 0) >= 2, JSON.stringify(byCause));
  check('stops are recorded separately', (byCause.signal || 0) >= 2, JSON.stringify(byCause));
  await client.end();
}

capture.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
