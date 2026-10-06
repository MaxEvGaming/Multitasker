// A stop that ended on an error (T-513 = A). The PC adds "event": "failure" in
// the clear when Claude Code's turn ended on an API error. The square goes
// where any stop goes — the state's auto arrow — and only the sentence on the
// phone differs: "Claude stopped on an error" instead of "Claude has stopped".
//
// A report without the marker, or with one the board does not know, is a stop
// exactly as before.
//
// Unlike start-signal.js this one opens what reaches the phone, because the
// sentence is the thing under test: the stand-in device holds a real key pair,
// so the push can be decrypted here (RFC 8291, aes128gcm) and read.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { registerBody } from './browser.js';
import { say } from '../src/say.js';
import { BOOKS } from '../public/i18n.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';
const CAPTURE_PORT = Number(process.env.CAPTURE_PORT || 3097);

let cookie = '';
let failures = 0;

async function call(p, body) {
  if (body && body.slot !== undefined) {
    const view = await (await fetch(BASE + '/api/board',
      { headers: cookie ? { Cookie: cookie } : {} })).json();
    const found = (view.tasks || []).find((t) => t.slot === body.slot);
    const { slot, ...rest } = body;
    body = { ...rest, taskId: found && found.id, page: view.page };
  }
  const res = await fetch(BASE + p, {
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

// The stand-in device. A real P-256 pair and auth secret, kept here so what
// arrives can be opened.
const ecdh = crypto.createECDH('prime256v1');
const uaPublic = ecdh.generateKeys();
const authSecret = crypto.randomBytes(16);

// RFC 8291 / RFC 8188, one record — a notification is far below the record size.
function openPush(body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  // Padding: trailing zeros, then the 0x02 that marks the last record.
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end -= 1;
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

// Everything that reaches the phone, opened.
let pushes = [];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const capture = https.createServer({
  key: fs.readFileSync(path.join(HERE, 'key.pem')),
  cert: fs.readFileSync(path.join(HERE, 'cert.pem')),
}, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let opened = null;
    try { opened = openPush(Buffer.concat(chunks)); } catch (e) { opened = { error: e.message }; }
    pushes.push(opened);
    res.writeHead(201); res.end();
  });
});
await new Promise((r) => capture.listen(CAPTURE_PORT, '127.0.0.1', r));

const email = `failure${Date.now()}@example.com`;
await call('/api/register', await registerBody(email, 'a-long-enough-password'));
let board = (await call('/api/board')).data;
const token = board.webhookToken;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: users } = await client.query('select id, lang from users where email = $1', [email]);
const lang = users[0] && users[0].lang;
await client.query(
  `insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
   on conflict (endpoint) do update set user_id = excluded.user_id,
         p256dh = excluded.p256dh, auth = excluded.auth`,
  [users[0].id, `https://127.0.0.1:${CAPTURE_PORT}/push`,
    uaPublic.toString('base64url'), authSecret.toString('base64url')]
);

const where = (b) => nameOfState(b, slot(b, 0).state_id);
const autoOfRunning = () => nameOfState(board, named(board, 'Running').auto_to);
const expected = (key, from, to) => say(lang, 'why.where', { why: say(lang, key), from, to });

board = (await call('/api/task', { slot: 0, title: 'エラーの検証', matchKey: 'FailureTest' })).data;
check('Running has an auto arrow to compare against', Boolean(named(board, 'Running').auto_to));

// Puts the square on Running the way a session does, and forgets what rang.
async function running() {
  await call(`/hook/${token}`, { text: '*FailureTest* — 作業中', event: 'start' });
  await wait(800);
  board = (await call('/api/board')).data;
  pushes = [];
  return where(board) === 'Running';
}

console.log('a failure marker moves the square like a stop and says it was an error');
{
  check('it starts on Running', await running(), `now ${where(board)}`);
  const r = await call(`/hook/${token}`, { text: '*FailureTest* — エラーで止まりました', event: 'failure' });
  check('the board answers that it moved', r.status === 200 && r.data === 'ok: moved', `${r.status} ${r.data}`);
  await wait(1500);
  board = (await call('/api/board')).data;
  check(`it went where Running's auto arrow points (${autoOfRunning()})`, where(board) === autoOfRunning(),
    `now ${where(board)}`);
  check('one notification', pushes.length === 1, JSON.stringify(pushes));
  check('it says Claude stopped on an error',
    pushes[0] && pushes[0].body === expected('why.failure', 'Running', autoOfRunning()),
    pushes[0] && JSON.stringify(pushes[0]));
}

