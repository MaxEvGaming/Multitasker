import { q, one, tx, pool } from './db.js';
import { newToken } from './auth.js';
import { notify } from './push.js';
import { say } from './say.js';

// The starting set of states, and the arrows between them. A new account gets
// this so the board is usable immediately; everything here is editable
// afterwards, including which state each half of a button leads to.
const SEEDS = {
  en: {
    page: 'Page 1',
    first: 'Waiting',
    states: [
      { name: 'Waiting', colour: '#6b7280', runs_timer: false, left: 'On it',   right: 'Stopped', auto: null,      start: 'Running' },
      { name: 'On it',   colour: '#d97706', runs_timer: true,  left: 'Waiting', right: 'Waiting', auto: null,      start: null },
      { name: 'Running', colour: '#16a34a', runs_timer: false, left: 'Waiting', right: 'Waiting', auto: 'Waiting', start: null },
      { name: 'Stopped', colour: '#dc2626', runs_timer: false, left: 'Waiting', right: 'Waiting', auto: null,      start: null },
    ],
  },
  ja: {
    page: 'ページ 1',
    first: '待機中',
    states: [
      { name: '待機中', colour: '#6b7280', runs_timer: false, left: '実行中', right: '停止中', auto: null,     start: '処理中' },
      { name: '実行中', colour: '#d97706', runs_timer: true,  left: '待機中', right: '待機中', auto: null,     start: null },
      { name: '処理中', colour: '#16a34a', runs_timer: false, left: '待機中', right: '待機中', auto: '待機中', start: null },
      { name: '停止中', colour: '#dc2626', runs_timer: false, left: '待機中', right: '待機中', auto: null,     start: null },
    ],
  },
};

// Names are typed on one side and reported on the other, so they have to be
// compared with a little tolerance or they will not meet. Folded here: leading
// and trailing space, the width of the characters (a full-width A and an A are
// the same name to a person), and the curly quotes a phone keyboard produces
// where the terminal produces straight ones.
export function normaliseName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();
}

async function langOf(userId) {
  const row = await one('select lang from users where id = $1', [userId]);
  return (row && row.lang) || 'en';
}

export async function ensureDefaults(userId) {
  const existing = await q('select id from states where user_id = $1 limit 1', [userId]);
  if (existing.length === 0) {
    const who = await one('select lang from users where id = $1', [userId]);
    const seed = SEEDS[who && who.lang] || SEEDS.en;
    const DEFAULT_STATES = seed.states;
    await tx(async (client) => {
      const ids = new Map();
      for (const [i, s] of DEFAULT_STATES.entries()) {
        const { rows } = await client.query(
          `insert into states(user_id, name, colour, sort_order, runs_timer)
           values ($1, $2, $3, $4, $5) returning id`,
          [userId, s.name, s.colour, i, s.runs_timer]
        );
        ids.set(s.name, rows[0].id);
      }
      // Wire the arrows in a second pass: they point at rows that did not exist
      // yet during the first.
      for (const s of DEFAULT_STATES) {
        await client.query(
          'update states set left_to = $2, right_to = $3, auto_to = $4, start_to = $5 where id = $1',
          [ids.get(s.name), ids.get(s.left) || null, ids.get(s.right) || null,
            ids.get(s.auto) || null, ids.get(s.start) || null]
        );
      }
      const waiting = ids.get(seed.first);
      const { rows: page } = await client.query(
        'insert into pages(user_id, name, sort_order) values ($1, $2, 0) returning id',
        [userId, seed.page]
      );
      // Fifteen to begin with — five rows of three on a phone held upright,
      // three of five on its side. Not a limit: squares can be added and
      // removed, and there can be more pages.
      for (let slot = 0; slot < 15; slot += 1) {
        await client.query(
          'insert into tasks(user_id, page_id, slot, state_id) values ($1, $2, $3, $4)',
          [userId, page[0].id, slot, waiting]
        );
      }
    });
  }

  // How long this square usually runs before it wants you again.
  //
  // The original ask was to see, at a glance, how long until each thing needs a
  // hand. Asking people to estimate that was the first answer and a poor one —
  // nobody knows, and a wrong number is worse than none. The board has been
  // recording the real thing all along: a 'start' is the moment an instruction
  // went in, and the next move is the moment it came back wanting something.
  // The middle of those is a better guess than anyone would type.
  //
  // The median rather than the mean: one session left running over lunch would
  // drag an average somewhere useless.
  const typical = await q(
    `select task_id, percentile_cont(0.5) within group (order by seconds)::int as seconds,
            count(*)::int as samples
       from (
         select m.task_id, m.cause,
                extract(epoch from (lead(m.at) over (partition by m.task_id order by m.at) - m.at)) as seconds
           from moves m where m.user_id = $1
       ) spans
      where cause = 'start'
        and seconds is not null
        -- Under twenty seconds is a tap landing on its own echo; over twelve
        -- hours is a session left running overnight, which says nothing about
        -- how long the work takes.
        and seconds between 20 and 43200
      group by task_id`,
    [userId]
  );

  const hook = await one('select token from webhooks where user_id = $1', [userId]);
  if (!hook) {
    await q('insert into webhooks(token, user_id) values ($1, $2)', [newToken(24), userId]);
  }
}

