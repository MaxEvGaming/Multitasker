import { q, one } from './db.js';
import { hashPassword, verifyPassword, newToken } from './auth.js';
import { say } from './say.js';
import { asEmail } from './http.js';

// These run on paths where the account is already known, so the wording can
// follow it; a reset link is the one exception and falls back to English.
const langOf = async (userId) => {
  const row = await one('select lang from users where id = $1', [userId]);
  return (row && row.lang) || 'en';
};

// How long a password has to be is decided in the browser (PASSWORD_MIN in
// public/app.js) and cannot be decided here: the server is handed a proof
// derived from the password, and a short password and a long one arrive
// looking exactly alike.
//
// What can still be checked: that what arrived is a proof at all. A real
// password reaching this file would mean the browser stopped deriving — a
// regression that would quietly hand the operator every password typed into
// the site. Refusing is loud; storing it is not.
export const looksLikeProof = (value) => /^[A-Za-z0-9_-]{40,}$/.test(String(value || ''));

// Minted by an operator, not by a form. There is no mail server behind this
// site, and a reset link that anyone can request for any address is a way to
// spray links at strangers; handing one over out of band is honest about what
// is actually possible here.
export async function createResetToken(email, hours = 24) {
  const user = await one('select id from users where lower(email) = lower($1)', [asEmail(email)]);
  if (!user) return null;

  const token = newToken(24);
  await q(
    `insert into password_resets(token, user_id, expires_at)
     values ($1, $2, now() + make_interval(hours => $3))`,
    [token, user.id, hours]
  );
  return token;
}

export async function useResetToken(token, password) {
  if (!looksLikeProof(password)) return { ok: false, error: say('en', 'need.derived') };
  const row = await one(
    `select token, user_id from password_resets
      where token = $1 and used_at is null and expires_at > now()`,
    [String(token || '')]
  );
  if (!row) return { ok: false, error: say('en', 'reset.unusable') };

  const hash = await hashPassword(String(password));
  await q('update users set password_hash = $2 where id = $1', [row.user_id, hash]);
  await q('update password_resets set used_at = now() where token = $1', [row.token]);
  // Anything already signed in as this account is no longer trusted: the point
  // of a reset is usually that someone else got in.
  await q('delete from login_sessions where user_id = $1', [row.user_id]);
  return { ok: true, userId: row.user_id };
}

export async function changePassword(userId, current, next) {
  if (!looksLikeProof(next)) {
    return { ok: false, error: say(await langOf(userId), 'need.derived') };
  }
  const user = await one('select password_hash from users where id = $1', [userId]);
  if (!user || !(await verifyPassword(String(current || ''), user.password_hash))) {
    return { ok: false, error: say(await langOf(userId), 'password.wrongCurrent') };
  }
  const hash = await hashPassword(String(next));
  await q('update users set password_hash = $2 where id = $1', [userId, hash]);
  return { ok: true };
}

// Changing the address the account is known by. The password is asked for
// because an address is how someone would be found again, and because a session
// left open on a borrowed machine should not be able to quietly take the
// account somewhere else.
export async function changeEmail(userId, password, email) {
  const wanted = asEmail(email);
  if (!wanted || !wanted.includes('@')) {
    return { ok: false, error: say(await langOf(userId), 'email.notAnAddress') };
  }
  const user = await one('select password_hash from users where id = $1', [userId]);
  if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
    return { ok: false, error: say(await langOf(userId), 'password.wrong') };
  }
  const taken = await one(
    'select 1 from users where lower(email) = lower($1) and id <> $2', [wanted, userId]);
  if (taken) return { ok: false, error: say(await langOf(userId), 'register.taken') };

  await q('update users set email = $2 where id = $1', [userId, wanted]);
  return { ok: true, email: wanted };
}

// Everything hangs off users(id) with `on delete cascade`, so the account, its
// squares, its states, its devices and its inlet all go together. The password
// is asked for because this cannot be undone.
export async function deleteAccount(userId, password) {
  const user = await one('select password_hash from users where id = $1', [userId]);
  if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
    return { ok: false, error: say(await langOf(userId), 'password.wrong') };
  }
  await q('delete from users where id = $1', [userId]);
  return { ok: true };
}
