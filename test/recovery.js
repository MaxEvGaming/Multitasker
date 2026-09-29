// Getting back in after a password reset.
//
// This is the path that did not exist: the board asked people to save a
// recovery key, told them it was the only thing standing between a forgotten
// password and losing everything, and then had nowhere to type it. The reset
// made it worse — it let someone sign in while leaving the contents locked with
// the password they had just replaced.
//
// The dialogs are in the browser, but everything they do is here.
import { createResetToken } from '../src/account.js';
import { pool } from '../src/db.js';
import {
  createKeys, unlockWithPassword, unlockWithRecovery, rewrapForPassword,
  rewrapForRecovery, subKeysFrom, encryptText, decryptText,
} from '../public/crypto.js';
import { loginBody, resetBody } from './browser.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';

let cookie = '';
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

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

const FIRST = 'the-password-they-forgot';
const SECOND = 'the-password-they-set-instead';
const email = `recover${Date.now()}@example.com`;
const SECRET = 'the thing they would have lost';

console.log('an encrypted account with something in it');
const keys = await createKeys(FIRST);
{
  const r = await call('/api/register', {
    email, password: keys.authToken,
    kdfSalt: keys.kdfSalt,
    wrappedByPassword: keys.wrappedByPassword,
    wrappedByRecovery: keys.wrappedByRecovery,
    recoveryToken: keys.recoveryToken,
  });
  check('the account was made', r.status === 200, JSON.stringify(r.data));

  const { dataKey } = await subKeysFrom(keys.masterRaw);
  const board = (await call('/api/board')).data;
  await call('/api/task', {
    taskId: board.tasks[0].id, page: board.page,
    title: '', matchKey: '',
    titleCipher: await encryptText(dataKey, SECRET),
  });
  check('and something written on it', true);
}

console.log('the password is forgotten and an operator issues a link');
const token = await createResetToken(email);
check('a token was minted', typeof token === 'string' && token.length > 20);

console.log('the link sets a new password and nothing else');
{
  cookie = '';
  const r = await call('/api/account/reset', await resetBody(token, SECOND));
  check('the reset was accepted', r.status === 200, JSON.stringify(r.data));

  const again = await call('/api/account/reset', await resetBody(token, 'a-third-password'));
  check('and the link cannot be spent twice', again.status === 400, `status ${again.status}`);
}

console.log('signing in works, but the board does not open — this is the trap');
let keysNow;
{
  const r = await call('/api/login', await loginBody(email, SECOND));
  check('signed in with the new password', r.status === 200, JSON.stringify(r.data));
  keysNow = r.data.keys;

  let refused = false;
  try { await unlockWithPassword(SECOND, keysNow.kdfSalt, keysNow.wrappedByPassword); }
  catch (_) { refused = true; }
  check('the new password does not open it', refused);
}

console.log('the recovery key opens it, and re-locks it with the password in use');
let freshRecovery;
{
  const master = await unlockWithRecovery(keys.recoveryKey, keysNow.wrappedByRecovery);
  check('the saved key opens the master key', master.length === 32);

  const { dataKey } = await subKeysFrom(master);
  const board = (await call('/api/board')).data;
  check('and what was written is readable again',
    (await decryptText(dataKey, board.tasks[0].title_cipher)) === SECRET);

  const wrap = await rewrapForPassword(master, SECOND);
  freshRecovery = await rewrapForRecovery(master);
  const r = await call('/api/account/rewrap', {
    kdfSalt: wrap.kdfSalt,
    wrappedByPassword: wrap.wrappedByPassword,
    wrappedByRecovery: freshRecovery.wrappedByRecovery,
    authToken: wrap.authToken,
  });
  check('the re-wrapping was accepted', r.status === 200, JSON.stringify(r.data));
}

console.log('and from then on the ordinary password is enough');
{
  cookie = '';
  const r = await call('/api/login', await loginBody(email, SECOND));
  check('the password still signs in after the re-wrapping', r.status === 200, JSON.stringify(r.data));
  const after = r.data.keys;
  const master = await unlockWithPassword(SECOND, after.kdfSalt, after.wrappedByPassword);
  check('the password that was set now opens it', master.length === 32);

  const { dataKey } = await subKeysFrom(master);
  const board = (await call('/api/board')).data;
  check('with everything still on the board',
    (await decryptText(dataKey, board.tasks[0].title_cipher)) === SECRET);

  // The old recovery key was typed into a screen to get here, so it is retired
  // rather than left standing.
  let refused = false;
  try { await unlockWithRecovery(keys.recoveryKey, after.wrappedByRecovery); }
  catch (_) { refused = true; }
  check('the recovery key that was used no longer works', refused);

  const stillGood = await unlockWithRecovery(freshRecovery.recoveryKey, after.wrappedByRecovery);
  check('and the one issued in its place does', stillGood.length === 32);
}

console.log('the re-wrapping is not a way in for anyone else');
{
  cookie = '';
  const r = await call('/api/account/rewrap', {
    kdfSalt: 'x', wrappedByPassword: 'y',
  });
  check('a stranger is turned away', r.status === 401, `status ${r.status}`);
}

await pool.end();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
