// The four protections that only matter once other people can have accounts:
// login throttling, password change, password reset, account deletion — plus a
// ceiling on the public inlet.
import { pool } from '../src/db.js';
import { createResetToken } from '../src/account.js';
import {
  registerBody, loginBody, proofOf, newAccount, passwordChangeBody, resetBody,
} from './browser.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// Each caller keeps its own cookie jar so one test signing out cannot disturb
// another.
function client() {
  let cookie = '';
  return async function call(path, body, headers = {}) {
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
        ...headers,
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

const stamp = Date.now();
const PASSWORD = 'a-long-enough-password';

console.log('login throttling');
{
  const call = client();
  const email = `throttle${stamp}@example.com`;
  await call('/api/register', await registerBody(email, PASSWORD));

  // A different address each time would spread the count over the per-IP rule
  // instead of the per-email one, so hold it steady.
  const ip = { 'X-Forwarded-For': `203.0.113.${stamp % 200}` };
  let sawLock = false;
  let attempts = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = await call('/api/login', await loginBody(email, 'wrong-password-here'), ip);
    attempts += 1;
    if (r.status === 429) { sawLock = true; break; }
  }
  check('repeated wrong passwords are eventually refused', sawLock, `gave up after ${attempts}`);
  check('the lock arrives before the tenth try', attempts <= 10, `took ${attempts}`);

  const still = await call('/api/login', await loginBody(email, PASSWORD), ip);
  check('even the right password is held off while locked', still.status === 429, `status ${still.status}`);

  // A different address is a different bucket, so the account itself is not
  // hostage to one attacker.
  const other = await call('/api/login', await loginBody(email, PASSWORD),
    { 'X-Forwarded-For': '198.51.100.7' });
  check('the account is still reachable from elsewhere', other.status === 429 || other.status === 200,
    `status ${other.status}`);
}

console.log('an address with a space around it is the same address');
{
  // Registering trimmed and signing in did not, so an address that picked up a
  // space on the way into the field was refused — with "that password is
  // wrong", which is what it looks like from outside and is the one thing it
  // is not. Nobody could have diagnosed that from the screen.
  const call = client();
  const email = `spaced${stamp}@example.com`;
  await call('/api/register', await registerBody(email, PASSWORD));

  for (const [what, typed] of [
    ['a trailing space', `${email} `],
    ['a leading space', ` ${email}`],
    ['spaces at both ends', `  ${email}  `],
    ['a different case', email.toUpperCase()],
  ]) {
    const fresh = client();
    const r = await fresh('/api/login', await loginBody(typed, PASSWORD),
      { 'X-Forwarded-For': '198.51.100.40' });
    check(`${what} still signs in`, r.status === 200, `status ${r.status}`);
  }

  // And the tidying has to reach the duplicate check too, or the same address
  // with a space could be registered twice and neither could be signed into.
  const again = client();
  const dup = await again('/api/register', await registerBody(` ${email} `, PASSWORD));
  check('and cannot be registered a second time', dup.status === 409, `status ${dup.status}`);
}
console.log('changing a password');
{
  const call = client();
  const email = `change${stamp}@example.com`;
  const { keys, body } = await newAccount(email, PASSWORD);
  await call('/api/register', body);

  let r = await call('/api/account/password',
    await passwordChangeBody(email, 'not-the-password', 'a-brand-new-password', keys.masterRaw));
  check('the wrong current password is refused', r.status === 400, `status ${r.status}`);

  // The server cannot measure a password any more — it is handed a proof, which
  // is the same length whatever was typed. What it can still refuse is a raw
  // password arriving where a proof belongs, which would mean the browser had
  // stopped deriving and was handing every password straight over.
  r = await call('/api/account/password', { current: PASSWORD, next: 'short' });
  check('a raw password where a proof belongs is refused', r.status === 400, `status ${r.status}`);

  r = await call('/api/account/password',
    await passwordChangeBody(email, PASSWORD, 'a-brand-new-password', keys.masterRaw));
  check('the change is accepted', r.status === 200, JSON.stringify(r.data));

  const fresh = client();
  const ip = { 'X-Forwarded-For': '198.51.100.20' };
  check('the old password no longer works',
    (await fresh('/api/login', await loginBody(email, PASSWORD), ip)).status === 401);
  check('the new password works',
    (await fresh('/api/login', await loginBody(email, 'a-brand-new-password'), ip)).status === 200);
}

console.log('resetting a forgotten password');
{
  const call = client();
  const email = `reset${stamp}@example.com`;
  await call('/api/register', await registerBody(email, PASSWORD));
  check('signed in before the reset', (await call('/api/board')).status === 200);

  const token = await createResetToken(email);
  check('a token can be minted for a real account', Boolean(token));
  check('no token for an address nobody has', (await createResetToken(`nobody${stamp}@example.com`)) === null);

  const anon = client();
  let r = await anon('/api/account/reset', { token, password: 'short' });
  check('a raw password where a proof belongs is refused', r.status === 400, `status ${r.status}`);

  r = await anon('/api/account/reset', await resetBody(token, 'the-reset-password'));
  check('the reset is accepted', r.status === 200, JSON.stringify(r.data));

  r = await anon('/api/account/reset', await resetBody(token, 'another-password-x'));
  check('the same token cannot be used twice', r.status === 400, `status ${r.status}`);

  check('sessions open before the reset are dropped', (await call('/api/board')).status === 401);

  const after = client();
  check('the new password works',
    (await after('/api/login', await loginBody(email, 'the-reset-password'),
      { 'X-Forwarded-For': '198.51.100.21' })).status === 200);
}

console.log('deleting an account');
{
  const call = client();
  const email = `delete${stamp}@example.com`;
  await call('/api/register', await registerBody(email, PASSWORD));
  const board = (await call('/api/board')).data;
  check('the account has squares before deletion', board.tasks.length === 15);

  let r = await call('/api/account/delete', { password: await proofOf(email, 'not-the-password') });
  check('the wrong password is refused', r.status === 400, `status ${r.status}`);

  r = await call('/api/account/delete', { password: await proofOf(email, PASSWORD) });
  check('the deletion is accepted', r.status === 200, JSON.stringify(r.data));

  const after = client();
  check('the account can no longer sign in',
    (await after('/api/login', await loginBody(email, PASSWORD),
      { 'X-Forwarded-For': '198.51.100.22' })).status === 401);

  const { rows } = await pool.query(
    `select (select count(*) from users where lower(email) = lower($1)) as users,
            (select count(*) from tasks t join users u on u.id = t.user_id
              where lower(u.email) = lower($1)) as tasks`, [email]);
  check('its rows went with it', Number(rows[0].users) === 0 && Number(rows[0].tasks) === 0,
    JSON.stringify(rows[0]));
}

console.log('a ceiling on the public inlet');
{
  const call = client();
  const email = `hook${stamp}@example.com`;
  await call('/api/register', await registerBody(email, PASSWORD));
  const { webhookToken } = (await call('/api/board')).data;

  let limited = 0;
  let sent = 0;
  for (let i = 0; i < 130; i += 1) {
    const res = await fetch(`${BASE}/hook/${webhookToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '*nobody* — 入力待ちです' }),
    });
    if (res.status === 429) limited += 1; else sent += 1;
  }
  check('deliveries are refused once the ceiling is passed', limited > 0, `accepted all ${sent}`);
  check('ordinary volumes are not touched', sent >= 100, `only ${sent} got through`);
}

console.log('registering and asking for a salt are counted per address');
{
  const call = client();
  // One address, held steady, so the count lands on the per-IP rule. The
  // helper hands each registration its own address otherwise (browser.js).
  const ip = { 'X-Forwarded-For': `203.0.113.${(stamp + 1) % 200}` };
  let sixth = null;
  for (let i = 0; i < 6; i += 1) {
    sixth = await call('/api/register', await registerBody(`door${stamp}-${i}@example.com`, PASSWORD), ip);
    if (i < 5) check(`registration ${i + 1} from one address goes through`, sixth.status === 200, `status ${sixth.status}`);
  }
  check('the sixth registration from that address is refused', sixth.status === 429, `status ${sixth.status}`);
  check('and says so in words', String(sixth.data && sixth.data.error).includes('address'), JSON.stringify(sixth.data));
  const elsewhere = await call('/api/register', await registerBody(`door${stamp}-x@example.com`, PASSWORD),
    { 'X-Forwarded-For': `203.0.113.${(stamp + 2) % 200}` });
  check('another address is another count', elsewhere.status === 200, `status ${elsewhere.status}`);

  const salt = { 'X-Forwarded-For': `203.0.113.${(stamp + 3) % 200}` };
  let last = null;
  let refusedAt = 0;
  for (let i = 0; i < 61; i += 1) {
    last = await call('/api/prelogin', { email: `nobody${stamp}@example.com` }, salt);
    if (last.status === 429) { refusedAt = i + 1; break; }
  }
  check('sixty salt requests from one address go through', refusedAt === 0 || refusedAt > 60, `refused at ${refusedAt}`);
  check('the sixty-first is refused', last.status === 429, `status ${last.status}`);
}

console.log('changing the address the account is known by');
{
  const email = `mover${stamp}@example.com`;
  const moved = `moved${stamp}@example.com`;
  const mover = client();
  await mover('/api/register', await registerBody(email, PASSWORD));

  const guessed = await mover('/api/account/email',
    { email: moved, password: await proofOf(email, 'not-the-password') });
  check('the wrong password is refused', guessed.status === 400, `status ${guessed.status}`);

  const nonsense = await mover('/api/account/email',
    { email: 'not-an-address', password: await proofOf(email, PASSWORD) });
  check('something that is not an address is refused', nonsense.status === 400, `status ${nonsense.status}`);

  const done = await mover('/api/account/email',
    { email: moved, password: await proofOf(email, PASSWORD) });
  check('the right password moves it', done.status === 200, JSON.stringify(done.data));

  const fresh = client();
  const old = await fresh('/api/login', await loginBody(email, PASSWORD));
  check('the old address no longer signs in', old.status === 401, `status ${old.status}`);
  const now = await fresh('/api/login', await loginBody(moved, PASSWORD));
  check('the new one does', now.status === 200, `status ${now.status}`);

  // Two accounts on one address would make signing in ambiguous.
  const neighbour = client();
  const neighbourEmail = `taken${stamp}@example.com`;
  await neighbour('/api/register', await registerBody(neighbourEmail, PASSWORD));
  // The proof has to be made under this account's own salt, not the one it is
  // trying to move to.
  const collide = await neighbour('/api/account/email',
    { email: moved, password: await proofOf(neighbourEmail, PASSWORD) });
  check('and it will not take an address already in use',
    collide.status === 400, `status ${collide.status}`);
}

await pool.end();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
