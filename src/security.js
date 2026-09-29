import { q, one } from './db.js';

// Behind Caddy the socket always reports the proxy, so the caller's address has
// to come from the header the proxy sets. The site is only ever reached through
// that proxy, so the first entry is the one Caddy wrote and a client-supplied
// list cannot displace it.
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const LOGIN = {
  windowMinutes: 15,
  perEmail: 8,   // one person fumbling their own password
  perIp: 30,     // one address working through a list of addresses
};

export async function recordLoginAttempt(email, ip, ok) {
  await q('insert into login_attempts(email, ip, ok) values ($1, $2, $3)',
    [String(email || '').slice(0, 320), ip, ok]);
}

// Counts only failures: a correct password clears the way for the next attempt,
// so someone who mistypes twice and then succeeds is never held up.
export async function loginLocked(email, ip) {
  const row = await one(
    `select
       (select count(*) from login_attempts
         where lower(email) = lower($1) and not ok
           and at > now() - make_interval(mins => $3)) as by_email,
       (select count(*) from login_attempts
         where ip = $2 and not ok
           and at > now() - make_interval(mins => $3)) as by_ip`,
    [String(email || ''), ip, LOGIN.windowMinutes]
  );
  const byEmail = Number(row.by_email);
  const byIp = Number(row.by_ip);
  if (byEmail >= LOGIN.perEmail || byIp >= LOGIN.perIp) {
    return { locked: true, minutes: LOGIN.windowMinutes };
  }
  return { locked: false };
}

const HOOK = { windowMinutes: 60, max: 120 };

// The board is fed by one hook per session and a handful of sessions, so a
// couple of deliveries a minute is generous. The ceiling exists for the case
// where an address leaks, not to shape normal use.
export async function hookAllowed(token) {
  await q('insert into hook_hits(token) values ($1)', [token]);
  const row = await one(
    `select count(*) as hits from hook_hits
      where token = $1 and at > now() - make_interval(mins => $2)`,
    [token, HOOK.windowMinutes]
  );
  return Number(row.hits) <= HOOK.max;
}

// The PC's inlet, the other way round: it reads instructions out rather than
// writing reports in, but it is reachable by anyone holding the address in
// just the same way. Higher than the hook's ceiling because every press costs
// two calls (a receipt and a result) and a stream reconnect costs another —
// a busy hour of pressing buttons is still well inside it.
const AGENT = { windowMinutes: 60, max: 600 };

export async function agentAllowed(token) {
  await q('insert into hook_hits(token) values ($1)', [token]);
  const row = await one(
    `select count(*) as hits from hook_hits
      where token = $1 and at > now() - make_interval(mins => $2)`,
    [token, AGENT.windowMinutes]
  );
  return Number(row.hits) <= AGENT.max;
}

// The two calls anyone can make before they have an account, counted per
// address the way the hook is counted per token (T-070, Owner 2026-09-14
// 『T70：A』: per-IP counts only, nothing external). Five registrations an
// hour is more than a person makes and less than a script does; sixty salt
// requests an hour leaves room for a whole household's sign-ins while a list
// of addresses being walked from one machine runs into the ceiling.
const PER_IP = {
  register: { windowMinutes: 60, max: 5 },
  prelogin: { windowMinutes: 60, max: 60 },
};

export async function ipAllowed(what, ip) {
  const rule = PER_IP[what];
  await q('insert into ip_hits(what, ip) values ($1, $2)', [what, ip]);
  const row = await one(
    `select count(*) as hits from ip_hits
      where what = $1 and ip = $2 and at > now() - make_interval(mins => $3)`,
    [what, ip, rule.windowMinutes]
  );
  return Number(row.hits) <= rule.max ? { allowed: true } : { allowed: false, minutes: rule.windowMinutes };
}

// Rows are only ever read inside their window; anything older is dead weight.
export async function purgeOldRecords() {
  await q("delete from login_attempts where at < now() - interval '1 day'");
  await q("delete from hook_hits where at < now() - interval '1 day'");
  await q("delete from ip_hits where at < now() - interval '1 day'");
  await q('delete from password_resets where expires_at < now() - interval \'7 days\'');
}
