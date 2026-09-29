// The way in for the second person.
//
// The door shuts itself once an account exists, which was right while there was
// one user and useless for any more. A code opens it once — so this checks that
// "once" holds, including when two people try the same one at the same moment,
// which is the case a check-then-insert would get wrong.
//
// It runs its own server on another port, with the door left shut. The shared
// one is started with registration open so the other tests can make accounts
// freely, and "open" is precisely the condition this file is not about.
import { spawn } from 'node:child_process';
import { q, one, pool } from '../src/db.js';
import { newToken } from '../src/auth.js';
import { registerBody } from './browser.js';

const PORT = 3041;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const { REGISTRATION_OPEN, ...doorShut } = process.env;
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...doorShut, PORT: String(PORT) },
  stdio: 'ignore',
});
const stop = () => { try { server.kill(); } catch (_) {} };
process.on('exit', stop);

// Wait for it rather than sleeping a guessed amount.
for (let tries = 0; tries < 60; tries += 1) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) break;
  } catch (_) { /* not yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

// Sent the way the screen sends it: keys made here, a proof in place of the
// password. Every test below hands over an address and a password and lets this
// do the rest.
const register = async ({ email, password, ...extra }) => fetch(`${BASE}/api/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(await registerBody(email, password, extra)),
}).then(async (r) => ({
  status: r.status,
  cookie: (r.headers.get('set-cookie') || '').split(';')[0],
  data: await r.json().catch(() => ({})),
}));

const mint = async (days = null) => {
  const code = newToken(18);
  await one(
    `insert into invites(code, note, expires_at)
     values ($1, 'test', case when $2::int is null then null else now() + make_interval(days => $2::int) end)
     returning code`, [code, days]);
  return code;
};

const address = () => `invite${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
const PASSWORD = 'a-long-enough-password';

console.log('the door is shut to begin with');
{
  const none = await register({ email: address(), password: PASSWORD });
  check('no code, no account', none.status === 403, `status ${none.status}`);
}

console.log('a code lets one person in');
{
  const code = await mint();
  const first = await register({ email: address(), password: PASSWORD, invite: code });
  check('the invited account was made', first.status === 200, JSON.stringify(first.data));

  const used = await one('select used_at, used_by from invites where code = $1', [code]);
  check('the code is marked as spent', Boolean(used.used_at));
  check('and remembers who spent it', Boolean(used.used_by));
}

console.log('and only one');
{
  const code = await mint();
  await register({ email: address(), password: PASSWORD, invite: code });
  const second = await register({ email: address(), password: PASSWORD, invite: code });
  check('the same code a second time is refused', second.status === 403, `status ${second.status}`);
  check('and the refusal says something useful',
    /invitation|招待/.test(second.data.error || ''), second.data.error);
}

console.log('two people racing the same code');
{
  // This is why the claim happens inside the transaction that makes the
  // account: checking first and inserting afterwards leaves a gap for both.
  const code = await mint();
  const results = await Promise.all([
    register({ email: address(), password: PASSWORD, invite: code }),
    register({ email: address(), password: PASSWORD, invite: code }),
    register({ email: address(), password: PASSWORD, invite: code }),
  ]);
  const through = results.filter((r) => r.status === 200).length;
  check('exactly one gets through', through === 1, `${through} did`);
}

console.log('what is not a code');
{
  const made = await register({ email: address(), password: PASSWORD, invite: 'not-a-real-code' });
  check('an invented code is refused', made.status === 403, `status ${made.status}`);

  const expired = newToken(18);
  await q(`insert into invites(code, note, expires_at) values ($1, 'test', now() - interval '1 day')`, [expired]);
  const late = await register({ email: address(), password: PASSWORD, invite: expired });
  check('an expired one is refused', late.status === 403, `status ${late.status}`);
}

console.log('an account made this way is a whole account');
{
  const code = await mint();
  const made = await register({ email: address(), password: PASSWORD, invite: code });
  const board = await fetch(`${BASE}/api/board`, { headers: { Cookie: made.cookie } }).then((r) => r.json());
  check('it is signed in straight away', Array.isArray(board.tasks), JSON.stringify(board).slice(0, 60));
  check('with a page of its own', board.pages.length === 1);
  check('and squares on it', board.tasks.length === 15, `${board.tasks.length}`);
  check('and its own inlet', Boolean(board.webhookToken));
}

console.log('a refused attempt leaves nothing behind');
{
  const email = address();
  await register({ email, password: PASSWORD, invite: 'still-not-a-code' });
  const stray = await one('select 1 from users where lower(email) = lower($1)', [email]);
  check('no half-made account', !stray);
}

stop();
await pool.end();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
