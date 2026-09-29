// The board tells people that whoever runs the server cannot read their squares.
// That was not true for a while: the squares were sealed, but the password
// itself was sent to sign in, and a password opens everything. Anyone able to
// watch the server — or to change it — could have caught one on its way in.
//
// This is the check that the claim is true now. It works two ways: by taking
// what the browser sends and trying to open the account with it, and by
// watching every request the browser makes and looking for the password in it.
import { createKeys, authTokenFor, unlockWithPassword, rewrapForPassword } from '../public/crypto.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const PASSWORD = 'correct-horse-battery-staple';

console.log('what is sent instead of the password');
const keys = await createKeys(PASSWORD);
{
  check('it is not the password', keys.authToken !== PASSWORD);
  check('nor does it contain it', !keys.authToken.includes(PASSWORD));

  // The same password and the same salt always give the same proof, or nobody
  // could ever sign in twice.
  check('the same password gives the same proof',
    (await authTokenFor(PASSWORD, keys.kdfSalt)) === keys.authToken);
  check('a different password gives a different one',
    (await authTokenFor(PASSWORD + 'x', keys.kdfSalt)) !== keys.authToken);
  // The salt is half of it, so the same password on another account proves
  // nothing there.
  const elsewhere = await createKeys(PASSWORD);
  check('the same password on another account gives a different one',
    (await authTokenFor(PASSWORD, elsewhere.kdfSalt)) !== keys.authToken);
}

console.log('and it cannot be used to read anything');
{
  // The whole point. The server is handed the proof and stores it. If the proof
  // could unwrap the master key, storing it would be the same as storing the
  // password, and nothing would have been fixed.
  let opened = null;
  try { opened = await unlockWithPassword(keys.authToken, keys.kdfSalt, keys.wrappedByPassword); }
  catch (_) { /* expected */ }
  check('the proof does not open the wrapped key', opened === null);

  // And the password still does, or the account would be unusable.
  const master = await unlockWithPassword(PASSWORD, keys.kdfSalt, keys.wrappedByPassword);
  check('the password still does', master.length === 32);
  check('and gives back the key it was made with',
    Buffer.compare(Buffer.from(master), Buffer.from(keys.masterRaw)) === 0);
}

console.log('changing the password moves both halves together');
{
  // A new salt means a new proof. Storing one without the other locks the
  // account out for good — the browser derives under the new salt while the
  // server holds a proof made under the old one.
  const again = await rewrapForPassword(keys.masterRaw, 'a-different-password');
  check('a new salt comes with a new proof',
    Boolean(again.kdfSalt && again.authToken) && again.kdfSalt !== keys.kdfSalt);
  check('and the proof matches the new salt',
    (await authTokenFor('a-different-password', again.kdfSalt)) === again.authToken);
  check('the master key is unchanged underneath',
    Buffer.compare(
      Buffer.from(await unlockWithPassword('a-different-password', again.kdfSalt, again.wrappedByPassword)),
      Buffer.from(keys.masterRaw)) === 0);
}

// Everything above is arithmetic. This part is the one that would catch a
// mistake: it stands where the server stands and reads what actually arrives.
console.log('nothing that goes over the wire contains the password');
{
  const BASE = process.env.BASE || 'http://127.0.0.1:3040';
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (options.body) sent.push(String(options.body));
    return real(url, options);
  };

  const { registerBody, loginBody, proofOf, passwordChangeBody } = await import('./browser.js');
  const email = `sealed${Date.now()}@example.com`;
  let cookie = '';
  const call = async (path, body) => {
    const res = await real(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    sent.push(JSON.stringify(body));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const made = await createKeys(PASSWORD);
  let r = await call('/api/register', await registerBody(email, PASSWORD));
  check('an account can be made', r.status === 200, JSON.stringify(r.data));

  cookie = '';
  r = await call('/api/login', await loginBody(email, PASSWORD));
  check('and signed into', r.status === 200, JSON.stringify(r.data));

  r = await call('/api/account/password',
    await passwordChangeBody(email, PASSWORD, 'a-second-password-here', made.masterRaw));
  check('the password can be changed', r.status === 200, JSON.stringify(r.data));

  r = await call('/api/account/delete', { password: await proofOf(email, 'a-second-password-here') });
  check('and the account deleted', r.status === 200, JSON.stringify(r.data));

  globalThis.fetch = real;

  check('something was actually watched', sent.length >= 6, `${sent.length} requests`);
  const leaked = sent.filter((body) =>
    body.includes(PASSWORD) || body.includes('a-second-password-here'));
  check('no request carried a password', leaked.length === 0, leaked.join(' / ').slice(0, 200));
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
