// What a browser does before it says anything to the server, in one place.
//
// Every test goes through here, and that is the point: a test that posts a
// password is exercising a door that no longer exists, and would keep passing
// long after the real screen stopped working. Registering makes keys; signing in
// fetches the salt and derives a proof from it. Neither sends the password.
import { createKeys, authTokenFor, rewrapForPassword, toB64, randomBytes } from '../public/crypto.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';

// Registering and asking for a salt are counted per address (src/security.js,
// T-070: five registrations and sixty salts an hour). Every test talks to the
// server from this one machine, and a whole run makes dozens of accounts, so
// each run presents itself as its own address, and each registration as yet
// another one — the way separate people would arrive. A test that sets
// X-Forwarded-For itself (the throttling checks) keeps what it set. The
// server only ever sees this header through Caddy, so it is only a test that
// can write it. Done here because every test that registers imports this file,
// and for any local server, since a few tests start one of their own.
const randomIp = () => '10.' + [0, 0, 0].map(() => Math.floor(Math.random() * 256)).join('.');
const RUN_IP = randomIp();
const plainFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return plainFetch(input, init);
  const headers = new Headers(init.headers || {});
  if (!headers.has('X-Forwarded-For')) {
    headers.set('X-Forwarded-For', url.pathname === '/api/register' ? randomIp() : RUN_IP);
  }
  return plainFetch(input, { ...init, headers });
};

// Not authenticated and not secret: the salt is a random number that opens
// nothing on its own. Fetched with a plain fetch so this helper does not care
// how any given test carries its cookie.
async function saltFor(email) {
  const res = await fetch(`${BASE}/api/prelogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return (await res.json()).kdfSalt;
}

// For tests that need the master key afterwards — changing a password re-wraps
// it, so they have to hold it the way a signed-in browser does.
export async function newAccount(email, password, extra = {}) {
  const keys = await createKeys(password);
  return { keys, body: registerBodyFrom(keys, email, extra) };
}

function registerBodyFrom(keys, email, extra) {
  return {
    email,
    password: keys.authToken,
    kdfSalt: keys.kdfSalt,
    wrappedByPassword: keys.wrappedByPassword,
    wrappedByRecovery: keys.wrappedByRecovery,
    recoveryToken: keys.recoveryToken,
    ...extra,
  };
}

export async function registerBody(email, password, extra = {}) {
  return (await newAccount(email, password, extra)).body;
}

export async function loginBody(email, password, extra = {}) {
  return { email, password: await authTokenFor(password, await saltFor(email)), ...extra };
}

// For the places that prove a password rather than sign in with it: deleting an
// account, changing an address, changing the password itself.
export async function proofOf(email, password) {
  return authTokenFor(password, await saltFor(email));
}

// Changing a password: the old one goes as a proof made under the old salt, the
// new one as the proof the server should expect from here on. The master key is
// re-wrapped around the new password and never leaves.
export async function passwordChangeBody(email, current, next, masterRaw) {
  const rewrapped = await rewrapForPassword(masterRaw, next);
  return {
    current: await proofOf(email, current),
    next: rewrapped.authToken,
    kdfSalt: rewrapped.kdfSalt,
    wrappedByPassword: rewrapped.wrappedByPassword,
  };
}

// Resetting: there is no master key to re-wrap, because whoever is resetting
// could not sign in. A fresh salt and a proof under it — enough to get back in,
// not enough to read anything, which is what the recovery key is for.
export async function resetBody(token, password) {
  const kdfSalt = toB64(randomBytes(16));
  return { token, password: await authTokenFor(password, kdfSalt), kdfSalt };
}