export async function board(userId, pageId = null) {
  const pages = await q(
    `select id, name, name_cipher, sort_order from pages
      where user_id = $1 order by sort_order, id`,
    [userId]
  );
  // Falling back to the first page rather than to nothing: a stale page id in a
  // phone that has been in a pocket for a week should show a board, not an error.
  const current = pages.find((p) => String(p.id) === String(pageId)) || pages[0] || null;

  const states = await q(
    `select id, name, name_cipher, colour, sort_order, runs_timer,
            left_to, right_to, auto_to, start_to
       from states where user_id = $1 order by sort_order, id`,
    [userId]
  );
  const tasks = current ? await q(
    `select t.id, t.slot, t.title, t.title_cipher, t.match_key, t.name_cipher, t.match_hash,
            t.state_id, t.expected_seconds, t.state_since,
            t.command_sealed, t.run_state_id, t.ok_state_id, t.fail_state_id, t.agent_id, t.quiet,
            extract(epoch from (now() - t.state_since))::int as seconds_in_state
       from tasks t where t.page_id = $1 order by t.slot`,
    [current.id]
  ) : [];
  // How long this square usually runs before it wants you again.
  //
  // The original ask was to see, at a glance, how long until each thing needs a
  // hand. Asking people to estimate that was the first answer and a poor one —
  // nobody knows, and a wrong number is worse than none. The board has been
  // recording the real thing all along: a 'start' is the moment an instruction
  // went in, and the next move is the moment it came back wanting something.
  // The middle of those is a better guess than anyone would type.
  //
  // The median rather than the mean: one session left running over lunch would
  // drag an average somewhere useless.
  const typical = await q(
    `select task_id, percentile_cont(0.5) within group (order by seconds)::int as seconds,
            count(*)::int as samples
       from (
         select m.task_id, m.cause,
                extract(epoch from (lead(m.at) over (partition by m.task_id order by m.at) - m.at)) as seconds
           from moves m where m.user_id = $1
       ) spans
      where cause = 'start'
        and seconds is not null
        -- Under twenty seconds is a tap landing on its own echo; over twelve
        -- hours is a session left running overnight, which says nothing about
        -- how long the work takes.
        and seconds between 20 and 43200
      group by task_id`,
    [userId]
  );

  const hook = await one('select token from webhooks where user_id = $1', [userId]);
  const seen = await q(
    `select name, name_cipher, match_hash, hits, last_at from seen_names
      where user_id = $1 order by last_at desc limit 20`,
    [userId]
  );
  // The PCs, without their tokens: a token is shown once, at registration, and
  // never again — a board on a phone left on a table must not carry them. The
  // `id` is what the screen and a square use to name one, and it is no secret.
  // `seen_ago` is worked out here, in seconds, so the screen's "connected"
  // does not depend on the phone's clock agreeing with the server's.
  const agents = await q(
    `select id, name, enabled, guard, suspended_at, created_at, last_seen,
            extract(epoch from (now() - last_seen))::int as seen_ago
       from agents where user_id = $1 order by id`, [userId]);
  return { pages, page: current ? current.id : null, states, tasks,
    webhookToken: hook ? hook.token : null, seenNames: seen, agents,
    typical: Object.fromEntries(typical.map((row) => [row.task_id, row])) };
}

