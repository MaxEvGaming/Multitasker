import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { q, one, pool, tx } from './db.js';
import { migrate } from './migrate.js';
import {
  hashPassword, verifyPassword, createLoginSession, destroyLoginSession,
  sessionCookie, clearedSessionCookie, currentUser, sessionTokenFrom, purgeExpiredSessions,
  newToken, knownDeviceFrom, knownDeviceCookie,
} from './auth.js';
import {
  ensureDefaults, board, tap, signal, sweepTimeouts, normaliseName,
  addPage, renamePage, deletePage, addSlot, deleteSlot, moveSlot, reorderSlot,
} from './board.js';
import { vapidPublicKey, pushConfigured, notify } from './push.js';
import { send, json, readBody, serveStatic, parseReport, guards, asEmail } from './http.js';
import { clientIp, recordLoginAttempt, loginLocked, hookAllowed, agentAllowed, ipAllowed, purgeOldRecords } from './security.js';
import { say, langFromHeader, isLanguage } from './say.js';
import {
  useResetToken, changePassword, changeEmail, deleteAccount, looksLikeProof,
} from './account.js';
import {
  listen, dropListeners, frame, guardFrame, agentByToken, touchAgent, nameAgent,
  reserveJob, submitJob, pendingJobsFor, ackJob, finishJob, sweepJobs,
  setGuard, guardArmed, suspendAll, resumeAgent,
} from './deck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');

// Which build this is. Read once, from the file the browser is actually given,
// so it cannot drift from what is being served.
//
// It exists because "is my fix on the server yet?" kept being answered by
// guessing. A deploy that did not happen and a fix that did not work look
// exactly alike from the outside, and the wrong answer sends everyone off
// investigating the wrong thing.
const BUILD = (() => {
  try {
    return crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(PUBLIC_DIR, 'app.js')))
      .digest('hex').slice(0, 8);
  } catch (_) { return 'unknown'; }
})();
const PORT = Number(process.env.PORT || 3040);

async function requireUser(req, res) {
  const user = await currentUser(req);
  if (!user) { json(res, 401, { error: say(langFromHeader(req.headers['accept-language']), 'need.signin') }); return null; }
  return user;
}

// Anyone can take the first account — that is how the owner bootstraps a fresh
// deployment. After that the door is shut unless it is deliberately opened,
// because this is a public host and the board holds the owner's work.
async function registrationAllowed() {
  if (process.env.REGISTRATION_OPEN === 'true') return true;
  const rows = await q('select 1 from users limit 1');
  return rows.length === 0;
}

// A code is the ordinary way in once the first account exists. Claimed inside
// the same transaction that makes the account, so two people racing the same
// code cannot both get through — the second finds it already spent.
async function claimInvite(client, code) {
  const { rows } = await client.query(
    `update invites set used_at = now()
      where code = $1 and used_at is null
        and (expires_at is null or expires_at > now())
      returning code`,
    [String(code || '')]
  );
  return rows.length > 0;
}

// Whether the browser signing in has signed in to this account before, and
// the cookie that will say so next time (T-073, T-074 = a new device is one
// without the mark). The mark is one random value per account, made the first
// time it is needed; the cookie carries it and nothing else.
async function deviceMark(req, userId) {
  let { device_secret: secret } = await one('select device_secret from users where id = $1', [userId]);
  if (!secret) {
    secret = newToken(24);
    await q('update users set device_secret = $2 where id = $1 and device_secret is null', [userId, secret]);
    ({ device_secret: secret } = await one('select device_secret from users where id = $1', [userId]));
  }
  return { known: knownDeviceFrom(req) === secret, cookie: knownDeviceCookie(secret) };
}

// A sign-in that has just succeeded: if the browser is one the account has not
// seen and some PC asked to be cut off in that case, every PC of the account
// is cut off now. Either way the browser is marked as seen from here on.
async function afterSignIn(req, userId) {
  const device = await deviceMark(req, userId);
  if (!device.known && (await guardArmed(userId))) await suspendAll(userId, 'newDevice');
  return device.cookie;
}

// Where the nightly copies land on the host. Mounted into the container so
// this can hand one over; read-only, because nothing here should be able to
// change what a backup says.
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';

