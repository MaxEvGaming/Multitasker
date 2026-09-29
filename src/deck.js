import { q, one } from './db.js';
import { moveTo } from './board.js';
import { say } from './say.js';
import { notify } from './push.js';

// A square that presses something on a PC. The board's part is small on
// purpose: it holds an instruction it cannot read, hands it to the PCs that
// can, and moves the square according to what comes back. Everything readable
// happens at the two ends — sealed in the browser, opened on the PC — and the
// server sits between them holding ciphertext.

// Five seconds: the owner's number, not a tunable. An instruction nobody has
// come for in that time is thrown away and the square says so, because a
// button that was pressed and did nothing is worse than one that says "nobody
// was listening". A minute for the answer, because a command that has run
// that long without saying anything is not going to.
export const ACK_WITHIN_MS = 5_000;
export const RESULT_WITHIN_MS = 60_000;

async function langOf(userId) {
  const row = await one('select lang from users where id = $1', [userId]);
  return (row && row.lang) || 'en';
}

/* -------------------------------------------------------------- listeners */

// Who is connected to collect instructions, by PC rather than by account: an
// account has several, they are switched on and off one at a time, and
// unregistering one has to close that one's connection and leave the others
// alone. Held in memory: a connection is a thing this process has, not a fact
// about the account, and a restart rightly forgets them all — the PC
// reconnects and is offered whatever is still pending and still for it.
const listeners = new Map();

export function listen(token, res) {
  const key = String(token);
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(res);
  return () => {
    const set = listeners.get(key);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) listeners.delete(key);
  };
}

// Unregistering a PC: the row is gone, so nothing new would be offered to it,
// but the stream it is holding open would stay open until it happened to drop.
// Closed here, so the program sees the connection end and comes back to a 404
// rather than sitting on a line to an account that no longer knows it.
export function dropListeners(token) {
  const set = listeners.get(String(token));
  if (!set) return;
  for (const res of set) {
    try { res.end(); } catch (_) { /* already going */ }
  }
  listeners.delete(String(token));
}

// One instruction, framed for the stream. The id travels as a string because
// it is a string inside the sealed text too, and the PC compares the two.
export function frame(job) {
  return `event: job\ndata: ${JSON.stringify({
    id: String(job.id), createdAt: job.created_at, sealed: job.sealed,
  })}\n\n`;
}

// The board's word on the guard switch, at the top of every stream (T-085):
// the PC keeps a copy in its settings file for its window to show, and the
// copy follows the board — a file written when the switch was off by default
// (agent 0.3.0) says on after the first connection to a board where it is on
// (sql/014_guard_default_on.sql). Only the PC can change it (T-075); this is
// the read. A PC from before this frame does not know the event and skips it.
export function guardFrame(on) {
  return `event: guard\ndata: ${JSON.stringify({ on: on === true })}\n\n`;
}

// Which PCs an instruction is for: the one the square names, or — when it names
// none — every PC that is switched on. A named PC that has been switched off or
// unregistered is not quietly swapped for the others; nothing comes back, and
// the square fails five seconds later the way it does when nobody comes for it.
export async function targetsFor(userId, agentId) {
  return q(
    `select token from agents
      where user_id = $1 and enabled and suspended_at is null
        and ($2::bigint is null or id = $2)`,
    [userId, agentId || null]);
}

async function offer(userId, job) {
  const text = frame(job);
  for (const { token } of await targetsFor(userId, job.agent_id)) {
    const set = listeners.get(String(token));
    if (!set) continue;
    for (const res of set) {
      try { res.write(text); } catch (_) { /* a dead socket is dropped on close */ }
    }
  }
}

/* ------------------------------------------------------------ the states */

// Where a command square goes while working, on success, and on failure.
// The square's own choices first; failing those, the shape a fresh board has:
// the first state's instruction arrow (処理中), that state's stop arrow (待機中),
// and the first state's right-tap arrow (停止中). A board whose owner has
// rewired those and picked nothing on the square has nowhere to go, and says so
// rather than guessing.
export async function commandStates(userId, task) {
  const first = await one(
    'select id, start_to, right_to from states where user_id = $1 order by sort_order, id limit 1',
    [userId]);
  const run = task.run_state_id || (first && first.start_to) || null;
  const running = run
    ? await one('select auto_to from states where id = $1 and user_id = $2', [run, userId])
    : null;
  const ok = task.ok_state_id || (running && running.auto_to) || null;
  const fail = task.fail_state_id || (first && first.right_to) || null;
  return { run, ok, fail };
}

/* ----------------------------------------------------------------- the PC */

export async function agentByToken(token) {
  return one('select id, token, user_id, name, enabled, guard, suspended_at from agents where token = $1',
    [String(token || '')]);
}

/* ------------------------------------------------------- the guard (T-073) */

// A PC asks for this itself, over its own road, and only it can: a board
// session that could switch it off would be exactly the thing a stolen phone
// or a new device would use (T-075). What it asks for is that a sign-in from
// a device the account does not know cuts every PC of the account off.
export async function setGuard(token, on) {
  await q('update agents set guard = $2 where token = $1', [token, on === true]);
}