// Exported for the command squares (src/deck.js), which move on the PC's
// word rather than on a tap or a report, and go through the same door so the
// move is recorded and announced by the same rules.
//
// `silent` leaves the notification out and changes nothing else: the move is
// made and recorded the same. It is for the PC's answer on a square marked
// quiet (src/deck.js settle, T-500 = B).
export async function moveTo(userId, task, toStateId, cause, { silent = false } = {}) {
  const from = await one('select name, name_cipher from states where id = $1', [task.state_id]);
  const to = await one('select id, name, name_cipher from states where id = $1 and user_id = $2',
    [toStateId, userId]);
  if (!to) return null;

  await q('update tasks set state_id = $2, state_since = now() where id = $1', [task.id, to.id]);
  await q(
    'insert into moves(user_id, task_id, from_state, to_state, cause) values ($1, $2, $3, $4, $5)',
    [userId, task.id, from ? from.name : null, to.name, cause]
  );

  // Only the moves the person could not have known about. A tap is its own
  // feedback, and so is sending the session an instruction — in both cases they
  // were looking at the thing when it happened.
  //
  // The reason is spelled out, because "waiting for you" and "the estimate ran
  // out" call for different things: one means go and answer it, the other means
  // it is taking longer than you thought.
  const lang = await langOf(userId);
  // The PC's answers ring too: the person pressed the button, but what came
  // back — or did not — is news they could not have known. 'command', the
  // press itself, is deliberately not here.
  const WHY = {
    signal: say(lang, 'why.signal'),
    timeout: say(lang, 'why.timeout'),
    done: say(lang, 'why.done'),
    failed: say(lang, 'why.failed'),
    expired: say(lang, 'why.expired'),
  };
  if (WHY[cause] && !silent) {
    // Once an account is encrypted the server has no words to write: it holds
    // the title and the state names only as ciphertext. It sends those along
    // with a code for the reason, and the phone puts the sentence together.
    const sealed = Boolean(task.title_cipher || (to && to.name_cipher));
    await notify(userId, sealed
      ? {
        titleCipher: task.title_cipher || '',
        fromCipher: from ? from.name_cipher : '',
        toCipher: to.name_cipher || '',
        reason: cause,
        lang,
        slot: task.slot,
        tag: `task-${task.id}`,
      }
      : {
        title: task.title || say(lang, 'square', { n: task.slot + 1 }),
        body: say(lang, 'why.where', { why: WHY[cause], from: from ? from.name : '?', to: to.name }),
        tag: `task-${task.id}`,
      });
  }
  return to;
}

export async function tap(userId, taskId, side) {
  const task = await one('select * from tasks where user_id = $1 and id = $2', [userId, taskId]);
  if (!task) return { ok: false, error: say(await langOf(userId), 'task.noSquare') };
  if (!task.state_id) return { ok: false, error: 'slot has no state' };

  // A square with an instruction on it does not follow the arrows: either half
  // sends the instruction, and the sending happens in the browser, which is
  // the only place that can seal it (/api/job/new, /api/job/submit). This
  // says so and moves nothing, so a page that has not caught up cannot walk a
  // command square around the cycle by hand.
  if (task.command_sealed) return { ok: true, moved: false, command: true };

  const state = await one('select left_to, right_to from states where id = $1', [task.state_id]);
  const target = side === 'right' ? state.right_to : state.left_to;
  // A half with no arrow is deliberately inert, not an error.
  if (!target) return { ok: true, moved: false };

  const to = await moveTo(userId, task, target, 'manual');
  return { ok: true, moved: Boolean(to) };
}

