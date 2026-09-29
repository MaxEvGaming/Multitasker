// Everything readable is encrypted here, in the browser, and the key never
// leaves it. The server holds ciphertext and keyed hashes and can make sense of
// neither.
//
// No DOM in this file: the service worker needs it too, to make sense of a
// notification while no page is open.

const enc = new TextEncoder();
const dec = new TextDecoder();

const PBKDF2_ROUNDS = 600_000;   // ~1s on a phone; the cost is paid once, at sign-in
const VERSION = 'v1';

/* --------------------------------------------------------------- encoding */

export function toB64(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from([...binary].map((c) => c.charCodeAt(0)));
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/* ------------------------------------------------------------------- keys */

// The password is stretched once, and the result split into two keys that
// cannot be turned back into one another:
//
//   wrap — wraps the master key. Never leaves the browser.
//   auth — sent to the server in place of the password.
//
// So the server never receives the password, and what it does receive cannot
// unwrap anything. Before this, the password itself was sent at sign-in: the
// stored keys were safe, but anyone who could change the server could have
// caught the password on its way in and opened everything. "The operator cannot
// read this" was not true while that was so.
//
// HKDF is what makes handing `auth` over safe — it cannot be run backwards, so
// `auth` says nothing about the stretched key it came from, and nothing about
// `wrap`.
async function stretch(password, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
    base, 256);
  return new Uint8Array(bits);
}

async function splitStretched(stretched) {
  const base = await crypto.subtle.importKey('raw', stretched, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const from = (label) => ({
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(label),
  });
  const [wrap, auth] = await Promise.all([
    crypto.subtle.deriveKey(from('taskboard/wrap'), base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    crypto.subtle.deriveBits(from('taskboard/auth'), base, 256),
  ]);
  return { wrap, auth: toB64(new Uint8Array(auth)) };
}

// What the server is told instead of the password. Everything that authenticates
// goes through here, so there is one place to check that the password does not
// leave.
export async function authTokenFor(password, saltB64) {
  return (await splitStretched(await stretch(password, saltB64))).auth;
}

async function wrappingKeyFromPassword(password, saltB64) {
  return (await splitStretched(await stretch(password, saltB64))).wrap;
}

// The recovery key has to prove who is asking, the same way the password does,
// or it can open the board but never get through the front door. Same split as
// the password: one branch unwraps and stays here, the other is handed over and
// opens nothing.
export async function recoveryTokenFor(recoveryB64) {
  const base = await crypto.subtle.importKey('raw', fromB64(recoveryB64), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('taskboard/recovery-auth') },
    base, 256);
  return toB64(new Uint8Array(bits));
}

async function wrappingKeyFromRecovery(recoveryB64) {
  return crypto.subtle.importKey('raw', fromB64(recoveryB64), { name: 'AES-GCM' }, false,
    ['encrypt', 'decrypt']);
}

async function seal(rawBytes, wrappingKey) {
  const iv = randomBytes(12);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawBytes);
  return `${VERSION}.${toB64(iv)}.${toB64(sealed)}`;
}

async function open(blob, wrappingKey) {
  const [version, ivB64, bodyB64] = String(blob || '').split('.');
  if (version !== VERSION) throw new Error('この形式は読めません');
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64) }, wrappingKey, fromB64(bodyB64));
  return new Uint8Array(opened);
}

// Two keys out of one, so the thing used to compare names cannot decrypt them
// and the thing used to decrypt cannot forge a comparison.
export async function subKeysFrom(masterRaw) {
  const master = await crypto.subtle.importKey('raw', masterRaw, 'HKDF', false, ['deriveKey']);
  const dataKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('taskboard/data') },
    master, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const indexKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('taskboard/index') },
    master, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  return { dataKey, indexKey };
}

/* -------------------------------------------------------------- lifecycle */

// Called once, when an account is made. The recovery key is returned so it can
// be shown; it is never stored anywhere the server can see.
export async function createKeys(password) {
  const masterRaw = randomBytes(32);
  const saltB64 = toB64(randomBytes(16));
  const recoveryB64 = toB64(randomBytes(32));

  const { wrap, auth } = await splitStretched(await stretch(password, saltB64));
  return {
    kdfSalt: saltB64,
    recoveryKey: recoveryB64,
    // サーバーへ送るのはこれ。パスワードそのものは外に出ない。
    authToken: auth,
    wrappedByPassword: await seal(masterRaw, wrap),
    wrappedByRecovery: await seal(masterRaw, await wrappingKeyFromRecovery(recoveryB64)),
    recoveryToken: await recoveryTokenFor(recoveryB64),
    masterRaw,
  };
}

export async function unlockWithPassword(password, kdfSalt, wrappedByPassword) {
  return open(wrappedByPassword, await wrappingKeyFromPassword(password, kdfSalt));
}

export async function unlockWithRecovery(recoveryB64, wrappedByRecovery) {
  return open(wrappedByRecovery, await wrappingKeyFromRecovery(recoveryB64));
}

// Changing a password re-wraps the same master key, so nothing that was
// encrypted under it has to be touched.
export async function rewrapForPassword(masterRaw, password) {
  const saltB64 = toB64(randomBytes(16));
  const { wrap, auth } = await splitStretched(await stretch(password, saltB64));
  return {
    kdfSalt: saltB64,
    wrappedByPassword: await seal(masterRaw, wrap),
    // The salt changed, so what the server should be told changed with it.
    authToken: auth,
  };
}

// A fresh recovery key around the same master key. Used after one has been
// spent getting back in: the key that was written down has now been read out
// loud, so it is replaced rather than left standing.
export async function rewrapForRecovery(masterRaw) {
  const recoveryB64 = toB64(randomBytes(32));
  return {
    recoveryKey: recoveryB64,
    wrappedByRecovery: await seal(masterRaw, await wrappingKeyFromRecovery(recoveryB64)),
    recoveryToken: await recoveryTokenFor(recoveryB64),
  };
}

/* ------------------------------------------------------------------- text */

export async function encryptText(dataKey, text) {
  if (text === null || text === undefined || text === '') return '';
  const iv = randomBytes(12);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, enc.encode(String(text)));
  return `${VERSION}.${toB64(iv)}.${toB64(sealed)}`;
}

export async function decryptText(dataKey, blob) {
  if (!blob) return '';
  try {
    const [version, ivB64, bodyB64] = String(blob).split('.');
    if (version !== VERSION) return '';
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(ivB64) }, dataKey, fromB64(bodyB64));
    return dec.decode(opened);
  } catch (_) {
    // A value that will not open is shown as nothing rather than as an error in
    // the middle of the board.
    return '';
  }
}

// What the server compares instead of a name. Same input, same output, every
// time — and no way back to the name without the key.
export async function blindIndex(indexKey, name) {
  const normalised = String(name || '')
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .toLowerCase();
  if (!normalised) return '';
  const mac = await crypto.subtle.sign('HMAC', indexKey, enc.encode(normalised));
  return toB64(mac);
}

/* ------------------------------------------------- keeping it for the worker */

const DB_NAME = 'taskboard';
const STORE = 'keys';

function withStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(out.result !== undefined ? out.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

// Kept where the service worker can reach it: a notification arrives when no
// page is open, and it has to be made readable before it is shown.
export const rememberMaster = (masterRaw) => withStore('readwrite', (s) => s.put(masterRaw, 'master'));
export const forgetMaster = () => withStore('readwrite', (s) => s.delete('master'));
export const recallMaster = () => withStore('readonly', (s) => s.get('master'));