export async function guardArmed(userId) {
  const row = await one('select 1 as armed from agents where user_id = $1 and guard limit 1', [userId]);
  return Boolean(row);
}

// The cut: every PC of the account is marked, every stream it holds is
// closed, and the phone is told once. Reached from a sign-in on a new device
// when some PC asked for it, and from the board's own emergency stop, which
// asks nobody (T-077). What brings a PC back is `resumeAgent`, from that PC.
export async function suspendAll(userId, cause) {
  const rows = await q(
    'update agents set suspended_at = now() where user_id = $1 returning token', [userId]);
  for (const { token } of rows) dropListeners(token);
  if (rows.length) {
    const lang = await langOf(userId);
    await notify(userId, {
      title: say(lang, 'push.suspendedTitle'),
      body: say(lang, cause === 'kill' ? 'push.killedBody' : 'push.suspendedBody'),
      tag: 'suspended',
    });
  }
  return rows.length;
}

export async function resumeAgent(token) {
  await q('update agents set suspended_at = null where token = $1', [token]);
}

export async function touchAgent(token) {
  await q('update agents set last_seen = now() where token = $1', [token]);
}

// What the PC calls itself, sent when it connects. A label and nothing more —
// it is how one row on the settings screen is told from another, and it is
// never what an instruction is addressed to. Written over whatever the browser
// guessed at registration, so a PC that has connected shows its own name.
export async function nameAgent(token, name) {
  await q('update agents set name = $2 where token = $1',
    [token, String(name).slice(0, 80)]);
}

/* ---------------------------------------------------------------- the job */

// The id first, the text second. The sealed text carries its own id — that is
// how the PC tells an instruction it has already carried out from a new one
// that happens to look the same — so the id has to exist before there is
// anything to seal. The row sits empty for the few milliseconds in between and
// is never offered to a PC in that shape.
export async function reserveJob(userId, taskId) {
  const lang = await langOf(userId);
  const task = await one(
    'select id, command_sealed, agent_id from tasks where user_id = $1 and id = $2',
    [userId, taskId]);
  if (!task) return { ok: false, error: say(lang, 'task.noSquare') };
  if (!task.command_sealed) return { ok: false, error: say(lang, 'command.none') };

  const { run } = await commandStates(userId, task);
  if (!run) return { ok: false, error: say(lang, 'command.noStates') };

  // Where the square is pointed now is where this instruction goes, whatever
  // the square is changed to while the PC is carrying it out.
  const { id } = await one(
    'insert into jobs(user_id, task_id, agent_id) values ($1, $2, $3) returning id',
    [userId, task.id, task.agent_id]);
  return { ok: true, id: String(id) };
}

export async function submitJob(userId, jobId, sealed) {
  const lang = await langOf(userId);
  const job = await one(
    `select j.*, t.slot, t.title, t.title_cipher, t.state_id, t.run_state_id
       from jobs j join tasks t on t.id = j.task_id
      where j.user_id = $1 and j.id = $2`, [userId, jobId]);
  if (!job) return { ok: false, error: say(lang, 'job.gone') };
  if (job.status !== 'pending' || job.sealed) return { ok: false, error: say(lang, 'job.gone') };
  if (!sealed || typeof sealed !== 'string') return { ok: false, error: say(lang, 'job.needSealed') };

  // The clock starts here, not at the reservation: this is the first moment
  // there is something a PC could collect.
  const fresh = await one(
    `update jobs set sealed = $3, created_at = now()
      where id = $2 and user_id = $1 returning id, created_at, sealed, agent_id`,
    [userId, jobId, sealed]);

  const { run } = await commandStates(userId, job);
  if (run) await moveTo(userId, squareOf(job), run, 'command');

  await offer(userId, fresh);
  // Checked at the deadline whether or not anyone is connected now. A PC that
  // is connected but does not answer is the same as no PC at all.
  setTimeout(() => { expireIfUncollected(fresh.id).catch((e) => console.error(`expire: ${e.message}`)); },
    ACK_WITHIN_MS + 50).unref();
  return { ok: true, id: String(fresh.id) };
}

// What a PC is shown the moment it connects: everything sealed, still waiting,
// and for this PC — the ones aimed at it and the ones aimed at no one in
// particular. An instruction that expired while it was away is not here — the
// square has already said what happened to it. A PC that is switched off is
// handed nothing at all, the same as it is sent nothing while it stays on the
// line.
export async function pendingJobsFor(agent) {
  if (!agent.enabled || agent.suspended_at) return [];
  return q(
    `select id, created_at, sealed from jobs
      where user_id = $1 and status = 'pending' and sealed <> ''
        and (agent_id is null or agent_id = $2)
      order by id`, [agent.user_id, agent.id]);
}