console.log('no marker: a stop as before');
{
  check('it starts on Running', await running(), `now ${where(board)}`);
  await call(`/hook/${token}`, { text: '*FailureTest* — 入力待ちです' });
  await wait(1500);
  board = (await call('/api/board')).data;
  check('same destination', where(board) === autoOfRunning(), `now ${where(board)}`);
  check('one notification', pushes.length === 1, JSON.stringify(pushes));
  check('it says Claude has stopped, not an error',
    pushes[0] && pushes[0].body === expected('why.signal', 'Running', autoOfRunning()),
    pushes[0] && JSON.stringify(pushes[0]));
}

console.log('a marker the board does not know: a stop as before');
{
  check('it starts on Running', await running(), `now ${where(board)}`);
  await call(`/hook/${token}`, { text: '*FailureTest* — 入力待ちです', event: 'something-else' });
  await wait(1500);
  board = (await call('/api/board')).data;
  check('same destination', where(board) === autoOfRunning(), `now ${where(board)}`);
  check('it says Claude has stopped',
    pushes.length === 1 && pushes[0].body === expected('why.signal', 'Running', autoOfRunning()),
    JSON.stringify(pushes));
}

console.log('a failure from a name nothing claims is reported as before');
{
  pushes = [];
  const r = await call(`/hook/${token}`, { text: '*NobodyClaimsThisFailure* — エラーで止まりました', event: 'failure' });
  await wait(1200);
  check('the board says it matched nothing', r.status === 422, `${r.status} ${r.data}`);
  check('one notification, the usual "no square matches"',
    pushes.length === 1 && pushes[0].tag === 'unmatched'
      && pushes[0].body === 'エラーで止まりました' && pushes[0].title === 'NobodyClaimsThisFailure',
    JSON.stringify(pushes));
}

console.log('a sealed square: the phone is handed the reason "failure"');
{
  // The server cannot read a sealed square, so it hands the phone a code and the
  // phone writes the sentence. Any opaque strings stand in for the ciphertext.
  board = (await call('/api/task', { slot: 0, titleCipher: 'v1.sealed-title', matchHash: 'hash-failure-test' })).data;
  await call(`/hook/${token}`, { matchHash: 'hash-failure-test', nameCipher: 'v1.sealed-name', event: 'start' });
  await wait(800);
  board = (await call('/api/board')).data;
  check('it starts on Running', where(board) === 'Running', `now ${where(board)}`);
  pushes = [];
  await call(`/hook/${token}`, { matchHash: 'hash-failure-test', nameCipher: 'v1.sealed-name', event: 'failure' });
  await wait(1500);
  board = (await call('/api/board')).data;
  check('same destination', where(board) === autoOfRunning(), `now ${where(board)}`);
  check('reason "failure", and no sentence the server could have written',
    pushes.length === 1 && pushes[0].reason === 'failure' && pushes[0].body === undefined,
    JSON.stringify(pushes));
  // The worker on the phone turns the code into words (public/sw.js).
  const sw = fs.readFileSync(path.join(HERE, '..', 'public', 'sw.js'), 'utf8');
  check('the phone knows the code', /failure:\s*'why\.failure'/.test(sw));
  check('and has the words in both languages',
    BOOKS.en['why.failure'] === 'Claude stopped on an error'
      && BOOKS.ja['why.failure'] === 'Claude がエラーで止まりました');
}

console.log('the log records it as its own cause');
{
  const { rows } = await client.query(
    `select cause, count(*)::int as n from moves where user_id = $1 group by cause`, [users[0].id]);
  const byCause = Object.fromEntries(rows.map((r) => [r.cause, r.n]));
  check('two failures', byCause.failure === 2, JSON.stringify(byCause));
  check('two ordinary stops', byCause.signal === 2, JSON.stringify(byCause));
}

await client.end();
capture.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