const routes = {
  'POST /api/register': async (req, res) => {
    const body = await readBody(req);
    const email = asEmail(body.email);
    const { password } = body;
    const lang = langFromHeader(req.headers['accept-language']);
    // Counted before anything is looked at, so a refused call costs the same
    // as an accepted one and the count cannot be worked around.
    const door = await ipAllowed('register', clientIp(req));
    if (!door.allowed) return json(res, 429, { error: say(lang, 'ip.tooMany', { n: door.minutes }) });
    if (!email || !password) return json(res, 400, { error: say(lang, 'need.emailPassword') });
    // Not a length check — there is nothing here to measure. `password` is a
    // proof derived in the browser, and how long the password behind it was is
    // exactly what the server is not allowed to know. This only catches a
    // browser that sent the password itself.
    if (!looksLikeProof(password)) return json(res, 400, { error: say(lang, 'need.derived') });
    // Three ways the door opens: it is standing open, nobody has come through
    // yet, or a code was handed over.
    const open = await registrationAllowed();
    const code = String(body.invite || '').trim();
    if (!open && !code) return json(res, 403, { error: say(lang, 'register.closed') });

    const taken = await one('select 1 from users where lower(email) = lower($1)', [email]);
    if (taken) return json(res, 409, { error: say(lang, 'register.taken') });

    const hash = await hashPassword(String(password));
    // The wrapped keys arrive already sealed; the server stores them without
    // ever seeing what they wrap.
    const { kdfSalt, wrappedByPassword, wrappedByRecovery, recoveryToken } = body;
    // 鍵の無いアカウントは作らせない。ここを通してしまうと、ボードは読める状態で
    // 立ち上がり、しかもどこにもそうとは書かれない。作れないようにするのが
    // 唯一の確実な方法で、画面側は必ず鍵を作ってから登録を送っている。
    if (!kdfSalt || !wrappedByPassword || !wrappedByRecovery || !looksLikeProof(recoveryToken)) {
      return json(res, 400, { error: say(lang, 'keys.missing') });
    }
    const encrypted = true;

    let user;
    try {
      user = await tx(async (client) => {
        if (!open && !(await claimInvite(client, code))) {
          const refusal = new Error(say(lang, 'register.badInvite'));
          refusal.shown = true;
          throw refusal;
        }
        const { rows } = await client.query(
          `insert into users(email, password_hash, kdf_salt, wrapped_by_password,
                             wrapped_by_recovery, recovery_hash, encryption_version)
           values ($1, $2, $3, $4, $5, $6, $7) returning id, email`,
          [email, hash, kdfSalt, wrappedByPassword, wrappedByRecovery,
            await hashPassword(String(recoveryToken)), encrypted ? 1 : 0]
        );
        await client.query('update invites set used_by = $2 where code = $1', [code, rows[0].id]);
        return rows[0];
      });
    } catch (err) {
      if (err.shown) return json(res, 403, { error: err.message });
      throw err;
    }
    await ensureDefaults(user.id);
    const { token, expires } = await createLoginSession(user.id);
    const device = await deviceMark(req, user.id);
    json(res, 200, { email: user.email }, { 'Set-Cookie': [sessionCookie(token, expires), device.cookie] });
  },

  // ログインの前に、そのアカウントのソルトだけを渡す。ソルトは秘密ではない（乱数であって、
  // それ自体では何も開けない）が、これが無いとブラウザはトークンを作れない。
  //
  // 知らないメールにもソルトを返す。返さないと「そのアカウントが在るか」を外から数え上げ
  // られる。返すソルトはサーバーの秘密から決定的に作るので、同じメールには毎回同じ
  // 値が返り、在るアカウントと見分けがつかない。
  'POST /api/prelogin': async (req, res) => {
    const email = asEmail((await readBody(req)).email);
    const door = await ipAllowed('prelogin', clientIp(req));
    if (!door.allowed) {
      return json(res, 429,
        { error: say(langFromHeader(req.headers['accept-language']), 'ip.tooMany', { n: door.minutes }) });
    }
    const found = await one('select kdf_salt from users where lower(email) = lower($1)', [email]);
    if (found && found.kdf_salt) return json(res, 200, { kdfSalt: found.kdf_salt });

    const pepper = process.env.BACKUP_TOKEN || process.env.VAPID_PRIVATE_KEY || 'taskboard';
    const fake = crypto.createHmac('sha256', pepper)
      .update('prelogin:' + String(email || '').toLowerCase()).digest('base64url').slice(0, 22);
    json(res, 200, { kdfSalt: fake });
  },

  'POST /api/login': async (req, res) => {
    const body = await readBody(req);
    const email = asEmail(body.email);
    const { password } = body;
    const ip = clientIp(req);

    // Checked before the password is even looked at, so a locked-out caller
    // learns nothing from how long the answer takes.
    const lock = await loginLocked(email, ip);
    if (lock.locked) {
      return json(res, 429,
        { error: say(langFromHeader(req.headers['accept-language']), 'login.tooMany', { n: lock.minutes }) });
    }

    const user = await one(
      `select id, email, password_hash, kdf_salt, wrapped_by_password,
              wrapped_by_recovery, encryption_version
         from users where lower(email) = lower($1)`,
      [email]
    );
    const ok = user && (await verifyPassword(String(password || ''), user.password_hash));
    await recordLoginAttempt(email, ip, Boolean(ok));
    // Same message either way: which half was wrong is not the caller's business.
    if (!ok) return json(res, 401, { error: say(langFromHeader(req.headers['accept-language']), 'login.wrong') });

    await ensureDefaults(user.id);
    const { token, expires } = await createLoginSession(user.id);
    const mark = await afterSignIn(req, user.id);
    json(res, 200, {
      email: user.email,
      keys: {
        kdfSalt: user.kdf_salt,
        wrappedByPassword: user.wrapped_by_password,
        wrappedByRecovery: user.wrapped_by_recovery,
        encryptionVersion: user.encryption_version,
      },
    }, { 'Set-Cookie': [sessionCookie(token, expires), mark] });
  },

  // The way back in for someone who has lost their password and kept the key
  // they were told to save. Rate-limited exactly like signing in — a second
  // door, not a weaker one — and the same answer either way, so a wrong key
  // cannot be told apart from an address nobody has.
  //
  // What comes back is the wrapped key and nothing else. Opening it is the
  // browser's job and needs the recovery key itself, which never arrives here.
  'POST /api/account/recover': async (req, res) => {
    const body = await readBody(req);
    const email = asEmail(body.email);
    const ip = clientIp(req);
    const lang = langFromHeader(req.headers['accept-language']);

    const lock = await loginLocked(email, ip);
    if (lock.locked) return json(res, 429, { error: say(lang, 'login.tooMany', { n: lock.minutes }) });

    const user = await one(
      `select id, email, recovery_hash, kdf_salt, wrapped_by_password,
              wrapped_by_recovery, encryption_version
         from users where lower(email) = lower($1)`,
      [email]
    );
    const ok = user && user.recovery_hash
      && (await verifyPassword(String(body.recoveryToken || ''), user.recovery_hash));
    await recordLoginAttempt(email, ip, Boolean(ok));
    if (!ok) return json(res, 401, { error: say(lang, 'recover.wrongKey') });

    await ensureDefaults(user.id);
    const { token, expires } = await createLoginSession(user.id);
    const mark = await afterSignIn(req, user.id);
    json(res, 200, {
      email: user.email,
      keys: {
        kdfSalt: user.kdf_salt,
        wrappedByPassword: user.wrapped_by_password,
        wrappedByRecovery: user.wrapped_by_recovery,
        encryptionVersion: user.encryption_version,
      },
    }, { 'Set-Cookie': [sessionCookie(token, expires), mark] });
  },

  'POST /api/logout': async (req, res) => {
    await destroyLoginSession(sessionTokenFrom(req));
    json(res, 200, { ok: true }, { 'Set-Cookie': clearedSessionCookie() });
  },

  // Handing the nightly copy to whoever runs this, over the same connection
  // everything else uses. The alternative was ssh, which means a private key on
  // every machine that wants a copy — a key that opens a shell on the server,
  // to fetch a file. This hands over the file and nothing else.
  //
  // Not a user-facing route: the file holds every account's data. It is off
  // unless BACKUP_TOKEN is set, and without the right token it answers exactly
  // as it would if it did not exist.
  'GET /api/backup': async (req, res) => {
    const expected = process.env.BACKUP_TOKEN || '';
    const offered = String(req.headers['x-backup-token'] || '');
    const ok = expected.length >= 24
      && offered.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(offered), Buffer.from(expected));
    if (!ok) return send(res, 404, 'not found');

    const url = new URL(req.url, 'http://localhost');
    const prefix = url.searchParams.get('what') === 'env' ? 'env-' : 'taskboard-';
    let newest;
    try {
      newest = fs.readdirSync(BACKUP_DIR)
        .filter((name) => name.startsWith(prefix))
        .sort()
        .pop();
    } catch (_) { newest = null; }
    if (!newest) return send(res, 503, 'no backup yet');

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${newest}"`,
      'Cache-Control': 'no-store',
      // So the puller can tell whether it already has this one without
      // downloading it first.
      'X-Backup-Name': newest,
    });
    fs.createReadStream(path.join(BACKUP_DIR, newest)).pipe(res);
  },

  // For something outside to ask whether this is alive. No cookie, and nothing
  // in the answer that is not already obvious from the site responding at all:
  // the point is that it touches the database, so a board that is up but cut
  // off from its data still reports as broken.
  'GET /api/health': async (req, res) => {
    try {
      await one('select 1 as ok');
      json(res, 200, { ok: true });
    } catch (_) {
      json(res, 503, { ok: false });
    }
  },

  'GET /api/me': async (req, res) => {
    const user = await currentUser(req);
    // How many devices would be rung. "Sent to 1 device" is no help when it does
    // not say which, and a notification that goes to a browser on a desk looks
    // exactly like one that never arrived on the phone in your hand.
    const devices = user
      ? Number((await one('select count(*)::int as n from push_subscriptions where user_id = $1',
          [user.id])).n)
      : 0;
    const keys = user ? await one(
      `select kdf_salt, wrapped_by_password, wrapped_by_recovery, encryption_version
         from users where id = $1`, [user.id]) : null;
    json(res, 200, {
      user: user || null,
      lang: user ? user.lang : langFromHeader(req.headers['accept-language']),
      // Whether the sign-up side of the front door should ask for a code.
      needsInvite: !(await registrationAllowed()),
      pushConfigured,
      devices,
      build: BUILD,
      vapidPublicKey: vapidPublicKey(),
      keys: keys ? {
        kdfSalt: keys.kdf_salt,
        wrappedByPassword: keys.wrapped_by_password,
        wrappedByRecovery: keys.wrapped_by_recovery,
        encryptionVersion: keys.encryption_version,
      } : null,
    });
  },

  'POST /api/lang': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { lang } = await readBody(req);
    if (!isLanguage(lang)) return json(res, 400, { error: say(user.lang, 'lang.unknown') });
    await q('update users set lang = $2 where id = $1', [user.id, String(lang)]);
    json(res, 200, { lang: String(lang) });
  },

  'GET /api/board': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const url = new URL(req.url, 'http://localhost');
    json(res, 200, await board(user.id, url.searchParams.get('page')));
  },

  'POST /api/tap': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { taskId, page, side } = await readBody(req);
    const result = await tap(user.id, Number(taskId), side === 'right' ? 'right' : 'left');
    if (!result.ok) return json(res, 400, result);
    json(res, 200, { ...result, board: await board(user.id, page) });
  },

  // Only the fields actually sent are written. The earlier version wrote all
  // three every time, which made every caller responsible for carrying the other
  // two back unchanged — and a caller holding a slightly stale copy of the row
  // silently cleared the session name and the estimate. Renaming a square from
  // the board did exactly that.
  'POST /api/task': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const body = await readBody(req);
    const taskId = Number(body.taskId);
    if (!Number.isInteger(taskId)) return json(res, 400, { error: say(user.lang, 'task.noSquare') });

    const sets = [];
    const values = [user.id, taskId];
    const put = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

    if ('title' in body) put('title', String(body.title ?? '').slice(0, 200));
    if ('titleCipher' in body) put('title_cipher', body.titleCipher || null);
    if ('matchKey' in body) put('match_key', normaliseName(body.matchKey) || null);
    if ('nameCipher' in body) put('name_cipher', body.nameCipher || null);
    if ('matchHash' in body) put('match_hash', body.matchHash || null);
    if ('expectedSeconds' in body) {
      // Three distinct values, and the difference matters:
      //   null … nobody has said yet, so ask once
      //   0    … asked and answered: this square has no clock
      //   n    … count down from n
      const raw = body.expectedSeconds;
      const seconds = raw === '' || raw === null || raw === undefined ? null : Number(raw);
      put('expected_seconds',
        seconds === null || !Number.isFinite(seconds) || seconds < 0 ? null : Math.round(seconds));
    }

    // What the square does when pressed, sealed in the browser like its name.
    // Only an encrypted board may carry one: an instruction the server could
    // read is an instruction whoever takes over the server could write, and
    // that would be a way to run anything on the owner's PC.
    if ('commandSealed' in body) {
      const sealed = body.commandSealed ? String(body.commandSealed) : null;
      if (sealed) {
        const who = await one('select encryption_version from users where id = $1', [user.id]);
        if (!who || who.encryption_version !== 1) {
          return json(res, 400, { error: say(user.lang, 'command.needsEncryption') });
        }
      }
      put('command_sealed', sealed);
    }
    // Where it goes while running, on success, on failure. Checked against
    // this account's states: the ids arrive from a browser, and pointing a
    // square at somebody else's state is not something it should be able to do.
    for (const [key, column] of [
      ['runStateId', 'run_state_id'], ['okStateId', 'ok_state_id'], ['failStateId', 'fail_state_id'],
    ]) {
      if (!(key in body)) continue;
      const raw = body[key];
      const id = raw === '' || raw === null || raw === undefined ? null : Number(raw);
      if (id !== null) {
        const mine = await one('select 1 from states where id = $1 and user_id = $2', [id, user.id]);
        if (!mine) return json(res, 400, { error: say(user.lang, 'command.badState') });
      }
      put(column, id);
    }
    // Which PC it runs on. Empty is every PC that is switched on, which is what
    // a square that has never been asked means. A square is allowed to keep
    // naming a PC that has since been unregistered — that is what makes it fail
    // rather than go to all of them — so the id already on the square passes
    // even when there is no row for it any more; anything else has to be one of
    // this account's, for the same reason the three states do.
    if ('agentId' in body) {
      const raw = body.agentId;
      const id = raw === '' || raw === null || raw === undefined ? null : Number(raw);
      if (id !== null) {
        const mine = await one('select 1 from agents where id = $1 and user_id = $2', [id, user.id]);
        const kept = mine || await one(
          'select 1 from tasks where id = $1 and user_id = $2 and agent_id = $3',
          [taskId, user.id, id]);
        if (!kept) return json(res, 400, { error: say(user.lang, 'command.badPc') });
      }
      put('agent_id', id);
    }

    if (sets.length) {
      await q(`update tasks set ${sets.join(', ')} where user_id = $1 and id = $2`, values);
    }
    json(res, 200, await board(user.id, body.page));
  },

  'POST /api/page': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { id, name, nameCipher } = await readBody(req);
    if (id) await renamePage(user.id, Number(id), name, nameCipher);
    else await addPage(user.id, name, nameCipher);
    json(res, 200, await board(user.id, id || null));
  },

  'POST /api/page/delete': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { id } = await readBody(req);
    const result = await deletePage(user.id, Number(id));
    if (!result.ok) return json(res, 409, result);
    json(res, 200, await board(user.id));
  },

  'POST /api/slot/add': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { page } = await readBody(req);
    const result = await addSlot(user.id, Number(page));
    if (!result.ok) return json(res, 400, result);
    json(res, 200, await board(user.id, page));
  },

  'POST /api/slot/reorder': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { taskId, direction, page } = await readBody(req);
    const result = await reorderSlot(user.id, Number(taskId), direction);
    if (!result.ok) return json(res, 400, result);
    json(res, 200, await board(user.id, page));
  },

  'POST /api/slot/move': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { taskId, toPage, page } = await readBody(req);
    const result = await moveSlot(user.id, Number(taskId), Number(toPage));
    if (!result.ok) return json(res, 400, result);
    // The board that comes back is the one still being looked at, which the
    // square has just left.
    json(res, 200, await board(user.id, page));
  },

  'POST /api/slot/delete': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { taskId, page } = await readBody(req);
    await deleteSlot(user.id, Number(taskId));
    json(res, 200, await board(user.id, page));
  },

  'POST /api/state': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { id, name, nameCipher, colour, runsTimer, leftTo, rightTo, autoTo, startTo, sortOrder, page } = await readBody(req);
    const asId = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
    if (!name || !String(name).trim()) return json(res, 400, { error: say(user.lang, 'state.needName') });

    const clash = await one(
      'select 1 from states where user_id = $1 and lower(name) = lower($2) and id is distinct from $3',
      [user.id, String(name).trim(), id ? Number(id) : null]
    );
    if (clash) return json(res, 409, { error: say(user.lang, 'state.nameTaken') });

    if (id) {
      await q(
        `update states set name = $3, colour = $4, runs_timer = $5,
                left_to = $6, right_to = $7, auto_to = $8, start_to = $9, sort_order = $10,
                name_cipher = coalesce($11, name_cipher)
          where id = $1 and user_id = $2`,
        [Number(id), user.id, String(name).trim(), colour || '#6b7280', Boolean(runsTimer),
          asId(leftTo), asId(rightTo), asId(autoTo), asId(startTo), Number(sortOrder || 0),
          nameCipher || null]
      );
    } else {
      await q(
        `insert into states(user_id, name, colour, runs_timer, left_to, right_to, auto_to,
                            start_to, sort_order, name_cipher)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [user.id, String(name).trim(), colour || '#6b7280', Boolean(runsTimer),
          asId(leftTo), asId(rightTo), asId(autoTo), asId(startTo), Number(sortOrder || 0),
          nameCipher || null]
      );
    }
    json(res, 200, await board(user.id, page));
  },

  'POST /api/state/delete': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { id, page } = await readBody(req);
    const inUse = await one('select 1 from tasks where user_id = $1 and state_id = $2',
      [user.id, Number(id)]);
    if (inUse) return json(res, 409, { error: say(user.lang, 'state.inUse') });
    await q('delete from states where id = $1 and user_id = $2', [Number(id), user.id]);
    json(res, 200, await board(user.id, page));
  },

  'POST /api/account/password': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { current, next, kdfSalt, wrappedByPassword } = await readBody(req);
    const result = await changePassword(user.id, current, next);
    if (!result.ok) return json(res, 400, result);

    // The master key is unchanged — only the wrapping around it is new — so
    // nothing that was encrypted under it has to be touched.
    if (kdfSalt && wrappedByPassword) {
      await q('update users set kdf_salt = $2, wrapped_by_password = $3 where id = $1',
        [user.id, kdfSalt, wrappedByPassword]);
    }
    json(res, 200, result);
  },

  'POST /api/account/rewrap': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { kdfSalt, wrappedByPassword, wrappedByRecovery, authToken, recoveryToken } = await readBody(req);
    if (!kdfSalt || !wrappedByPassword) {
      return json(res, 400, { error: say(user.lang, 'keys.missing') });
    }
    // The salt is half of what proves who is asking, so a new salt means a new
    // proof. Storing one without the other locks the account out at the next
    // sign-in: the browser would derive under the new salt while the stored
    // proof was made under the old one, and nothing would ever match again.
    if (!looksLikeProof(authToken)) return json(res, 400, { error: say(user.lang, 'need.derived') });
    await q(
      `update users set kdf_salt = $2, wrapped_by_password = $3,
              wrapped_by_recovery = coalesce($4, wrapped_by_recovery),
              password_hash = $5,
              recovery_hash = coalesce($6, recovery_hash)
        where id = $1`,
      [user.id, kdfSalt, wrappedByPassword, wrappedByRecovery || null,
        await hashPassword(String(authToken)),
        // A new recovery key means a new proof for it, for the same reason a new
        // salt means a new proof for the password: the pair has to move together
        // or the one left behind opens a door the other cannot.
        recoveryToken ? await hashPassword(String(recoveryToken)) : null]);
    json(res, 200, { ok: true });
  },

  'POST /api/account/email': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { email, password } = await readBody(req);
    const result = await changeEmail(user.id, password, email);
    if (!result.ok) return json(res, 400, result);
    json(res, 200, result);
  },

  'POST /api/account/delete': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { password } = await readBody(req);
    const result = await deleteAccount(user.id, password);
    if (!result.ok) return json(res, 400, result);
    json(res, 200, { ok: true }, { 'Set-Cookie': clearedSessionCookie() });
  },

  // No cookie: this is the way back in for someone who cannot sign in.
  'POST /api/account/reset': async (req, res) => {
    const { token, password, kdfSalt, wrappedByPassword, wrappedByRecovery } = await readBody(req);
    const result = await useResetToken(token, password);
    if (!result.ok) return json(res, 400, result);

    // The salt is stored either way: it is what the browser derives the new
    // proof from, so leaving the old one behind would lock the account out for
    // good. The wrapped key only arrives when the recovery key was used to open
    // it first; without that the account is reachable again but its contents
    // are not, and nothing here can change that.
    if (kdfSalt) {
      await q(
        `update users set kdf_salt = $2,
                wrapped_by_password = coalesce($3, wrapped_by_password),
                wrapped_by_recovery = coalesce($4, wrapped_by_recovery)
          where id = $1`,
        [result.userId, kdfSalt, wrappedByPassword || null, wrappedByRecovery || null]);
    }
    json(res, 200, result);
  },

  'POST /api/webhook/regenerate': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    await q('delete from webhooks where user_id = $1', [user.id]);
    await q('insert into webhooks(token, user_id) values ($1, $2)', [newToken(24), user.id]);
    json(res, 200, await board(user.id));
  },

  // Pressing a command square, in two steps. The browser asks for an id, seals
  // the instruction with that id inside it, and hands the sealed text back.
  // The server cannot do the middle step, which is the point: it never holds
  // a readable instruction, so it can never be made to send one.
  'POST /api/job/new': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { taskId } = await readBody(req);
    const result = await reserveJob(user.id, Number(taskId));
    if (!result.ok) return json(res, 400, result);
    json(res, 200, result);
  },

  'POST /api/job/submit': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { id, sealed, page } = await readBody(req);
    const result = await submitJob(user.id, Number(id), sealed);
    if (!result.ok) return json(res, 400, result);
    json(res, 200, { ...result, board: await board(user.id, page) });
  },

  // As many PCs as the account wants. Registering adds one and leaves the rest
  // as they were; the new token is in this reply and nowhere else the browser
  // can ask for it afterwards, exactly as the webhook's is. The id beside it is
  // no secret — it is how the screen watches for this one to come in, and how a
  // square names it.
  //
  // The name here is the browser's guess (「pc」 or 「phone」), which stands
  // until the program on that PC connects and says what the machine is called.
  'POST /api/agent/register': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { name } = await readBody(req);
    const token = newToken(24);
    const { id } = await one(
      'insert into agents(token, user_id, name) values ($1, $2, $3) returning id',
      [token, user.id, String(name || '').slice(0, 80)]);
    json(res, 200, { token, id: String(id), board: await board(user.id) });
  },

  // Unregistering one PC: its row goes, its stream is closed, and the other PCs
  // carry on. Squares pointed at it are left pointing at it — see
  // sql/011_multi_pc.sql for why they are not quietly re-aimed at everything.
  'POST /api/agent/delete': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { id } = await readBody(req);
    const gone = await one('delete from agents where user_id = $1 and id = $2 returning token',
      [user.id, Number(id)]);
    if (gone) dropListeners(gone.token);
    json(res, 200, await board(user.id));
  },

  // Switched off: still registered, still connected, simply passed over when
  // there is an instruction to hand out.
  'POST /api/agent/enabled': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const { id, on } = await readBody(req);
    await q('update agents set enabled = $3 where user_id = $1 and id = $2',
      [user.id, Number(id), on === true]);
    json(res, 200, await board(user.id));
  },

  // The emergency stop (T-077): the one thing the board can do to the PCs
  // that a PC program can undo and the board cannot. Same cut as a sign-in
  // from a new device, whether or not any PC asked for that one.
  'POST /api/agents/kill': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    await suspendAll(user.id, 'kill');
    json(res, 200, await board(user.id));
  },

  'POST /api/push/subscribe': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    const sub = await readBody(req);
    if (!sub || !sub.endpoint || !sub.keys) return json(res, 400, { error: say(user.lang, 'push.badSubscription') });
    await q(
      `insert into push_subscriptions(user_id, endpoint, p256dh, auth)
       values ($1, $2, $3, $4)
       on conflict (endpoint) do update set user_id = excluded.user_id,
            p256dh = excluded.p256dh, auth = excluded.auth`,
      [user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    json(res, 200, await notify(user.id,
      { title: say(user.lang, 'push.testTitle'), body: say(user.lang, 'push.testBody'), tag: 'test' }));
  },
};

// The stream a PC keeps open. Plain server-sent events over the standard http
// module: one long response, an `event: guard` block first (the switch as the
// board holds it), an `event: job` block per instruction, and a comment every
// fifteen seconds so nothing between here and the PC decides the connection
// has gone quiet and closes it.
//
// On connecting the PC is handed everything still pending and meant for it,
// then whatever arrives while it stays. It is expected to drop and come back —
// a laptop lid, a proxy's idle limit — and each return is the same as the first.
//
// `name` on the address is what the machine calls itself, so several PCs on one
// account can be told apart on the settings screen. It is written down on every
// connection rather than once, because a PC gets renamed.
async function streamJobs(req, res, agent, name) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    // Caddy and nginx buffer responses unless told not to; a buffered stream
    // delivers every instruction five seconds late, which is exactly too late.
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  // Then the board's word on the guard switch, before anything else, so the
  // PC's own copy of it is right from the first moment (T-085, src/deck.js).
  res.write(guardFrame(agent.guard));
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);

  // On the list before anything is awaited. The headers are already out, so
  // the PC counts itself connected from here; a cut (suspendAll) that lands
  // while the rows below are being read has to find this stream, or it is
  // the one stream left open after every other one was closed — measured as
  // a stream that never closed, 2 times in 200 presses of the emergency stop
  // straight after connecting (2026-09-14, test/guard.js).
  const stop = listen(agent.token, res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* closing below */ }
    touchAgent(agent.token).catch(() => {});
  }, 15_000);

  const close = () => { clearInterval(ping); stop(); };
  req.on('close', close);
  res.on('close', close);
  res.on('error', close);

  await touchAgent(agent.token);
  if (name) await nameAgent(agent.token, name);
  // Cut off while those were being written: the stream has been ended by
  // dropListeners, and nothing waiting is for this PC any more.
  if (res.writableEnded) return;
  for (const job of await pendingJobsFor(agent)) {
    try { res.write(frame(job)); } catch (_) { /* ended meanwhile */ }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  // Set before anything routes, so every reply carries them — pages, files,
  // refusals, and the ones that come out of a thrown error.
  for (const [name, value] of Object.entries(guards(req))) res.setHeader(name, value);

  try {
    // The Slack-shaped inlet: no cookie, the secret is the address itself.
    if (req.method === 'POST' && url.pathname.startsWith('/hook/')) {
      const token = url.pathname.slice('/hook/'.length);
      const hook = await one('select user_id from webhooks where token = $1', [token]);
      if (!hook) return send(res, 404, 'unknown hook');
      // Open to anyone holding the address, so it gets a ceiling.
      if (!(await hookAllowed(token))) return send(res, 429, 'too many');
      const report = parseReport(await readBody(req));
      const outcome = await signal(hook.user_id, report, report.body, report.event);
      // What happened, rather than "ok" whatever happened. The setup instructions
      // end by asking whoever wired this up to look at what came back, and "ok"
      // for a report that matched no square made that check worthless: a hook
      // that sealed nothing, or sent a name no square carries, read as working
      // Not 404: that is what an unknown address answers, and telling "wrong
      // URL" apart from "wrong name" is most of the diagnosis. 422 says it was
      // understood and there was nothing to act on, and it is not a 2xx, so it
      // cannot be read as success.
      if (!outcome.matched) {
        // Which of the two it was. A first-time implementer got this wrong and
        // could not tell from the answer whether the name was simply not
        // attached yet or the body had never been sealed — and both are common
        // on the first attempt. The board knows: a sealed report carries a
        // matchHash, an unsealed one does not.
        return send(res, 422, report.matchHash
          ? 'sealed, but no square carries this name'
          : 'this board is encrypted — a readable name can never match a square');
      }
      return send(res, 200, outcome.moved ? 'ok: moved' : 'ok: matched, nowhere to move from here');
    }

    // The PC's inlet. No cookie, the secret is the address, same as the hook —
    // and the same answer for a token nobody has, so the address cannot be
    // probed for. What the PC can do here: hold a stream open and be handed
    // sealed instructions, say it has one, say how it went.
    if (url.pathname.startsWith('/agent/')) {
      const [token, what, jobId, verb] = url.pathname.slice('/agent/'.length).split('/');
      const agent = await agentByToken(token);
      if (!agent) return send(res, 404, 'unknown agent');
      if (!(await agentAllowed(token))) return send(res, 429, 'too many');

      // The two things only this road can do (T-075): ask to be cut off on a
      // sign-in from a new device, and come back after a cut. Both before the
      // cut is checked — coming back is the whole point of the second.
      if (req.method === 'POST' && what === 'guard' && jobId === undefined) {
        const body = await readBody(req);
        if (typeof body.on !== 'boolean') return send(res, 400, 'body must be {"on": true|false}');
        await setGuard(token, body.on);
        await touchAgent(token);
        return send(res, 200, body.on ? 'ok: guard on' : 'ok: guard off');
      }
      if (req.method === 'POST' && what === 'resume' && jobId === undefined) {
        await resumeAgent(token);
        await touchAgent(token);
        return send(res, 200, 'ok: resumed');
      }
      // Cut off: no stream, no receipt, no verdict, until this PC resumes.
      if (agent.suspended_at) return send(res, 403, 'suspended');

      if (req.method === 'GET' && what === 'events' && jobId === undefined) {
        return streamJobs(req, res, agent, url.searchParams.get('name'));
      }
      if (req.method === 'POST' && what === 'jobs' && /^\d+$/.test(jobId || '')) {
        if (verb === 'ack') {
          const r = await ackJob(agent.user_id, Number(jobId));
          if (r.ok) await touchAgent(token);
          return send(res, r.status, r.text);
        }
        if (verb === 'result') {
          const body = await readBody(req);
          if (typeof body.ok !== 'boolean') return send(res, 400, 'body must be {"ok": true|false}');
          const r = await finishJob(agent.user_id, Number(jobId), body.ok);
          if (r.ok) await touchAgent(token);
          return send(res, r.status, r.text);
        }
      }
      return send(res, 404, 'not found');
    }

    const handler = routes[route];
    if (handler) return await handler(req, res);

    if (req.method === 'GET') {
      // One page, more than one address: the reset link carries its token in
      // the query and has to land on the app rather than on a 404.
      const wanted = url.pathname === '/reset' ? '/index.html' : url.pathname;
      return serveStatic(res, PUBLIC_DIR, wanted);
    }
    send(res, 404, 'not found');
  } catch (err) {
    console.error(`${route}: ${err.stack || err.message}`);
    if (!res.headersSent) json(res, 500, { error: say(langFromHeader(req.headers['accept-language']), 'server.broken') });
  }
});

await migrate();

// The board has to move on its own even with nobody watching, so the sweep runs
// here rather than in the browser.
setInterval(() => { sweepTimeouts().catch((e) => console.error(`sweep: ${e.message}`)); }, 5_000);
// The instructions keep their own timers; this catches the ones a restart
// dropped, and tidies the finished ones away.
setInterval(() => { sweepJobs().catch((e) => console.error(`jobs: ${e.message}`)); }, 5_000);
setInterval(() => {
  purgeExpiredSessions().catch(() => {});
  purgeOldRecords().catch((e) => console.error(`purge: ${e.message}`));
}, 3_600_000);

server.listen(PORT, () => {
  console.log(`taskboard listening on ${PORT}; push ${pushConfigured ? 'configured' : 'NOT configured'}`);
});

for (const name of ['SIGINT', 'SIGTERM']) {
  process.on(name, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
