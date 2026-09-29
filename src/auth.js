import crypto from 'node:crypto';
import { q, one } from './db.js';

const SESSION_COOKIE = 'tb_session';
const SESSION_DAYS = 30;

// scrypt rather than bcrypt/argon2 on purpose: it ships with Node, so the
// container needs no build toolchain and no native module can break an upgrade.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, SCRYPT, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return ['scrypt', salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'));
  // Lengths must match before timingSafeEqual, which throws otherwise.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export async function createLoginSession(userId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await q(
    'insert into login_sessions(token, user_id, expires_at) values ($1, $2, $3)',
    [token, userId, expires]
  );
  return { token, expires };
}

export async function destroyLoginSession(token) {
  if (token) await q('delete from login_sessions where token = $1', [token]);
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function sessionTokenFrom(req) {
  return readCookie(req.headers.cookie, SESSION_COOKIE);
}

export function sessionCookie(token, expires) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
  ];
  // Behind Caddy the site is always HTTPS; locally it is not, and a Secure
  // cookie would simply never be stored.
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function currentUser(req) {
  const token = sessionTokenFrom(req);
  if (!token) return null;
  const row = await one(
    `select u.id, u.email, u.lang
       from login_sessions s
       join users u on u.id = s.user_id
      where s.token = $1 and s.expires_at > now()`,
    [token]
  );
  return row;
}

export async function purgeExpiredSessions() {
  await q('delete from login_sessions where expires_at <= now()');
}

// The mark that says "this browser has signed in to this account before".
// Not a session and not a secret that opens anything: it only decides whether
// a sign-in counts as coming from a new device (T-073). A year, and left in
// place by signing out — taking it away would make every sign-in a new one.
const KNOWN_DEVICE_COOKIE = 'known_device';

export function knownDeviceFrom(req) {
  return readCookie(req.headers.cookie, KNOWN_DEVICE_COOKIE);
}

export function knownDeviceCookie(secret) {
  const parts = [
    `${KNOWN_DEVICE_COOKIE}=${secret}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${365 * 24 * 3600}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}