export async function ackJob(userId, jobId) {
  const job = await one('select id, status, sealed from jobs where user_id = $1 and id = $2',
    [userId, jobId]);
  if (!job || !job.sealed) return { ok: false, status: 404, text: 'unknown job' };
  if (job.status !== 'pending') return { ok: false, status: 409, text: `job is ${job.status}` };
  await q(`update jobs set status = 'taken', taken_at = now() where id = $1`, [job.id]);
  setTimeout(() => { failIfUnanswered(job.id).catch((e) => console.error(`overdue: ${e.message}`)); },
    RESULT_WITHIN_MS + 50).unref();
  return { ok: true, status: 200, text: 'ok: taken' };
}

// Only the verdict travels — no output, no error text. The square's colour is
// the whole of what the owner sees, which is what was asked for.
export async function finishJob(userId, jobId, resultOk) {
  const job = await one(
    `select j.*, t.slot, t.title, t.title_cipher, t.state_id, t.run_state_id, t.ok_state_id, t.fail_state_id
       from jobs j left join tasks t on t.id = j.task_id
      where j.user_id = $1 and j.id = $2`, [userId, jobId]);
  if (!job || !job.sealed) return { ok: false, status: 404, text: 'unknown job' };
  // A result for an instruction that was never acknowledged is accepted: the
  // answer is stronger evidence than the receipt, and losing the receipt on
  // the way is no reason to lose the answer.
  if (job.status !== 'pending' && job.status !== 'taken') {
    return { ok: false, status: 409, text: `job is ${job.status}` };
  }

  await q(
    `update jobs set status = $2, result_ok = $3, finished_at = now(),
            taken_at = coalesce(taken_at, now())
      where id = $1`,
    [job.id, resultOk ? 'done' : 'failed', resultOk]);
  await settle(userId, job, resultOk ? 'done' : 'failed');
  return { ok: true, status: 200, text: resultOk ? 'ok: done' : 'ok: failed' };
}

// The rows above join the job to its square, so `id` is the job's. What moves
// is the square, and it has to be addressed by its own id.
const squareOf = (row) => ({
  id: row.task_id, slot: row.slot, title: row.title, title_cipher: row.title_cipher,
  state_id: row.state_id,
});

// Moves the square to where the outcome says. The square may have been
// deleted in the meantime; then there is nothing to move and nothing to say.
async function settle(userId, job, cause) {
  if (!job.task_id || !job.state_id) return;
  const { ok, fail } = await commandStates(userId, job);
  const target = cause === 'done' ? ok : fail;
  if (target) await moveTo(userId, squareOf(job), target, cause);
}

async function expireIfUncollected(jobId) {
  const job = await one(
    `select j.*, t.slot, t.title, t.title_cipher, t.state_id, t.run_state_id, t.ok_state_id, t.fail_state_id
       from jobs j left join tasks t on t.id = j.task_id
      where j.id = $1 and j.status = 'pending' and j.sealed <> ''
        and j.created_at <= now() - make_interval(secs => $2)`,
    [jobId, ACK_WITHIN_MS / 1000]);
  if (!job) return false;
  await q(`update jobs set status = 'expired', finished_at = now() where id = $1`, [job.id]);
  await settle(job.user_id, job, 'expired');
  return true;
}

async function failIfUnanswered(jobId) {
  const job = await one(
    `select j.*, t.slot, t.title, t.title_cipher, t.state_id, t.run_state_id, t.ok_state_id, t.fail_state_id
       from jobs j left join tasks t on t.id = j.task_id
      where j.id = $1 and j.status = 'taken'
        and j.taken_at <= now() - make_interval(secs => $2)`,
    [jobId, RESULT_WITHIN_MS / 1000]);
  if (!job) return false;
  await q(`update jobs set status = 'failed', result_ok = false, finished_at = now() where id = $1`,
    [job.id]);
  await settle(job.user_id, job, 'failed');
  return true;
}

// The timers above are lost with the process. This runs on an interval and
// catches whatever they would have: instructions left waiting or half-done
// across a restart, and reservations whose sealed text never arrived — a
// browser that closed between asking for an id and sending the text.
export async function sweepJobs() {
  const waiting = await q(
    `select id from jobs where status = 'pending' and sealed <> ''
        and created_at <= now() - make_interval(secs => $1)`, [ACK_WITHIN_MS / 1000]);
  for (const { id } of waiting) await expireIfUncollected(id);

  const overdue = await q(
    `select id from jobs where status = 'taken'
        and taken_at <= now() - make_interval(secs => $1)`, [RESULT_WITHIN_MS / 1000]);
  for (const { id } of overdue) await failIfUnanswered(id);

  // Never sealed, so never offered, so nothing to move: quietly closed.
  await q(`update jobs set status = 'expired', finished_at = now()
            where status = 'pending' and sealed = '' and created_at < now() - interval '1 minute'`);
  // The finished ones are a log with no reader. A day is plenty to look at.
  await q(`delete from jobs where status in ('done', 'failed', 'expired')
            and finished_at < now() - interval '1 day'`);
  return waiting.length + overdue.length;
}