// Claude reports that a session stopped. Find the square that claims that name
// and let its current state's auto arrow decide where it goes.
// `report` is what came in: either a readable name, or — once the account is
// encrypted — a keyed hash of one plus the name sealed for its owner. The server
// can act on the hash without ever learning the name.
export async function signal(userId, report, text, event = 'stop') {
  const named = typeof report === 'string' ? { name: report } : (report || {});
  const clean = normaliseName(named.name);
  const hash = named.matchHash || null;
  const starting = event === 'start';
  const lang = await langOf(userId);

  // Remembered whether or not it matches anything: the names that match nothing
  // are precisely the ones the owner needs to see.
  if (hash) {
    await q(
      `insert into seen_names(user_id, name, match_hash, name_cipher) values ($1, $2, $3, $4)
       on conflict (user_id, name) do update
          set hits = seen_names.hits + 1, last_at = now(),
              name_cipher = coalesce(excluded.name_cipher, seen_names.name_cipher)`,
      [userId, hash, hash, named.nameCipher || null]
    );
  } else if (clean) {
    await q(
      `insert into seen_names(user_id, name) values ($1, $2)
       on conflict (user_id, name) do update set hits = seen_names.hits + 1, last_at = now()`,
      [userId, clean]
    );
  }

  const task = hash
    ? await one('select * from tasks where user_id = $1 and match_hash = $2', [userId, hash])
    : (clean
      ? await one('select * from tasks where user_id = $1 and lower(match_key) = lower($2)',
          [userId, clean])
      : null);

  if (!task) {
    // Nothing claims this name. Say so rather than dropping it silently — a
    // report that reaches nobody is the failure this whole board replaces.
    // Except at the start of a turn: the person is at the keyboard, and a
    // nameless square is not worth interrupting them over.
    if (!starting) {
      await notify(userId, hash
        ? { titleCipher: named.nameCipher || '', reason: 'unmatched', lang, tag: 'unmatched' }
        : { title: named.name || say(lang, 'why.unknownSession'),
          body: text || say(lang, 'why.unmatched'), tag: 'unmatched' });
    }
    return { matched: false };
  }

  const state = await one('select auto_to, start_to, name from states where id = $1',
    [task.state_id]);
  const target = starting ? (state && state.start_to) : (state && state.auto_to);
  if (!target) return { matched: true, moved: false };

  const to = await moveTo(userId, task, target, starting ? 'start' : 'signal');
  return { matched: true, moved: Boolean(to), to: to ? to.name : null };
}

// Runs on a timer. A task whose estimate has run out leaves on its own.
export async function sweepTimeouts() {
  const due = await q(
    `select t.*, s.auto_to
       from tasks t
       join states s on s.id = t.state_id
      where s.runs_timer
        and s.auto_to is not null
        and t.expected_seconds > 0
        and now() - t.state_since >= make_interval(secs => t.expected_seconds)`
  );
  for (const task of due) {
    await moveTo(task.user_id, task, task.auto_to, 'timeout');
  }
  return due.length;
}

export async function addPage(userId, name, nameCipher = null) {
  const { rows } = await pool.query(
    `insert into pages(user_id, name, name_cipher, sort_order)
     values ($1, $2, $3, coalesce((select max(sort_order) + 1 from pages where user_id = $1), 0))
     returning id`,
    [userId, nameCipher ? '' : (String(name || '').trim() || say(await langOf(userId), 'page.new')), nameCipher]
  );
  return rows[0].id;
}

