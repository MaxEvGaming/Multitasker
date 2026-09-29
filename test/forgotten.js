// Forgetting the password with the recovery key still in hand.
//
// Until this existed, that key could open the board but not get through the
// front door: signing in wants a proof derived from the password, and someone
// who has forgotten it cannot make one. The only route was to ask whoever runs
// the site for a reset link, which is no use to a person whose board is on their
// phone at two in the morning.
import { pool } from '../src/db.js';
import {
  createKeys, recoveryTokenFor, unlockWithRecovery, unlockWithPassword,
  rewrapForPassword, rewrapForRecovery, subKeysFrom, encryptText, decryptText,
} from '../public/crypto.js';
import { loginBody } from './browser.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

function client() {
  let cookie = '';
  return async (path, body) => {
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

const stamp = Date.now();

const FORGOTTEN = 'the-password-they-forgot';
const SECRET = 'the thing they would have lost';

// The account this test can forget the password for: made here, so the
// recovery key it was handed is the one held below.
const email2 = `forgot2${stamp}@example.com`;
const made = await createKeys(FORGOTTEN);
const second = client();
{
  const r = await second('/api/register', {
    email: email2,
    password: made.authToken,
    kdfSalt: made.kdfSalt,
    wrappedByPassword: made.wrappedByPassword,
    wrappedByRecovery: made.wrappedByRecovery,
    recoveryToken: made.recoveryToken,
  });
  check('a second account, whose recovery key is known here', r.status === 200,
    JSON.stringify(r.data));

  const { dataKey } = await subKeysFrom(made.masterRaw);
  const board = (await second('/api/board')).data;
  await second('/api/task', {
    taskId: board.tasks[0].id, page: board.page,
    title: '', matchKey: '',
    titleCipher: await encryptText(dataKey, SECRET),
  });
}

console.log('the recovery key gets back in, with the password forgotten');
const back = client();
{
  const wrong = await back('/api/account/recover', {
    email: email2, recoveryToken: await recoveryTokenFor((await createKeys('x')).recoveryKey),
  });
  check('someone else’s key is refused', wrong.status === 401, `status ${wrong.status}`);

  const r = await back('/api/account/recover', {
    email: email2, recoveryToken: made.recoveryToken,
  });
  check('the right key is let in', r.status === 200, JSON.stringify(r.data));

  const master = await unlockWithRecovery(made.recoveryKey, r.data.keys.wrappedByRecovery);
  check('and it opens the key', master.length === 32);

  const { dataKey } = await subKeysFrom(master);
  const board = (await back('/api/board')).data;
  check('what was written is readable again',
    (await decryptText(dataKey, board.tasks[0].title_cipher)) === SECRET);

  console.log('and a new password is set in the same breath');
  const NEW = 'the-password-they-set-instead';
  const wrap = await rewrapForPassword(master, NEW);
  const fresh = await rewrapForRecovery(master);
  const done = await back('/api/account/rewrap', {
    kdfSalt: wrap.kdfSalt,
    wrappedByPassword: wrap.wrappedByPassword,
    wrappedByRecovery: fresh.wrappedByRecovery,
    authToken: wrap.authToken,
    recoveryToken: fresh.recoveryToken,
  });
  check('the re-wrapping was accepted', done.status === 200, JSON.stringify(done.data));

  const after = client();
  const signIn = await after('/api/login', await loginBody(email2, NEW));
  check('the new password signs in', signIn.status === 200, `status ${signIn.status}`);
  const opened = await unlockWithPassword(NEW, signIn.data.keys.kdfSalt,
    signIn.data.keys.wrappedByPassword);
  check('and opens the board', opened.length === 32);
  const view = (await after('/api/board')).data;
  const { dataKey: nowKey } = await subKeysFrom(opened);
  check('with what was written still there',
    (await decryptText(nowKey, view.tasks[0].title_cipher)) === SECRET);

  console.log('the key that was typed in is spent');
  const spent = client();
  const again = await spent('/api/account/recover', {
    email: email2, recoveryToken: made.recoveryToken,
  });
  check('the old recovery key no longer opens the door', again.status === 401,
    `status ${again.status}`);
  const withNew = client();
  const stillWorks = await withNew('/api/account/recover', {
    email: email2, recoveryToken: fresh.recoveryToken,
  });
  check('the one handed out in its place does', stillWorks.status === 200,
    `status ${stillWorks.status}`);
}

console.log('an account without a stored proof cannot be recovered this way');
{
  // What every account made before this looks like. It can still be read with
  // the recovery key once signed in; it just cannot be signed into with one.
  const older = `older${stamp}@example.com`;
  const olderKeys = await createKeys(FORGOTTEN);
  const anon = client();
  await anon('/api/register', {
    email: older, password: olderKeys.authToken, kdfSalt: olderKeys.kdfSalt,
    wrappedByPassword: olderKeys.wrappedByPassword,
    wrappedByRecovery: olderKeys.wrappedByRecovery,
    recoveryToken: olderKeys.recoveryToken,
  });
  await pool.query('update users set recovery_hash = null where lower(email) = lower($1)', [older]);
  const tried = client();
  const r = await tried('/api/account/recover', {
    email: older, recoveryToken: olderKeys.recoveryToken,
  });
  check('it is refused, and says nothing about why', r.status === 401, `status ${r.status}`);
}

await pool.end();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