export async function renamePage(userId, pageId, name, nameCipher = null) {
  await q('update pages set name = $3, name_cipher = $4 where id = $2 and user_id = $1',
    [userId, pageId, nameCipher ? '' : (String(name || '').trim() || say(await langOf(userId), 'page.new')), nameCipher]);
}

// The last page stays: a board with no page has nowhere to put a square, and
// the empty state that would need is not worth the code.
export async function deletePage(userId, pageId) {
  const pages = await q('select id from pages where user_id = $1', [userId]);
  if (pages.length <= 1) return { ok: false, error: say(await langOf(userId), 'page.lastOne') };
  await q('delete from pages where id = $2 and user_id = $1', [userId, pageId]);
  return { ok: true };
}

export async function addSlot(userId, pageId) {
  const page = await one('select id from pages where id = $2 and user_id = $1', [userId, pageId]);
  if (!page) return { ok: false, error: say(await langOf(userId), 'page.gone') };

  const waiting = await one(
    'select id from states where user_id = $1 order by sort_order, id limit 1', [userId]);
  await q(
    `insert into tasks(user_id, page_id, slot, state_id)
     values ($1, $2, coalesce((select max(slot) + 1 from tasks where page_id = $2), 0), $3)`,
    [userId, pageId, waiting ? waiting.id : null]
  );
  return { ok: true };
}

// Filing a square under a different page. It keeps everything it had — its
// name, its session, the state it is in and how long it has been there — and
// only changes which page it appears on. It lands at the end of that page
// rather than at its old position, because that position may well be occupied
// and shuffling someone else aside is not what was asked for.
export async function moveSlot(userId, taskId, toPageId) {
  const lang = await langOf(userId);
  const task = await one('select id from tasks where id = $2 and user_id = $1', [userId, taskId]);
  if (!task) return { ok: false, error: say(lang, 'task.noSquare') };

  // Checked against this account rather than trusted: the page id arrives from
  // a browser, and the only thing that makes it the right one is that it
  // belongs to the person asking.
  const page = await one('select id from pages where id = $2 and user_id = $1', [userId, toPageId]);
  if (!page) return { ok: false, error: say(lang, 'page.gone') };

  await q(
    `update tasks
        set page_id = $3,
            slot = coalesce((select max(slot) + 1 from tasks where page_id = $3), 0)
      where id = $2 and user_id = $1`,
    [userId, taskId, page.id]
  );
  return { ok: true };
}

// Swapping a square with the one beside it on the same page.
//
// Positions are unique per page, so the two cannot simply be written across
// each other — the first write would collide with the row still holding the
// number. One of them steps out of the way first. Negative, because it is a
// place no real square occupies, so nothing else can be sitting there.
export async function reorderSlot(userId, taskId, direction) {
  const lang = await langOf(userId);
  const task = await one(
    'select id, page_id, slot from tasks where id = $2 and user_id = $1', [userId, taskId]);
  if (!task) return { ok: false, error: say(lang, 'task.noSquare') };

  const later = direction === 'later';
  const neighbour = await one(
    `select id, slot from tasks
       where page_id = $1 and slot ${later ? '>' : '<'} $2
       order by slot ${later ? 'asc' : 'desc'} limit 1`,
    [task.page_id, task.slot]
  );
  // Already at the end. Not a fault — the button simply is not offered there,
  // and a request that arrives anyway should do nothing rather than complain.
  if (!neighbour) return { ok: true, moved: false };

  await tx(async (client) => {
    await client.query('update tasks set slot = -1 where id = $1', [task.id]);
    await client.query('update tasks set slot = $2 where id = $1', [neighbour.id, task.slot]);
    await client.query('update tasks set slot = $2 where id = $1', [task.id, neighbour.slot]);
  });
  return { ok: true, moved: true };
}

export async function deleteSlot(userId, taskId) {
  await q('delete from tasks where id = $2 and user_id = $1', [userId, taskId]);
  return { ok: true };
}
