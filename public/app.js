import { settingsOrder } from '/settings-order.js';
import { pageAfterSwipe } from '/swipe.js';
import {
  pairLink, normalizeUrl, isMobile, TEXT_MAX, textTooLong, TEXT_MODES, textMode, markerLabel, markerArgs,
} from '/pair.js';
import {
  t, setLang, getLang, applyStatic, langNameInEnglish, LANGUAGES, DEFAULT_LANG,
} from '/i18n.js';
import {
  createKeys, unlockWithPassword, unlockWithRecovery, rewrapForPassword, rewrapForRecovery,
  authTokenFor, recoveryTokenFor,
  subKeysFrom, encryptText, decryptText, blindIndex,
  rememberMaster, forgetMaster, recallMaster, toB64, randomBytes,
} from '/crypto.js';

const $ = (id) => document.getElementById(id);

// A short account of what this page did, kept on the device. It exists
// because a fault was reported three times — the board emptying itself while
// left open — and could not be reproduced on a desktop. Guessing produced
// three wrong answers, so the page keeps its own record instead.
const DIARY = 'taskboard.diary';

function record(what) {
  try {
    const line = new Date().toISOString().slice(11, 19) + ' ' + what;
    const kept = JSON.parse(localStorage.getItem(DIARY) || '[]');
    kept.push(line);
    // Sixty lines is long enough to cover anything interesting and short
    // enough to read on a phone.
    localStorage.setItem(DIARY, JSON.stringify(kept.slice(-60)));
  } catch (_) { /* a full or disabled store must not break the board */ }
}

window.addEventListener('error', (e) => record('error: ' + e.message + ' @ ' + String(e.filename || '').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => record('unhandled: ' + (e.reason && e.reason.message)));
document.addEventListener('visibilitychange', () => record('page ' + document.visibilityState));

// The board was reported reloading itself while left open, and this record —
// written to catch exactly that — could not see it: nothing was written when a
// page loaded, so a reload left no trace at all. Now it does, and the three
// ways a page can come back are told apart, because they have different causes:
//
//   loaded              a fresh load. Several of these with nobody touching
//                       anything is the browser throwing the page away and
//                       fetching it again.
//   loaded (restored)   back out of the browser's cache — the page was kept,
//                       not re-fetched, so nothing was lost.
//   left (kept)         going away but held in that cache.
//   left (dropped)      going away for good; the next appearance is a load.
record('loaded' + (document.visibilityState === 'hidden' ? ' (hidden)' : ''));
window.addEventListener('pageshow', (e) => { if (e.persisted) record('loaded (restored)'); });
window.addEventListener('pagehide', (e) => record('left ' + (e.persisted ? '(kept)' : '(dropped)')));

const state = {
  me: null,
  pushReady: false,
  // Present once the account has been unlocked in this browser. Absent for an
  // account that predates encryption, in which case everything below passes
  // straight through.
  keys: null,
  board: { pages: [], page: null, states: [], tasks: [], webhookToken: null },
  registering: false,
};

// Remembered so that opening the app returns to the page last looked at, rather
// than to the first one every time.
const rememberedPage = () => localStorage.getItem('taskboard.page') || '';
const rememberPage = (id) => { if (id) localStorage.setItem('taskboard.page', String(id)); };

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(20000) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
  if (!res.ok) {
    // The status travels with the error: deciding what to do by matching the
    // wording would break the moment a message is reworded, or translated.
    const refused = new Error(data.error || t('error.network', { status: res.status }));
    refused.status = res.status;
    throw refused;
  }

  // Anything that looks like a board is made readable here, so that nothing
  // downstream has to know the difference.
  if (data && Array.isArray(data.tasks) && Array.isArray(data.states)) await openBoard(data);
  if (data && data.board) await openBoard(data.board);
  return data;
}

// Fills the readable fields in from the sealed ones. A board from an account
// without encryption arrives readable already and is left alone.
async function openBoard(board) {
  if (!state.keys) return board;
  const { dataKey } = state.keys;
  const open = (blob, fallback) => (blob ? decryptText(dataKey, blob) : Promise.resolve(fallback));

  await Promise.all([
    ...(board.pages || []).map(async (p) => { p.name = await open(p.name_cipher, p.name); }),
    ...(board.states || []).map(async (st) => { st.name = await open(st.name_cipher, st.name); }),
    ...(board.tasks || []).map(async (t) => {
      t.title = await open(t.title_cipher, t.title);
      t.match_key = await open(t.name_cipher, t.match_key);
      // What pressing it does, if anything. Sealed as JSON: {kind, args}.
      t.command = parseCommand(await open(t.command_sealed, ''));
    }),
    ...(board.seenNames || []).map(async (n) => { n.name = await open(n.name_cipher, n.name); }),
  ]);
  return board;
}

// A command square's instruction, once opened. Anything that is not the shape
// the settings screen writes is treated as no command at all, so a square
// cannot be made to send something it was never given.
//
// `exec` (one line handed to cmd.exe) was stopped on 2026-09-14 — it ran
// anything, with nothing to hold it back. A square still sealed with it reads
// as an ordinary square: its editor opens on 「なし」, a press follows the
// arrows, and the next save clears the seal.
// `marker` (配信マーカー, 2026-10-05) writes down on the PC how far into the
// stream and the recording the press came; its square does not ring when the
// PC answers (T-500 = B), which the board learns from `quiet` on save.
const COMMAND_KINDS = ['open', 'url', 'hotkey', 'text', 'obs', 'marker'];
const OBS_OPS = ['scene', 'record', 'stream', 'mute', 'visible'];
// `text` types a line into whatever window is in front of the PC: a key to
// open the game's chat, the line, then Enter. The games are here only to fill
// the key in — what is saved is the key itself, so a game whose chat key has
// been changed, or a program that is not a game at all, is a key typed by hand
// and nothing more. Nothing about the chosen game is saved or sent.
const TEXT_GAMES = [['', ''], ['minecraft', 't'], ['fivem', 't']];
// `visible` is the first OBS action that needs more than the one name `arg`
// has always carried: the scene, the source in it, and which of show / hide /
// swap-over. It is saved as {op, scene, source, arg}; the older four stay
// exactly {op, arg} (docs/DECK_AGENT_PROTOCOL.md §3). `toggle` keeps the word
// the other actions use on the wire, and is only worded differently on screen.
const OBS_VISIBLE_STATES = [['show', 'show'], ['hide', 'hide'], ['toggle', 'swap']];

function parseCommand(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !COMMAND_KINDS.includes(parsed.kind)) return null;
    return { kind: parsed.kind, args: parsed.args && typeof parsed.args === 'object' ? parsed.args : {} };
  } catch (_) { return null; }
}

// Sealed on the way out. Returns the extra fields to send alongside — or
// nothing at all when the account is not encrypted.
async function sealText(value) {
  if (!state.keys) return null;
  return encryptText(state.keys.dataKey, value ?? '');
}

async function sealName(name) {
  if (!state.keys) return null;
  return {
    nameCipher: await encryptText(state.keys.dataKey, name ?? ''),
    matchHash: name ? await blindIndex(state.keys.indexKey, name) : null,
  };
}

// Nothing sends a typed password. This is what goes instead: derived here,
// useless for unwrapping, good only for proving who is asking.
//
// The salt has to match the one the account was made with, so it is fetched
// first. It is not secret — a random number that opens nothing on its own.
async function proofOf(password, email) {
  const who = email || (state.me && state.me.user && state.me.user.email) || '';
  const { kdfSalt } = await api('/api/prelogin', { email: who });
  return authTokenFor(password, kdfSalt);
}

// The length rule lives here now. The server only ever sees a derived value,
// which is always long, so it cannot tell a short password from a good one.
const PASSWORD_MIN = 10;

const stateById = (id) => state.board.states.find((s) => String(s.id) === String(id)) || null;

// The account is encrypted, but this device cannot read it — signed in on a
// machine that never held the key, or one that has since forgotten it.
//
// Everything used to carry on quietly in this state: the key vanished from the
// settings, and the instructions for Claude simply omitted the part about
// sealing. Following them produced a setup that could never work, and nothing
// anywhere said why. It cost a whole board being wired up wrong.
const lockedOut = () => Boolean(
  !state.keys && state.me && state.me.keys && state.me.keys.encryptionVersion === 1
);
const nameOf = (id) => { const s = stateById(id); return s ? s.name : ''; };

/* ---------------------------------------------------------------- screens */

function show(which) {
  for (const id of ['offline', 'login', 'reset-screen', 'board-screen', 'settings']) $(id).hidden = id !== which;
}

async function resetScreen(token) {
  show('reset-screen');
  $('reset-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('reset-status').textContent = '';
    try {
      const chosen = $('reset-password').value;
      if (chosen.length < PASSWORD_MIN) throw new Error(t('settings.account.tooShort', { n: PASSWORD_MIN }));
      // 新しいソルトを作り、そのソルトで証明を作って送る。パスワードは出ない。
      // 包みは古いパスワードのままなので、この後のログインで復旧鍵を聞かれる。
      // それは仕様どおり — 再設定だけでは中身は開かない。
      const freshSalt = toB64(randomBytes(16));
      await api('/api/account/reset', {
        token,
        password: await authTokenFor(chosen, freshSalt),
        kdfSalt: freshSalt,
      });
      $('reset-status').className = 'note';
      $('reset-status').textContent = t('reset.done');
      // Back to the front door, with the token gone from the address bar so a
      // refresh does not try to spend it again.
      history.replaceState(null, '', '/');
      setTimeout(() => { show('login'); renderLogin(); }, 1500);
    } catch (err) {
      $('reset-status').className = 'error';
      $('reset-status').textContent = err.message;
    }
  });
}

async function boot() {
  let remembered = null;
  try { remembered = localStorage.getItem('taskboard.lang'); } catch (_) {}
  setLang(remembered || DEFAULT_LANG);
  applyStatic();

  state.me = (await api('/api/me'));
  if (state.me.lang) { setLang(state.me.lang); applyStatic(); }

  const token = new URL(location.href).searchParams.get('token');
  if (token) return resetScreen(token);

  const invite = new URL(location.href).searchParams.get('invite');
  if (invite && !state.me.user) {
    $('invite').value = invite;
    state.registering = true;
    history.replaceState(null, '', '/');
  }
  if (!state.me.user) { renderLogin(); show('login'); return; }

  // A page opened with a session already in place: the key is not in memory,
  // but this device may have kept it from last time.
  if (!state.keys && state.me.keys && state.me.keys.encryptionVersion === 1) {
    try {
      const master = await recallMaster();
      if (master) await useMaster(new Uint8Array(master));
    } catch (_) {}
  }

  await refresh();
  show('board-screen');
}

async function refresh() {
  const page = state.board.page || rememberedPage();
  state.board = await api(`/api/board${page ? `?page=${encodeURIComponent(page)}` : ''}`);
  rememberPage(state.board.page);
  renderBoard();
  renderPageButton();
}

function renderPageButton() {
  const current = state.board.pages.find((p) => String(p.id) === String(state.board.page));
  $('open-pages').textContent = current ? current.name : t('board.pages');
}

/* ------------------------------------------------------------------ board */

// Seconds left in a timed state, or null when this square is not counting.
function remainingSeconds(task) {
  const st = stateById(task.state_id);
  if (!st || !st.runs_timer || !(task.expected_seconds > 0)) return null;
  const elapsed = (Date.now() - Date.parse(task.state_since)) / 1000;
  return Math.max(0, Math.round(task.expected_seconds - elapsed));
}

function roughly(seconds) {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// Only once it has happened a few times. Two runs is an anecdote, and a number
// that swings wildly between visits is worse than a blank space.
function typicalFor(task) {
  const row = (state.board.typical || {})[task.id];
  return row && row.samples >= 3 ? row.seconds : null;
}

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// The moment worth catching: the grid going from full to empty. What this
// says is the difference between 'the server sent nothing', 'we are looking
// at a different page' and 'the drawing itself fell over'.
let lastDrawn = 0;

function renderBoard() {
  const grid = $('grid');
  const count = (state.board.tasks || []).length;
  if (lastDrawn > 0 && count === 0) {
    record('grid emptied: was ' + lastDrawn
      + ', page=' + state.board.page
      + ', pages=' + (state.board.pages || []).length
      + ', states=' + (state.board.states || []).length);
  }
  lastDrawn = count;
  grid.replaceChildren();

  // A page with nothing on it used to be a blank screen, which is exactly what
  // losing everything would look like — and it read that way to the owner, who
  // had simply swiped onto an empty page. An empty page should say it is empty.
  if (state.board.tasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'note empty-page';
    empty.textContent = t('board.emptyPage');
    grid.append(empty);
    return;
  }

  for (const task of state.board.tasks) {
    const st = stateById(task.state_id);
    const cell = document.createElement('div');
    cell.className = 'cell';
    // Read by the stylesheet, which washes it out to a tint. Set here rather
    // than as a background so the strength of the wash lives in one place.
    if (st) cell.style.setProperty('--tint', st.colour);

    // The three tap zones, laid over everything else.
    const rename = document.createElement('button');
    rename.className = 'zone rename';
    rename.setAttribute('aria-label', t('board.rename', { what: task.title || t('board.emptySquare', { n: task.slot + 1 }) }));
    rename.addEventListener('click', () => onRename(task));

    // Both halves leading to the same place is a state with one way out, and
    // splitting the square to offer the same thing twice invites the reader to
    // hunt for a difference that is not there. So it is drawn as one zone.
    // Nothing a tap does changes: each side still reports its own side, and
    // either still lands in the same state.
    //
    // A square with a command on it is one zone for the same reason: either
    // half sends the command, and there is no arrow to follow. A seal this
    // device opened and found no known kind in is not a command (the stopped
    // `exec`); a seal it cannot open at all may be one, and is drawn as such.
    const commands = Boolean(task.command_sealed) && (Boolean(task.command) || !state.keys);
    const oneWayOut = commands
      || Boolean(st && st.left_to && String(st.left_to) === String(st.right_to));

    const left = document.createElement('button');
    left.className = oneWayOut ? 'zone whole' : 'zone left';
    left.setAttribute('aria-label', commands ? t('board.command') : (st && st.left_to
      ? t('board.tapTo', { what: task.title || t('board.emptyShort'), state: nameOf(st.left_to) })
      : t('board.tapNowhere.left')));
    left.addEventListener('click', () => (commands ? runCommand(task) : onTap(task, 'left')));

    const right = document.createElement('button');
    right.className = 'zone right';
    right.hidden = oneWayOut;
    right.setAttribute('aria-label', st && st.right_to
      ? t('board.tapTo', { what: task.title || t('board.emptyShort'), state: nameOf(st.right_to) })
      : t('board.tapNowhere.right'));
    right.addEventListener('click', () => (commands ? runCommand(task) : onTap(task, 'right')));

    const divider = document.createElement('div');
    divider.className = 'cell-divider';
    divider.hidden = oneWayOut;

    const top = document.createElement('div');
    top.className = 'cell-top';
    const title = document.createElement('div');
    title.className = task.title ? 'cell-title' : 'cell-title empty';
    title.textContent = task.title || t('board.emptySquare', { n: task.slot + 1 });
    top.append(title);

    const body = document.createElement('div');
    body.className = 'cell-body';

    const pill = document.createElement('div');
    pill.className = 'cell-state';
    pill.textContent = st ? st.name : '—';
    pill.style.background = st ? st.colour : '#3a3d45';
    body.append(pill);

    // With a clock running, the countdown is the answer. Without one, what the
    // square has usually taken is the next best thing — and it is the answer to
    // the question the board was built for.
    const usual = typicalFor(task);
    if (remainingSeconds(task) === null && usual && st && st.runs_timer) {
      const label = document.createElement('div');
      label.className = 'cell-remaining';
      label.textContent = t('board.typical', { time: roughly(usual) });
      body.append(label);
    }

    const remaining = remainingSeconds(task);
    if (remaining !== null) {
      cell.append(ring(remaining, task.expected_seconds));
      const label = document.createElement('div');
      label.className = 'cell-remaining';
      label.textContent = t('board.remaining', { time: clock(remaining) });
      body.append(label);
    }

    cell.append(divider, top, body, rename, left, right);

    if (st) {
      const hints = document.createElement('div');
      hints.className = 'cell-hints';
      if (commands) {
        // What a press does, in place of where it leads. A device that cannot
        // open the command says so here, rather than sending a press nowhere.
        hints.classList.add('one');
        const only = document.createElement('span');
        only.textContent = task.command ? `⚡ ${t('board.command')}` : t('board.commandLocked');
        hints.append(only);
      } else if (oneWayOut) {
        hints.classList.add('one');
        const only = document.createElement('span');
        only.textContent = nameOf(st.left_to);
        hints.append(only);
      } else {
        const l = document.createElement('span');
        l.textContent = st.left_to ? `◀ ${nameOf(st.left_to)}` : '';
        const r = document.createElement('span');
        r.textContent = st.right_to ? `${nameOf(st.right_to)} ▶` : '';
        hints.append(l, r);
      }
      cell.append(hints);
    }

    grid.append(cell);
  }

}

function ring(remaining, total) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('viewBox', '0 0 100 100');

  const r = 46;
  const circumference = 2 * Math.PI * r;
  const done = total > 0 ? 1 - remaining / total : 1;

  for (const [cls, dash] of [['track', null], ['run', done]]) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '50'); c.setAttribute('cy', '50'); c.setAttribute('r', String(r));
    if (dash !== null) {
      c.setAttribute('transform', 'rotate(-90 50 50)');
      c.setAttribute('stroke-dasharray', String(circumference));
      c.setAttribute('stroke-dashoffset', String(circumference * dash));
    }
    svg.append(c);
  }
  return svg;
}

// Ask for the estimate *after* the move, not before. The server decides where a
// tap lands, using the state in the database; the page may be a second behind,
// and when the two disagree a square can arrive in a timed state with no
// estimate and sit there with no ring. Reading the result back and filling the
// gap makes that impossible however stale the page was.
async function onTap(task, side) {
  const result = await api('/api/tap', { taskId: task.id, page: state.board.page, side });
  if (!result.board) return;
  state.board = result.board;
  renderBoard();

  const now = state.board.tasks.find((t) => String(t.id) === String(task.id));
  const landed = now ? stateById(now.state_id) : null;
  // Asked only when nobody has answered yet. A stored zero is an answer —
  // "this square has no clock" — and asking again every time would make that
  // impossible to say.
  if (!landed || !landed.runs_timer || now.expected_seconds !== null) return;

  const minutes = await askDuration(now);
  if (minutes === null) return;
  state.board = await api('/api/task',
    { taskId: now.id, page: state.board.page, expectedSeconds: minutes * 60 });
  renderBoard();
}

// Pressing a command square. Two trips: the server hands out an id, and the
// instruction — with that id and the time inside it — is sealed here and
// handed back. The id has to be inside the sealed text, so it has to exist
// before the sealing, so the round trip cannot be folded into one. The server
// moves the square to its "working" state on the second trip; what happens
// after that is the PC's to say, and the board picks it up on its next look.
//
// Nothing is sent from a device that cannot open the command. It would be
// re-sealing ciphertext it cannot read, and the PC would refuse it — better
// to say so here than to have the square go red for a reason nobody can see.
let sending = false;
async function runCommand(task) {
  if (!task.command || !state.keys) { alert(t('board.commandLocked')); return; }
  if (sending) return;                       // one press at a time
  sending = true;
  try {
    const { id } = await api('/api/job/new', { taskId: task.id });
    // A text square always travels with its typing mode spelled out, so the
    // PC program's own fallback for a missing one (paced) is never reached
    // and the default the board shows (burst, T-092) is the one that runs.
    // A marker always carries its label as a string, empty when none was
    // given, and the board's language now, which the PC writes the line in
    // (docs/DECK_AGENT_PROTOCOL.md §3 `marker`).
    let args = task.command.args;
    if (task.command.kind === 'text') args = { ...args, mode: textMode(args) };
    if (task.command.kind === 'marker') args = markerArgs(args, getLang());
    const sealed = await encryptText(state.keys.dataKey, JSON.stringify({
      id: String(id), at: Date.now(), kind: task.command.kind, args,
    }));
    const result = await api('/api/job/submit', { id, sealed, page: state.board.page });
    if (result.board) { state.board = result.board; renderBoard(); }
    // The five seconds and the answer both land on the server; the board is
    // re-read every five seconds anyway, and once more just after the deadline
    // so an instruction nobody collected shows as such without the wait.
    setTimeout(() => { refresh().catch(() => {}); }, 6000);
  } catch (err) {
    record('command: ' + err.message);
    alert(err.message);
  } finally {
    sending = false;
  }
}

// Wired to the two buttons directly rather than to the dialog's own close
// event. Submitting a form with method="dialog" is the tidier way to write this,
// but its behaviour is not uniform — iOS Safari only grew <dialog> in 15.4 —
// and a prompt that never resolves leaves the square running with no ring.
// The top of the square renames it, and sends nothing but the name: the endpoint
// leaves alone whatever it is not given, so a page holding a slightly old copy
// of the row cannot wipe the session name or the estimate on its way past.
async function onRename(task) {
  const title = await askTitle(task);
  if (title === null) return;
  state.board = await api('/api/task', {
    taskId: task.id, page: state.board.page,
    title: state.keys ? '' : title,
    ...(state.keys ? { titleCipher: await sealText(title) } : {}),
  });
  renderBoard();
}

function askTitle(task) {
  return new Promise((resolve) => {
    const dialog = $('title-dialog');
    const input = $('title-input');
    $('title-target').textContent = t('board.square', { n: task.slot + 1 });
    input.value = task.title || '';

    const finish = (value) => {
      $('title-ok').removeEventListener('click', onOk);
      $('title-cancel').removeEventListener('click', onCancel);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onOk = (e) => { e.preventDefault(); finish(input.value.trim()); };
    const onCancel = (e) => { e.preventDefault(); finish(null); };

    $('title-ok').addEventListener('click', onOk);
    $('title-cancel').addEventListener('click', onCancel);

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    input.focus();
    input.select();
  });
}

function askDuration(task) {
  return new Promise((resolve) => {
    const dialog = $('duration-dialog');
    const input = $('duration-minutes');
    const usual = typicalFor(task);
    $('duration-target').textContent = [
      task.title || t('board.square', { n: task.slot + 1 }),
      usual ? t('dialog.duration.typical', { time: roughly(usual) }) : '',
    ].filter(Boolean).join(' — ');
    // Thirty minutes was a guess standing in for knowing. Once the square has a
    // history, that history is the better opening offer.
    input.value = task.expected_seconds > 0
      ? Math.round(task.expected_seconds / 60)
      : (usual ? Math.max(1, Math.round(usual / 60)) : 30);

    const finish = (value) => {
      $('duration-ok').removeEventListener('click', onOk);
      $('duration-cancel').removeEventListener('click', onCancel);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onOk = (e) => {
      e.preventDefault();
      const minutes = Number(input.value);
      // Zero is a real answer, not a refusal: it turns the clock off for this
      // square and stops the question coming back.
      finish(Number.isFinite(minutes) && minutes >= 0 ? minutes : null);
    };
    const onCancel = (e) => { e.preventDefault(); finish(null); };

    $('duration-ok').addEventListener('click', onOk);
    $('duration-cancel').addEventListener('click', onCancel);

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    input.focus();
    input.select();
  });
}

/* --------------------------------------------------------------- settings */

// The three parts are drawn separately on purpose. Redrawing the lot after a
// save throws away whatever has been typed into the other rows and not saved
// yet — with nine squares to fill in, that means filling most of them twice.
function renderLang() {
  const sel = $('lang-choice');
  sel.replaceChildren();
  for (const { code, label } of LANGUAGES) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;      // each language names itself, in itself
    sel.append(option);
  }
  sel.value = getLang();
}

function applyLang(code) {
  setLang(code);
  // Kept on the device as well as on the account, so the sign-in screen — drawn
  // before there is an account to ask — comes back in the language last chosen
  // here rather than reverting to the default every time.
  try { localStorage.setItem('taskboard.lang', getLang()); } catch (_) {}
  applyStatic();
  renderBoard();
  renderPageButton();
  renderLogin();
  renderSettings();
}

// Which build is being served, next to the record of what went wrong. "Is my fix
// on there yet?" was being answered by guessing, and a deploy that never
// happened looks exactly like a fix that did not work.
function renderBuild() {
  // The page this script is running in can be older than the script itself: a
  // phone keeps the shell it first loaded, and a deploy replaces app.js without
  // it. Reaching for something that shell does not have throws, and this is
  // called from renderSettings, so the throw takes the whole settings screen
  // with it — which is exactly the fault this line was added to help diagnose.
  const where = $('build');
  if (!where) return;
  const id = state.me && state.me.build;
  where.textContent = id ? t('settings.diary.build', { id }) : '';
}

function renderDiary() {
  let lines = [];
  try { lines = JSON.parse(localStorage.getItem(DIARY) || '[]'); } catch (_) {}
  $('diary').textContent = lines.length ? lines.join('\n') : '—';
}

// How many devices this account would ring. Shown because "sent to 1 device"
// says nothing about which, and a notification landing on a browser at a desk
// looks exactly like one that never reached the phone in your hand.
function renderDevices() {
  const where = $('push-devices');
  if (!where) return;
  const n = (state.me && state.me.devices) || 0;
  where.textContent = t(n ? 'settings.push.devices' : 'settings.push.noDevicesYet', { n });
}

function renderSettings() {
  renderDevices();
  renderLang();
  renderDiary();
  renderBuild();
  renderHook();
  renderAgent();
  renderStates();
  renderPages();
  renderSlots();
  orderSettings();
}

// The PC that collects instructions, set up in three steps: download the
// program, run it, press 「この PC をつなぐ」. The third step registers a PC
// and hands the program everything it needs in one `multitasker://` link —
// built here, from the key this browser holds, and never sent to the server.
//
// The token is shown exactly once, in the reply to registering, and lives in
// `freshToken` / `freshCode` only until this screen is left; the board never
// carries it, so a phone left on a table cannot give it away.
let freshToken = null;    // a bare token, for the hand-set-up route under Advanced
let freshCode = null;     // the connect code (= the pair link), for the fallback
let freshId = null;       // the row that code was made for, to watch for it coming in
let fallbackOpen = false; // the program did not pick the link up; show the code
let connecting = null;    // an AbortController while step 3 is being watched

// "Connected" is a fact about the last minute, not about ever: the program
// pings every 15 s, so three missed pings means it is not there. The server
// works the age out (`seen_ago`), so a phone whose clock is wrong sees the
// same answer as everyone else.
const CONNECTED_WITHIN_S = 45;
const agentIsConnected = (agent) =>
  Boolean(agent && agent.seen_ago !== null && agent.seen_ago !== undefined && Number(agent.seen_ago) < CONNECTED_WITHIN_S);

const registeredPcs = () => state.board.agents || [];
const somePcConnected = () => registeredPcs().some(agentIsConnected);

// One line per PC: what it calls itself, whether it is there, when it was last
// heard from, the switch, and the way to take it off the account. The switch
// and the button both go to the server and come back with the whole board, so
// what is on screen afterwards is what the server holds.
function pcRow(pc) {
  const row = document.createElement('div');
  row.className = 'pc-row';

  const name = document.createElement('span');
  name.className = 'pc-name';
  name.textContent = pcName(pc);

  const here = document.createElement('span');
  const connected = agentIsConnected(pc);
  here.className = `pc-status ${connected ? 'on' : 'off'}`;
  here.textContent = t(connected ? 'settings.pc.connected' : 'settings.pc.offline');

  const when = document.createElement('span');
  when.className = 'note';
  when.textContent = pc.last_seen
    ? t('settings.pc.lastSeen', { ago: roughly(Number(pc.seen_ago)) })
    : t('settings.pc.neverSeen');

  // Read only: the guard is switched from the PC program and nowhere else
  // (T-075), and a PC that has been cut off is brought back there too.
  const guard = document.createElement('span');
  guard.className = pc.suspended_at ? 'pc-status off pc-guard' : 'note pc-guard';
  guard.textContent = pc.suspended_at ? t('settings.pc.suspended') : (pc.guard ? t('settings.pc.guardOn') : '');
  guard.hidden = !guard.textContent;

  const on = document.createElement('input');
  on.type = 'checkbox';
  on.checked = pc.enabled !== false;
  const onLabel = document.createElement('label');
  onLabel.className = 'pc-on';
  onLabel.append(on, document.createTextNode(t('settings.pc.on')));
  on.addEventListener('change', async () => {
    try {
      state.board = await api('/api/agent/enabled', { id: pc.id, on: on.checked });
      renderAgent();
    } catch (err) {
      on.checked = !on.checked;
      $('pc-copy-status').textContent = err.message;
    }
  });

  const remove = document.createElement('button');
  remove.className = 'ghost';
  remove.textContent = t('settings.pc.remove');
  remove.addEventListener('click', async () => {
    if (!confirm(t('settings.pc.removeConfirm', { name: pcName(pc) }))) return;
    try {
      state.board = await api('/api/agent/delete', { id: pc.id });
      renderAgent();
    } catch (err) {
      $('pc-copy-status').textContent = err.message;
    }
  });

  row.append(name, here, when, guard, onLabel, remove);
  return row;
}

function renderAgent() {
  const pcs = registeredPcs();
  const mobile = isMobile(navigator.userAgent, navigator.maxTouchPoints);
  // Connecting needs the key (it goes into the link); a bare token does not.
  const noKey = !state.keys;

  const blocked = $('pc-blocked');
  blocked.hidden = !noKey;
  blocked.textContent = noKey ? t(lockedOut() ? 'settings.pc.locked' : 'settings.pc.needsEncryption') : '';

  // One line for the section as a whole, then a line for each PC. The whole
  // answer to "is any of this working" should be readable without counting
  // rows; which of them is working is the rows' job.
  const status = $('pc-status');
  const heard = pcs.filter((pc) => pc.last_seen)
    .map((pc) => Number(pc.seen_ago)).sort((a, b) => a - b)[0];
  if (somePcConnected()) {
    status.textContent = t('settings.pc.connected');
    status.className = 'pc-status on';
  } else if (heard !== undefined) {
    status.textContent = t('settings.pc.wasConnected', { ago: roughly(heard) });
    status.className = 'pc-status off';
  } else {
    status.textContent = t(pcs.length ? 'settings.pc.notConnected' : 'settings.pc.none');
    status.className = 'pc-status off';
  }

  const list = $('pc-list');
  list.replaceChildren(...pcs.map(pcRow));
  $('kill-pcs').disabled = pcs.length === 0;

  // The row the connect code on screen was made for — not any PC, since another
  // one having been connected all along says nothing about this one.
  const fresh = pcs.find((pc) => String(pc.id) === String(freshId));

  // The connect code is only ever an answer to "nothing picked the link up",
  // and a PC that has since come in is that question answered. Nothing used to
  // put the code away again, so a program that connected on the ninth second
  // left 「接続済み ✓」 and 「受け取れませんでした」 on screen together — seen on
  // the Owner's screen, T-048. This screen rereads the PC's row every few
  // seconds, so hanging it here is enough; the eight seconds are untouched.
  // A phone is a different case: there the code is the way in, not a report of
  // failure, and it stays on show as before.
  if (fresh && agentIsConnected(fresh)) fallbackOpen = false;

  // Step ③ is a button on a PC and a sentence on a phone: a phone cannot run
  // the program, so it is told to open this page on the PC — or to make a
  // connect code here for a program that is already installed there.
  $('connect-pc').hidden = mobile;
  $('connect-pc').disabled = noKey;
  if (mobile) $('pc-connect-status').textContent = t('settings.pc.mobile');

  const fallback = $('pc-fallback');
  fallback.hidden = !(mobile || fallbackOpen);
  $('pc-fallback-why').textContent = !mobile && fallbackOpen ? t('settings.pc.fallbackMissed') : '';
  $('pc-fallback-why').hidden = !(!mobile && fallbackOpen);
  $('pc-code').value = freshCode || '';
  $('copy-pc-code').hidden = !freshCode;
  $('make-pc-code').disabled = noKey;

  // The hand route, folded away. Each press adds a PC, so the wording does not
  // change with how many there already are.
  $('register-pc').disabled = noKey && !lockedOut();
  const block = $('pc-token-block');
  block.hidden = !freshToken;
  $('pc-token').value = freshToken || '';

  // Every path that changes which PCs there are comes through here, so the
  // squares' pickers are brought up to date in the same breath. On the first
  // draw there are no pickers yet — the squares are built after this — and
  // this finds nothing, which is right.
  relistPcs();
}

// Adds a PC and builds the link for it. The link carries the master key
// in its fragment, from `state.keys` — this is the one place the key is
// written out for something other than this browser, and the string only
// ever goes to the OS (as a `multitasker://` navigation) or to the clipboard.
async function makeConnectCode() {
  const result = await api('/api/agent/register', { name: mobileOrPc() });
  if (result.board) state.board = result.board;
  freshToken = null;                 // whatever token was on screen is not this one
  freshId = result.id;
  freshCode = pairLink(location.origin, result.token, toB64(state.keys.master));
  renderAgent();
  return freshCode;
}

const mobileOrPc = () => (isMobile(navigator.userAgent, navigator.maxTouchPoints) ? 'phone' : 'pc');

// Rereads the PCs' rows. Called every few seconds while the settings are on
// screen, so the status line above the steps is live, and every second for
// a while after ③ is pressed.
async function pollAgent() {
  const page = state.board.page || rememberedPage();
  state.board = await api(`/api/board${page ? `?page=${encodeURIComponent(page)}` : ''}`);
  renderAgent();
}

// ③. The link is opened by setting location — a custom scheme does not
// unload the page; the browser hands it to whatever is registered for it and
// stays where it is. Then the new row is watched: a fresh registration has
// no `last_seen`, so the first one that appears is the program having come
// in with the token it was just handed. Eight seconds without one and the
// connect code is shown instead, with the same string in it.
async function connectThisPc() {
  if (!state.keys) return;
  if (somePcConnected() && !confirm(t('settings.pc.connectAnother'))) return;
  const status = $('pc-connect-status');
  if (connecting) connecting.abort();
  const watch = new AbortController();
  connecting = watch;
  try {
    fallbackOpen = false;
    const code = await makeConnectCode();
    status.textContent = t('settings.pc.connecting');
    record('pc: opening pair link');
    location.href = code;

    const until = Date.now() + 8000;
    let heard = false;
    while (Date.now() < until && !watch.signal.aborted) {
      await new Promise((r) => setTimeout(r, 1000));
      try { await pollAgent(); } catch (_) { /* a blip; try again in a second */ }
      const mine = registeredPcs().find((pc) => String(pc.id) === String(freshId));
      if (mine && mine.last_seen) { heard = true; break; }
    }
    if (watch.signal.aborted) return;
    if (heard) {
      status.textContent = t('settings.pc.connectDone');
      record('pc: connected');
    } else {
      status.textContent = '';
      fallbackOpen = true;
      record('pc: link not picked up; showing the code');
    }
    renderAgent();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    if (connecting === watch) connecting = null;
  }
}

// Whether this device can actually receive a notification. Asked of the browser
// rather than of the server, because the question is about the phone in the
// hand, not about whether some other device was once registered.
async function deviceIsRegistered() {
  try {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.pushManager) return false;
    return Boolean(await reg.pushManager.getSubscription());
  } catch (_) { return false; }
}

const langWasSeen = () => {
  try { return localStorage.getItem('taskboard.langSeen') === '1'; } catch (_) { return false; }
};

function orderSettings() {
  const panel = $('settings');
  const order = settingsOrder({
    pushDone: state.pushReady === true,
    hookDone: (state.board.seenNames || []).length > 0,
    langSeen: langWasSeen(),
  });
  for (const id of order) {
    const section = document.getElementById(id);
    if (section) panel.append(section);
  }
}

// The key opens everything on this board, so it does not sit on screen. It is
// shown only when asked for, and covers itself again on every return to this
// panel — a phone put down on a table is the case this is for.
let keyShown = false;
function drawKey() {
  if (!state.keys) return;
  const real = toB64(state.keys.master);
  $('hook-key').value = keyShown ? real : '•'.repeat(real.length);
  $('reveal-hook-key').textContent = t(keyShown ? 'settings.hook.hide' : 'settings.hook.reveal');
}

function renderHook() {
  $('hook-url').value = state.board.webhookToken
    ? `${location.origin}/hook/${state.board.webhookToken}`
    : t('settings.hook.none');

  // Shown only once there is a key to show. It is the master key: with it the
  // PC can seal a name so the server can match it without reading it.
  const locked = $('hook-locked');
  if (locked) locked.hidden = !lockedOut();

  const block = $('hook-key-block');
  block.hidden = !state.keys;
  keyShown = false;
  drawKey();
}

function renderStates() {
  const list = $('state-list');
  list.replaceChildren();
  for (const st of state.board.states) list.append(stateEditor(st));
}

function renderSlots() {
  renderSeenNames();
  const slots = $('slot-list');
  slots.replaceChildren();
  for (const task of state.board.tasks) slots.append(slotEditor(task));
}

// What the board has actually been told, as opposed to what someone believes
// the session is called. A name typed from memory is where this fails, and it
// fails silently, so the real ones are put in front of the field.
function renderSeenNames() {
  const seen = state.board.seenNames || [];
  const list = $('seen-list');
  list.replaceChildren();
  for (const row of seen) {
    const option = document.createElement('option');
    option.value = row.name;
    list.append(option);
  }

  const note = $('seen-names');
  note.replaceChildren();
  if (seen.length === 0) {
    note.textContent = t('settings.slots.nothingYet');
    return;
  }
  note.append(document.createTextNode(t('settings.slots.seen')));
  for (const row of seen.slice(0, 8)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = row.name;
    chip.title = t('settings.slots.hits', { n: row.hits });
    chip.addEventListener('click', () => copyText(row.name,
      t('settings.slots.copiedName', { name: row.name })));
    note.append(chip);
  }
}

// Says so in place rather than redrawing the row, which would be the same as
// redrawing the list as far as unsaved neighbours are concerned.
function flash(node, message) {
  node.textContent = message;
  setTimeout(() => { if (node.textContent === message) node.textContent = ''; }, 2500);
}

// Saving one row used to redraw the whole list it was in. Two things went wrong
// at once: every other row was rebuilt from the board, so anything typed into
// them and not yet saved was thrown away — and the "Saved" message was written
// to the row that had just been replaced, so it was never seen.
//
// So a row no longer redraws its own list. What can go stale when it does not
// is a name repeated elsewhere: a state named in the other rows' dropdowns, a
// page named on the buttons that move a square across. Those are relabelled
// here, in place, leaving everything anyone has typed alone.
function relabelState(id, name) {
  for (const option of document.querySelectorAll(`#settings option[data-state-id="${id}"]`)) {
    option.textContent = name;
  }
}

function relabelPage(id, name) {
  for (const button of document.querySelectorAll(`#settings button[data-page-id="${id}"]`)) {
    button.textContent = t(button.dataset.i18nKey, { page: name || t('settings.pages.head') });
  }
}

function field(labelText, control) {
  const label = document.createElement('label');
  label.textContent = labelText;
  label.append(control);
  return label;
}

function stateSelect(selected, allowNone = true) {
  const sel = document.createElement('select');
  if (allowNone) {
    const none = document.createElement('option');
    none.value = ''; none.textContent = t('settings.states.none');
    sel.append(none);
  }
  for (const s of state.board.states) {
    const opt = document.createElement('option');
    opt.value = String(s.id); opt.textContent = s.name;
    opt.dataset.stateId = String(s.id);      // so a rename can find it again
    if (String(s.id) === String(selected)) opt.selected = true;
    sel.append(opt);
  }
  return sel;
}

// What to call a PC on screen. The program says what the machine is called the
// first time it connects; until then all there is is the browser's guess at
// registration, and the hand route does not even make that.
const pcName = (pc) => pc.name || t('settings.pc.unnamed');

// Which PC a command square runs on. Empty is every PC that is switched on,
// which is what every square means until someone chooses otherwise. A square
// may also be left naming a PC that has since been unregistered — pressing it
// then fails, which is the point — so that is offered here as itself rather
// than reading as "all of them" and becoming that on the next save.
function fillPcSelect(sel, selected) {
  const all = document.createElement('option');
  all.value = ''; all.textContent = t('settings.command.pcAll');
  const options = [all];
  const pcs = state.board.agents || [];
  for (const pc of pcs) {
    const opt = document.createElement('option');
    opt.value = String(pc.id); opt.textContent = pcName(pc);
    if (String(pc.id) === String(selected)) opt.selected = true;
    options.push(opt);
  }
  if (selected && !pcs.some((pc) => String(pc.id) === String(selected))) {
    const gone = document.createElement('option');
    gone.value = String(selected); gone.textContent = t('settings.command.pcGone');
    gone.selected = true;
    options.push(gone);
  }
  sel.replaceChildren(...options);
}

function pcSelect(selected) {
  const sel = document.createElement('select');
  sel.className = 'pc-pick';           // so a PC coming or going can find it again
  fillPcSelect(sel, selected);
  return sel;
}

// A PC registered or removed while the settings are open changes what every
// square's picker should offer. The rows themselves are deliberately not
// redrawn — see relabelState — because that would throw away whatever has been
// typed into them and not yet saved; only the options are rebuilt, and each
// picker keeps what it was set to.
//
// Only when the PCs have actually changed. This is reached from the few-second
// poll as well, and rebuilding the options of a list somebody is at that moment
// choosing from would shut it in their face.
let pcListNow = null;
function relistPcs() {
  const signature = JSON.stringify((state.board.agents || []).map((pc) => [pc.id, pc.name]));
  if (signature === pcListNow) return;
  pcListNow = signature;
  for (const sel of document.querySelectorAll('#settings select.pc-pick')) {
    fillPcSelect(sel, sel.value);
  }
}

function stateEditor(st) {
  const wrap = document.createElement('div');
  wrap.className = 'editor';

  const name = document.createElement('input');
  name.value = st.name || '';
  const colour = document.createElement('input');
  colour.type = 'color'; colour.value = st.colour || '#6b7280';
  const left = stateSelect(st.left_to);
  const right = stateSelect(st.right_to);
  const auto = stateSelect(st.auto_to);
  const start = stateSelect(st.start_to);
  const timer = document.createElement('input');
  timer.type = 'checkbox'; timer.checked = Boolean(st.runs_timer);

  const fields = document.createElement('div');
  fields.className = 'fields';
  fields.append(
    field(t('settings.states.name'), name),
    field(t('settings.states.colour'), colour),
    field(t('settings.states.left'), left),
    field(t('settings.states.right'), right),
    field(t('settings.states.auto'), auto),
    field(t('settings.states.start'), start),
    field(t('settings.states.timer'), timer),
  );

  const save = document.createElement('button');
  save.textContent = t('settings.save');
  save.addEventListener('click', async () => {
    try {
      state.board = await api('/api/state', {
        id: st.id,
        name: state.keys ? `#${st.id}` : name.value,
        ...(state.keys ? { nameCipher: await sealText(name.value) } : {}),
        colour: colour.value, runsTimer: timer.checked,
        leftTo: left.value, rightTo: right.value, autoTo: auto.value, startTo: start.value,
        sortOrder: st.sort_order,
      });
      // The list this row sits in is deliberately not redrawn — see relabelState.
      relabelState(st.id, name.value);
      renderBoard();
      flash(note, t('settings.saved'));
    } catch (err) {
      flash(note, err.message);
    }
  });

  const remove = document.createElement('button');
  remove.className = 'ghost'; remove.textContent = t('settings.delete');
  remove.addEventListener('click', async () => {
    if (!confirm(t('settings.states.removeConfirm', { name: st.name }))) return;
    try {
      state.board = await api('/api/state/delete', { id: st.id });
      renderStates(); renderBoard();
    } catch (err) { flash(note, err.message); }
  });

  const note = document.createElement('span');
  note.className = 'note';

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(note, remove, save);

  wrap.append(fields, actions);
  return wrap;
}

function slotEditor(task) {
  const wrap = document.createElement('div');
  wrap.className = 'editor';

  const title = document.createElement('input');
  title.value = task.title || '';
  title.placeholder = t('board.square', { n: task.slot + 1 });
  const key = document.createElement('input');
  key.value = task.match_key || '';
  key.placeholder = t('settings.slots.sessionHint');
  key.setAttribute('list', 'seen-list');
  const minutes = document.createElement('input');
  minutes.type = 'number'; minutes.min = '0';
  minutes.value = task.expected_seconds > 0 ? Math.round(task.expected_seconds / 60) : 
    (task.expected_seconds === 0 ? '0' : '');
  minutes.placeholder = t('settings.slots.minutes');

  const fields = document.createElement('div');
  fields.className = 'fields';
  fields.append(
    field(t('settings.slots.title', { n: task.slot + 1 }), title),
    field(t('settings.slots.session'), key),
    field(t('settings.slots.duration'), minutes),
  );
  fields.firstChild.classList.add('wide');

  const command = commandEditor(task);

  const save = document.createElement('button');
  save.textContent = t('settings.save');
  save.addEventListener('click', async () => {
    try {
      const sealedName = await sealName(key.value);
      const chosen = command.read();
      state.board = await api('/api/task', {
        taskId: task.id, page: state.board.page,
        title: state.keys ? '' : title.value,
        matchKey: state.keys ? '' : key.value,
        expectedSeconds: minutes.value === '' ? '' : Number(minutes.value) * 60,
        ...(state.keys ? { titleCipher: await sealText(title.value), ...sealedName } : {}),
        // Only from a device that can seal: an unencrypted board cannot carry
        // a command, and a locked-out device must not overwrite one it cannot
        // read with nothing.
        ...(chosen ? {
          commandSealed: chosen.command ? await sealText(JSON.stringify(chosen.command)) : null,
          // Not sealed either: whether the PC's answer rings the phone. A
          // stream marker does not (T-500 = B); every other kind does. It says
          // only that, never what the command is.
          quiet: Boolean(chosen.command && chosen.command.kind === 'marker'),
          runStateId: chosen.run, okStateId: chosen.ok, failStateId: chosen.fail,
          // Not sealed: the board has to read this one to know where to send.
          // It says which PC, never what the instruction is.
          agentId: chosen.pc,
        } : {}),
      });
      // Board only. The rows keep what has been typed into them.
      renderHook(); renderBoard();
      flash(note, t('settings.saved'));
    } catch (err) {
      flash(note, err.message);
    }
  });

  const note = document.createElement('span');
  note.className = 'note';

  const remove = document.createElement('button');
  remove.className = 'ghost';
  remove.textContent = t('settings.slots.remove');
  remove.addEventListener('click', async () => {
    if (!confirm(t('settings.slots.removeConfirm',
      { what: task.title || t('board.square', { n: task.slot + 1 }) }))) return;
    state.board = await api('/api/slot/delete', { taskId: task.id, page: state.board.page });
    renderSlots(); renderBoard();
  });

  // Sliding a square up or down the page. Offered only where there is somewhere
  // to go, so the first square has no way up and the last none down — a button
  // that does nothing is worse than one that is not there.
  const order = [];
  const here = state.board.tasks.findIndex((t) => t.id === task.id);
  for (const [offset, direction, key] of [
    [-1, 'earlier', 'settings.slots.earlier'],
    [1, 'later', 'settings.slots.later'],
  ]) {
    if (!state.board.tasks[here + offset]) continue;
    const button = document.createElement('button');
    button.className = 'ghost';
    button.textContent = t(key);
    button.addEventListener('click', async () => {
      try {
        state.board = await api('/api/slot/reorder', {
          taskId: task.id, direction, page: state.board.page,
        });
        renderSlots(); renderBoard();
      } catch (err) {
        flash(note, err.message);
      }
    });
    order.push(button);
  }

  // Moving a square to the page on either side. The button carries the name of
  // where it is going rather than a direction, because "next page" tells you
  // nothing about which board you are about to send it to — and a square that
  // vanishes to somewhere unnamed is hard to go and find again.
  const moves = [];
  const pages = state.board.pages || [];
  const at = pages.findIndex((p) => String(p.id) === String(state.board.page));
  if (at >= 0) {
    for (const [offset, key] of [[-1, 'settings.slots.movePrev'], [1, 'settings.slots.moveNext']]) {
      const to_ = pages[at + offset];
      if (!to_) continue;                      // nothing on that side; no button
      const button = document.createElement('button');
      button.className = 'ghost';
      button.textContent = t(key, { page: to_.name || t('settings.pages.head') });
      button.dataset.pageId = String(to_.id);   // so a rename can find it again
      button.dataset.i18nKey = key;
      button.addEventListener('click', async () => {
        try {
          state.board = await api('/api/slot/move', {
            taskId: task.id, toPage: to_.id, page: state.board.page,
          });
          // The square has left this page, so the list it was in is redrawn
          // without it, and the board behind the settings loses it too.
          renderSlots(); renderBoard();
        } catch (err) {
          flash(note, err.message);
        }
      });
      moves.push(button);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(note, ...order, ...moves, remove, save);

  wrap.append(fields, command.node, actions);
  return wrap;
}

// Where a command square goes if its own three pickers are left empty: the
// shape a fresh board has. The first state's instruction arrow (処理中), that
// state's stop arrow (待機中), and the first state's right-tap arrow (停止中).
// The server resolves an empty picker the same way, so what is shown here is
// what will happen.
function commandDefaults() {
  const first = state.board.states[0];
  const run = first ? first.start_to : null;
  const running = run ? stateById(run) : null;
  return {
    run,
    ok: running ? running.auto_to : null,
    fail: first ? first.right_to : null,
  };
}

// The command part of a square's editor. Returns the node to put in the row
// and a `read()` that gives back what was chosen — or null when this device
// is not allowed to change it, so the save leaves the command alone.
function commandEditor(task) {
  const node = document.createElement('div');
  node.className = 'fields command';

  const head = document.createElement('p');
  head.className = 'head';
  head.textContent = t('settings.command.head');
  node.append(head);

  // Two reasons this cannot be edited here, and they need different words:
  // a board that is not encrypted (turn it on), and a device that cannot read
  // an encrypted board (sign in again with the password).
  const blocked = !state.keys;
  if (blocked) {
    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = t(lockedOut() ? 'settings.command.locked' : 'settings.command.needsEncryption');
    node.append(why);
    node.classList.add('off');
  }

  const current = task.command || { kind: '', args: {} };
  const args = current.args || {};

  const kind = document.createElement('select');
  for (const value of ['', ...COMMAND_KINDS]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = t(`settings.command.kind.${value || 'none'}`);
    if (value === current.kind) opt.selected = true;
    kind.append(opt);
  }

  const text = (placeholderKey, value) => {
    const input = document.createElement('input');
    input.placeholder = t(placeholderKey);
    input.value = value || '';
    return input;
  };
  const open = text('settings.command.open', args.target);
  const url = text('settings.command.url', args.url);
  // `example.com` becomes `https://example.com` the moment the field is left,
  // so what will be saved is what is on screen. Not type=url: that would
  // mark the bare form invalid before it has been tidied.
  url.addEventListener('change', () => { url.value = normalizeUrl(url.value); });
  const hotkey = text('settings.command.hotkey', args.keys);

  // Typing a line. The game picker only fills the key box — it is not saved,
  // so opening this square again shows no game and the key that was kept.
  const textGame = document.createElement('select');
  for (const [name] of TEXT_GAMES) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = t(`settings.command.textGame.${name || 'none'}`);
    textGame.append(opt);
  }
  const textKey = text('settings.command.textKey', args.key);
  // Not trimmed on the way out: what is typed is typed, spaces and all.
  const textLine = text('settings.command.text', args.text);
  textGame.addEventListener('change', () => {
    const found = TEXT_GAMES.find(([name]) => name === textGame.value);
    if (found && found[1]) textKey.value = found[1];
  });
  // How the line is typed (T-087): the whole line in one go (the default,
  // T-092), or one character at a time. Per square; a square saved before
  // there was a choice reads as the default (public/pair.js textMode).
  const typing = document.createElement('select');
  for (const mode of TEXT_MODES) {
    const opt = document.createElement('option');
    opt.value = mode;
    opt.textContent = t(`settings.command.textMode.${mode}`);
    if (mode === textMode(args)) opt.selected = true;
    typing.append(opt);
  }

  // A stream marker's label, held to MARKER_LABEL_MAX characters as it is
  // typed (public/pair.js). Optional.
  const markerText = text('settings.command.markerLabel', args.label);
  markerText.addEventListener('input', () => {
    const kept = markerLabel(markerText.value);
    if (kept !== markerText.value) markerText.value = kept;
  });

  const obsOp = document.createElement('select');
  for (const op of OBS_OPS) {
    const opt = document.createElement('option');
    opt.value = op;
    opt.textContent = t(`settings.command.obs.${op}`);
    if (op === args.op) opt.selected = true;
    obsOp.append(opt);
  }
  // Recording and streaming take start/stop/toggle; a scene or a source takes
  // a name. One field of each, and the right one is shown for the action.
  const obsName = text('settings.command.obsScene', args.arg);
  const obsSwitch = document.createElement('select');
  for (const value of ['start', 'stop', 'toggle']) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = t(`settings.command.${value}`);
    if (value === args.arg) opt.selected = true;
    obsSwitch.append(opt);
  }
  // Showing and hiding a source needs its own three fields rather than the
  // shared name box: it wants a scene *and* a source, and switching to it
  // must not overwrite the scene name typed for 「シーン切替」.
  const visScene = text('settings.command.obsScene', args.scene);
  const visSource = text('settings.command.obsItem', args.source);
  const visState = document.createElement('select');
  for (const [value, word] of OBS_VISIBLE_STATES) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = t(`settings.command.${word}`);
    if (value === args.arg) opt.selected = true;
    visState.append(opt);
  }

  const defaults = commandDefaults();
  const run = stateSelect(task.run_state_id || defaults.run);
  const ok = stateSelect(task.ok_state_id || defaults.ok);
  const fail = stateSelect(task.fail_state_id || defaults.fail);
  const pc = pcSelect(task.agent_id);

  const rows = {
    kind: field(t('settings.command.kind'), kind),
    open: field(t('settings.command.open'), open),
    url: field(t('settings.command.url'), url),
    hotkey: field(t('settings.command.hotkey'), hotkey),
    textGame: field(t('settings.command.textGame'), textGame),
    textKey: field(t('settings.command.textKey'), textKey),
    text: field(t('settings.command.text'), textLine),
    textMode: field(t('settings.command.textMode'), typing),
    obsOp: field(t('settings.command.obsOp'), obsOp),
    obsName: field(t('settings.command.obsScene'), obsName),
    obsSwitch: field(t('settings.command.obsSwitch'), obsSwitch),
    visScene: field(t('settings.command.obsScene'), visScene),
    visSource: field(t('settings.command.obsItem'), visSource),
    visState: field(t('settings.command.obsVisible'), visState),
    markerLabel: field(t('settings.command.markerLabel'), markerText),
    pc: field(t('settings.command.pc'), pc),
    run: field(t('settings.command.runState'), run),
    ok: field(t('settings.command.okState'), ok),
    fail: field(t('settings.command.failState'), fail),
  };
  // A sentence under each field saying what goes in it and where to get it,
  // for someone who does not know what a path or a hotkey is. The OBS one
  // sits under the action picker, since the rest of that block changes with
  // the action.
  const hints = {};
  for (const name of ['open', 'url', 'hotkey', 'text', 'obs', 'obsVisible']) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.innerHTML = t(`settings.command.hint.${name}`);
    hints[name] = hint;
  }
  for (const [name, row] of Object.entries(rows)) {
    if (['kind', 'open', 'url', 'hotkey', 'textKey', 'text', 'markerLabel'].includes(name)) row.classList.add('wide');
    node.append(row);
    if (hints[name]) node.append(hints[name]);
    if (name === 'obsOp') node.append(hints.obs);
    // Where to read the two names off, and what happens when a scene holds
    // two of the same name — under the fields it is about.
    if (name === 'visState') node.append(hints.obsVisible);
  }

  // Only the fields the chosen kind uses are on show; the rest keep their
  // values out of sight, so switching kinds and back loses nothing typed.
  const show = () => {
    const k = kind.value;
    for (const name of ['open', 'url', 'hotkey', 'text']) {
      rows[name].hidden = k !== name;
      hints[name].hidden = k !== name;
    }
    // The game picker and the key sit with the line they belong to.
    rows.textGame.hidden = k !== 'text';
    rows.textKey.hidden = k !== 'text';
    rows.textMode.hidden = k !== 'text';
    const obs = k === 'obs';
    hints.obs.hidden = !obs;
    const op = obsOp.value;
    const named = obs && (op === 'scene' || op === 'mute');
    const visible = obs && op === 'visible';
    rows.obsOp.hidden = !obs;
    rows.obsName.hidden = !named;
    rows.obsSwitch.hidden = !(obs && (op === 'record' || op === 'stream'));
    for (const name of ['visScene', 'visSource', 'visState']) rows[name].hidden = !visible;
    hints.obsVisible.hidden = !visible;
    rows.markerLabel.hidden = k !== 'marker';
    if (named) {
      const label = t(obsOp.value === 'scene' ? 'settings.command.obsScene' : 'settings.command.obsSource');
      rows.obsName.firstChild.textContent = label;
      obsName.placeholder = label;
    }
    for (const name of ['pc', 'run', 'ok', 'fail']) rows[name].hidden = !k;
  };
  kind.addEventListener('change', show);
  obsOp.addEventListener('change', show);
  show();

  if (blocked) {
    for (const control of node.querySelectorAll('input, select')) control.disabled = true;
  }

  const read = () => {
    if (blocked) return null;
    const k = kind.value;
    let command = null;
    if (k === 'open') command = { kind: k, args: { target: open.value.trim() } };
    if (k === 'url') {
      url.value = normalizeUrl(url.value);
      command = { kind: k, args: { url: url.value } };
    }
    if (k === 'hotkey') command = { kind: k, args: { keys: hotkey.value.trim() } };
    if (k === 'text') {
      // Too long a line cannot succeed — the PC is still typing when the board
      // gives up on it (public/pair.js, TEXT_MAX) — so the square is not saved
      // in a shape that fails every time it is pressed. Thrown rather than
      // returned: the save is already wrapped, and this lands in the same
      // place as everything else that stops a save.
      if (textTooLong(textLine.value)) throw new Error(t('settings.command.textTooLong', { n: TEXT_MAX }));
      command = { kind: k, args: { key: textKey.value.trim(), text: textLine.value, mode: typing.value } };
    }
    if (k === 'obs') {
      const op = obsOp.value;
      // Three values for `visible`, two for the rest — and the rest are left
      // byte for byte as they were, so a square saved before today still
      // reads back the same (docs/DECK_AGENT_PROTOCOL.md §3).
      if (op === 'visible') {
        command = { kind: k, args: { op, scene: visScene.value.trim(), source: visSource.value.trim(), arg: visState.value } };
      } else {
        const arg = op === 'scene' || op === 'mute' ? obsName.value.trim() : obsSwitch.value;
        command = { kind: k, args: { op, arg } };
      }
    }
    if (k === 'marker') command = { kind: k, args: { label: markerLabel(markerText.value.trim()) } };
    return { command, run: run.value, ok: ok.value, fail: fail.value, pc: pc.value };
  };

  return { node, read };
}

/* ------------------------------------------------------------------- keys */

async function useMaster(masterRaw) {
  state.keys = { master: masterRaw, ...(await subKeysFrom(masterRaw)) };
  // Left where the service worker can find it: a notification arrives with no
  // page open, and it has to be made readable before it can be shown.
  try { await rememberMaster(masterRaw); } catch (_) {}
}

function askRecoveryKey() {
  return new Promise((resolve) => {
    const dialog = $('recover-dialog');
    $('recover-key').value = '';
    $('recover-status').textContent = '';
    const done = (value) => {
      $('recover-ok').removeEventListener('click', ok);
      $('recover-cancel').removeEventListener('click', cancel);
      try { dialog.close(); } catch (_) { dialog.removeAttribute('open'); }
      resolve(value);
    };
    const ok = () => done($('recover-key').value.trim());
    const cancel = () => done(null);
    $('recover-ok').addEventListener('click', ok);
    $('recover-cancel').addEventListener('click', cancel);
    try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); }
  });
}

// Signed in, but the wrapping was made from a password that is no longer the
// one being used — the shape a reset leaves behind. The recovery key opens the
// master key, and it is immediately re-wrapped under the password that has just
// been typed, so this is asked for once rather than at every sign-in. The
// recovery key is replaced at the same time: it has now been written into a
// box on a screen, so the one on paper is retired.
async function recoverWithKey(keys, password) {
  for (;;) {
    const typed = await askRecoveryKey();
    if (!typed) return false;

    let master;
    try {
      master = await unlockWithRecovery(typed, keys.wrappedByRecovery);
    } catch (_) {
      $('login-error').textContent = t('recover.wrong');
      continue;                                  // ask again rather than give up
    }

    await useMaster(master);
    const wrap = await rewrapForPassword(master, password);
    const fresh = await rewrapForRecovery(master);
    await api('/api/account/rewrap', {
      kdfSalt: wrap.kdfSalt,
      wrappedByPassword: wrap.wrappedByPassword,
      wrappedByRecovery: fresh.wrappedByRecovery,
      // The salt changed, so what the server should expect at the next sign-in
      // changed with it. Sending one without the other would lock this account
      // out the moment the page is closed.
      authToken: wrap.authToken,
    });
    $('login-error').textContent = '';
    await showRecoveryKey(fresh.recoveryKey, t('recover.done'));
    return true;
  }
}

// 「保存しました」 is not pressable until the key has been copied or
// downloaded and the box saying what losing it means is ticked (T-081,
// BETA_AUDIT B4: the dialog used to close on one press with nothing saved).
// Copying counts when the button is pressed, whether the clipboard took it
// or the text was only selected for copying by hand: the browser cannot see
// what happens after that, and the key is never asked to be typed back.
function showRecoveryKey(recoveryB64, note) {
  return new Promise((resolve) => {
    const dialog = $('recovery-dialog');
    if (note) dialog.querySelector('.note').textContent = note;
    $('recovery-key').value = recoveryB64;
    $('recovery-status').textContent = '';
    $('recovery-understood').checked = false;
    let saved = false;
    const gate = () => {
      $('recovery-ok').disabled = !(saved && $('recovery-understood').checked);
      $('recovery-why').hidden = saved;
    };
    gate();

    const done = () => {
      $('recovery-ok').removeEventListener('click', onOk);
      $('recovery-copy').removeEventListener('click', onCopy);
      $('recovery-download').removeEventListener('click', onDownload);
      $('recovery-understood').removeEventListener('change', gate);
      if (dialog.open) dialog.close();
      resolve();
    };
    const onOk = (e) => { e.preventDefault(); if (!$('recovery-ok').disabled) done(); };
    const onCopy = async (e) => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(recoveryB64);
        $('recovery-status').textContent = t('recovery.copied');
      } catch (_) {
        $('recovery-key').select();
        $('recovery-status').textContent = t('recovery.selected');
      }
      saved = true;
      gate();
    };
    // One line, in a file the browser saves where downloads go. The object
    // URL is let go once the click has been handed over.
    const onDownload = (e) => {
      e.preventDefault();
      const url = URL.createObjectURL(new Blob([recoveryB64 + '\n'], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'multitasker-recovery-key.txt';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      $('recovery-status').textContent = t('recovery.downloaded');
      saved = true;
      gate();
    };
    $('recovery-ok').addEventListener('click', onOk);
    $('recovery-copy').addEventListener('click', onCopy);
    $('recovery-download').addEventListener('click', onDownload);
    $('recovery-understood').addEventListener('change', gate);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });
}

/* ------------------------------------------------------------------ pages */

function openPages() {
  const list = $('page-choices');
  list.replaceChildren();
  for (const page of state.board.pages) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'page-choice' + (String(page.id) === String(state.board.page) ? ' current' : '');
    button.textContent = page.name;
    button.addEventListener('click', async () => {
      $('page-dialog').close();
      state.board = await api(`/api/board?page=${encodeURIComponent(page.id)}`);
      rememberPage(state.board.page);
      renderBoard();
      renderPageButton();
    });
    list.append(button);
  }
  const dialog = $('page-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function renderPages() {
  const list = $('page-list');
  list.replaceChildren();
  for (const page of state.board.pages) list.append(pageEditor(page));

  const current = state.board.pages.find((p) => String(p.id) === String(state.board.page));
  $('slot-page-label').textContent = current
    ? t('settings.slots.thisPage', { page: current.name })
    : '';
}

function pageEditor(page) {
  const wrap = document.createElement('div');
  wrap.className = 'editor';

  const name = document.createElement('input');
  name.value = page.name;

  const fields = document.createElement('div');
  fields.className = 'fields';
  fields.append(field(t('settings.pages.name'), name));
  fields.firstChild.classList.add('wide');

  const note = document.createElement('span');
  note.className = 'note';

  const save = document.createElement('button');
  save.textContent = t('settings.save');
  save.addEventListener('click', async () => {
    try {
      state.board = await api('/api/page', {
        id: page.id,
        name: state.keys ? '' : name.value,
        ...(state.keys ? { nameCipher: await sealText(name.value) } : {}),
      });
      // The list this row sits in is deliberately not redrawn — see relabelPage.
      relabelPage(page.id, name.value);
      renderPageButton();
      flash(note, t('settings.saved'));
    } catch (err) { flash(note, err.message); }
  });

  const remove = document.createElement('button');
  remove.className = 'ghost';
  remove.textContent = t('settings.delete');
  remove.addEventListener('click', async () => {
    if (!confirm(t('settings.pages.removeConfirm', { name: page.name }))) return;
    try {
      state.board = await api('/api/page/delete', { id: page.id });
      rememberPage(state.board.page);
      renderPages(); renderSlots(); renderBoard(); renderPageButton();
    } catch (err) { flash(note, err.message); }
  });

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(note, remove, save);

  wrap.append(fields, actions);
  return wrap;
}

// Swiping sideways moves between pages, and the board follows the finger while
// it happens so the gesture has something to show for itself.
//
// Listened for on the document rather than on any element: a short page leaves
// the board element well above the bottom of the screen, and a swipe made down
// there would land on nothing at all.
function enableSwipe() {
  const onBoard = () => !$('board-screen').hidden;
  const grid = () => $('grid');

  let startX = 0;
  let startY = 0;
  let sliding = false;
  let swallowClick = false;

  // Damped, so the board leans with the finger rather than chasing it — there
  // is no second page rendered behind, and a full-speed follow would show the
  // empty space beside it.
  const DRAG = 0.35;

  function slide(x, animate) {
    const g = grid();
    g.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    g.style.transform = x ? `translateX(${x}px)` : '';
  }

  const pageIndex = () =>
    state.board.pages.findIndex((p) => String(p.id) === String(state.board.page));

  async function goTo(offset) {
    // The pages go round: past the last is the first, before the first is the
    // last (public/swipe.js). Only a single page goes nowhere.
    const to = pageAfterSwipe(pageIndex(), offset, state.board.pages.length);
    if (to < 0) { slide(0, true); return false; }

    // Out to the side, swap, then in from the other side.
    slide(-offset * window.innerWidth * DRAG, true);
    state.board = await api(`/api/board?page=${encodeURIComponent(state.board.pages[to].id)}`);
    rememberPage(state.board.page);
    renderBoard();
    renderPageButton();

    slide(offset * window.innerWidth * DRAG, false);
    requestAnimationFrame(() => slide(0, true));
    return true;
  }

  document.addEventListener('touchstart', (e) => {
    if (!onBoard() || e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    sliding = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!onBoard() || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    // Sideways only once it is clearly sideways, so scrolling stays scrolling.
    if (!sliding && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) sliding = true;
    if (sliding) slide(dx * DRAG, false);
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!onBoard() || !sliding) return;
    const dx = ((e.changedTouches[0] || {}).clientX || startX) - startX;
    sliding = false;

    // A swipe that ends as a swipe must not also land as a tap on a square.
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 400);

    if (Math.abs(dx) < 60) { slide(0, true); return; }
    goTo(dx < 0 ? 1 : -1).catch(() => slide(0, true));
  });

  // Capture phase, so it runs before the square's own handler.
  document.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

enableSwipe();

/* ------------------------------------------------------------------- push */

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  const status = $('push-status');
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    status.textContent = standalone
      ? t('settings.push.unsupported')
      : t('settings.push.iosHint');
    return;
  }
  if (!state.me.pushConfigured) {
    status.textContent = t('settings.push.noKeys');
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { type: 'module' });
    if ((await Notification.requestPermission()) !== 'granted') {
      status.textContent = t('settings.push.denied');
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.me.vapidPublicKey),
    });
    await api('/api/push/subscribe', sub.toJSON());
    status.textContent = t('settings.push.registered');
    state.pushReady = true;
    orderSettings();
  } catch (err) {
    status.textContent = t('settings.push.failed', { error: err.message });
  }
}

/* ------------------------------------------------------------------ wiring */

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const password = $('password').value;

  try {
    if (state.registering) {
      // The keys are made here and the wrapped forms are sent; the password
      // itself is the only thing that could open them, and it is never stored.
      // The server cannot check this any more — it only ever sees a derived
      // proof, which is the same length whatever was typed. So it is checked
      // here, before the keys are made from it.
      if (password.length < PASSWORD_MIN) {
        throw new Error(t('settings.account.tooShort', { n: PASSWORD_MIN }));
      }
      // Checked before the keys are made. A password mistyped here is not a
      // password anyone can reproduce, so the account would exist and open for
      // nobody — with the recovery key as the only way in, on a board whose
      // owner has not yet been told to keep one.
      if (password !== $('password-again').value) {
        throw new Error(t('login.passwordMismatch'));
      }
      $('login-error').textContent = t('login.makingKeys');
      const keys = await createKeys(password);
      await api('/api/register', {
        // The password itself does not leave this browser. What goes out cannot
        // unwrap anything, which is the whole point.
        email: $('email').value, password: keys.authToken, invite: $('invite').value.trim(),
        kdfSalt: keys.kdfSalt,
        wrappedByPassword: keys.wrappedByPassword,
        wrappedByRecovery: keys.wrappedByRecovery,
        // The recovery key needs a proof of its own, or it can open the board
        // but never get through the front door when the password is forgotten.
        recoveryToken: keys.recoveryToken,
      });
      await useMaster(keys.masterRaw);
      $('login-error').textContent = '';
      await showRecoveryKey(keys.recoveryKey);
      await boot();
      return;
    }

    $('login-error').textContent = t('login.unlocking');
    // The salt has to come first: without it there is nothing to derive from.
    // It is not a secret — it is a random number that opens nothing by itself.
    const { kdfSalt } = await api('/api/prelogin', { email: $('email').value });
    const result = await api('/api/login', {
      email: $('email').value, password: await authTokenFor(password, kdfSalt),
    });
    $('login-error').textContent = '';

    const keys = result.keys || {};
    if (keys.encryptionVersion === 1) {
      try {
        await useMaster(await unlockWithPassword(password, keys.kdfSalt, keys.wrappedByPassword));
      } catch (_) {
        // The password signed us in, so the account exists; if it will not open
        // the key, the key was wrapped under a different one — a reset without
        // the recovery key, most likely.
        $('login-error').textContent = t('login.needRecovery');
        await recoverWithKey(keys, password);
      }
    }

    await boot();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

// Where 「使い方（動画）」 on the login screen points. Empty until there is a
// video: while it is empty the link is not shown at all.
const HOW_TO_VIDEO_URL = '';

function renderLogin() {
  $('how-to-video').hidden = !HOW_TO_VIDEO_URL;
  $('how-to-video-link').href = HOW_TO_VIDEO_URL;
  $('login-submit').textContent = t(state.registering ? 'login.register' : 'login.submit');
  $('register-toggle').textContent = t(state.registering ? 'login.toLogin' : 'login.toRegister');
  $('password-again').hidden = !state.registering;
  $('password').setAttribute('autocomplete', state.registering ? 'new-password' : 'current-password');
  $('invite').hidden = !(state.registering && state.me && state.me.needsInvite);
}

// Forgetting the password used to mean asking whoever runs the site for a
// reset link — no use to someone whose board is on their phone at two in the
// morning, and the recovery key they were told to save did nothing for them.
//
// It does now. The key proves who is asking (down a branch that opens nothing,
// so what the server keeps is no more use to it than the password's proof), and
// then opens the master key here. A new password is set in the same breath,
// because a way in that leaves the account openable by a key on a piece of
// paper and nothing else is only half a way back.
$('forgot').addEventListener('click', async () => {
  const email = $('email').value.trim();
  if (!email) {
    $('login-error').textContent = t('login.forgotNeedsEmail');
    return;
  }

  const typed = await askRecoveryKey();
  if (!typed) return;

  $('login-error').textContent = t('login.recovering');
  try {
    const result = await api('/api/account/recover', {
      email, recoveryToken: await recoveryTokenFor(typed),
    });
    const keys = result.keys || {};
    const master = await unlockWithRecovery(typed, keys.wrappedByRecovery);
    await useMaster(master);

    // Straight to a new password. The old one is gone and unknowable, so the
    // wrapping made from it is dead weight; leaving it would mean signing in
    // with the recovery key every time.
    const chosen = await askNewPassword();
    if (chosen) {
      const wrap = await rewrapForPassword(master, chosen);
      const fresh = await rewrapForRecovery(master);
      await api('/api/account/rewrap', {
        kdfSalt: wrap.kdfSalt,
        wrappedByPassword: wrap.wrappedByPassword,
        wrappedByRecovery: fresh.wrappedByRecovery,
        authToken: wrap.authToken,
        recoveryToken: fresh.recoveryToken,
      });
      // The key that was written down has now been typed in, so it is replaced
      // and the new one shown once, exactly as at registration.
      await showRecoveryKey(fresh.recoveryKey, t('recover.done'));
    }

    $('login-error').textContent = '';
    await boot();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

// Asked for after a recovery, where there is no form to read it from.
function askNewPassword() {
  return new Promise((resolve) => {
    const dialog = $('newpass-dialog');
    $('newpass').value = '';
    $('newpass-again').value = '';
    $('newpass-status').textContent = '';
    const done = (value) => {
      $('newpass-ok').removeEventListener('click', ok);
      $('newpass-skip').removeEventListener('click', skip);
      try { dialog.close(); } catch (_) { dialog.removeAttribute('open'); }
      resolve(value);
    };
    const ok = () => {
      const one = $('newpass').value;
      if (one.length < PASSWORD_MIN) {
        $('newpass-status').textContent = t('settings.account.tooShort', { n: PASSWORD_MIN });
        return;
      }
      if (one !== $('newpass-again').value) {
        $('newpass-status').textContent = t('login.passwordMismatch');
        return;
      }
      done(one);
    };
    const skip = () => done(null);
    $('newpass-ok').addEventListener('click', ok);
    $('newpass-skip').addEventListener('click', skip);
    try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); }
  });
}

$('register-toggle').addEventListener('click', () => {
  state.registering = !state.registering;
  renderLogin();
});

$('logout').addEventListener('click', async () => {
  if (!confirm(t('board.logoutConfirm'))) return;
  await api('/api/logout', {});
  // The key goes with the session: leaving it behind would let the next person
  // at this device read the notifications.
  state.keys = null;
  try { await forgetMaster(); } catch (_) {}
  location.reload();
});

$('copy-diary').addEventListener('click', () => copyText($('diary').textContent, t('settings.diary.copy')));

$('lang-choice').addEventListener('change', async () => {
  const chosen = $('lang-choice').value;
  // Saved before anything is redrawn. Redrawing is the part that can fail, and
  // when it did it took the save with it: the screen turned Japanese, the
  // account stayed English, and the next load came back in English with nothing
  // anywhere to say why.
  try { await api('/api/lang', { lang: chosen }); } catch (_) {}
  applyLang(chosen);
});

$('open-settings').addEventListener('click', async () => {
  show('settings');
  renderSettings();
  state.pushReady = await deviceIsRegistered();
  orderSettings();
  try { localStorage.setItem('taskboard.langSeen', '1'); } catch (_) {}
});
$('close-settings').addEventListener('click', () => {
  // The token and the connect code were for this visit. Leaving the screen
  // is the end of them.
  freshToken = null;
  freshCode = null;
  fallbackOpen = false;
  if (connecting) { connecting.abort(); connecting = null; }
  renderBoard(); show('board-screen');
});
$('enable-push').addEventListener('click', enablePush);
$('test-push').addEventListener('click', async () => {
  const result = await api('/api/push/test', {});
  $('push-status').textContent = result.sent
    ? t('settings.push.sent', { n: result.sent })
    : t('settings.push.notSent', { reason: result.reason || t('settings.push.noDevices') });
});

// Everything a Claude session needs to wire itself up, including the four
// things that are easy to get wrong and produce a board that looks connected
// and says nothing. They are spelled out because each one cost a night to find.
//
// Written in English because that is the language the instructions are followed
// in; only the closing line asks for answers back in the reader's own.
function setupPrompt(url) {
  // Handing over the unencrypted form here would be worse than handing over
  // nothing: it reads as complete, it is followed, and the squares then never
  // move — with no error at either end to say the names are being sealed by
  // nobody and matched against nothing.
  if (lockedOut()) return t('settings.hook.lockedPrompt');

  return [
    'Please set the following up.',
    '',
    'I watch your sessions on a site called "Multitasker". One square stands for',
    'one session, and its state changes on its own. For that to work, POST one',
    'line to the URL below at two moments.',
    '',
    'Send to:',
    url,
    ...(state.keys ? [
      '',
      '■ Key (this board is encrypted)',
      'The server cannot read session names. If you send a name as it is, the',
      'server has no idea which square it belongs to.',
      'Keep the following key wherever your script reads its settings from — a',
      'file of your own next to it is fine — and seal the name before sending:',
      toB64(state.keys.master),
      '',
      'The body then looks like this, as JSON with Content-Type: application/json',
      '(it must contain nothing readable):',
      '  {"matchHash": "<keyed hash of the name>", "nameCipher": "<sealed name>"}',
      '  For the start moment, add "event": "start".',
      '',
      'The key above is base64url. Decode it to 32 bytes; those bytes are the',
      'master. Both keys below come from it by HKDF-SHA256 with a zero-length',
      'salt — no bytes at all, not 32 zero bytes — 32 bytes out, and the info',
      'string given.',
      '',
      'Hash: HMAC-SHA256, key = HKDF(master, info="taskboard/index"), over the',
      '  name normalised first, then taken as UTF-8 bytes. Normalising is NFKC,',
      '  then fold exactly these and no others —',
      '  ‘ ’ ʼ to ' + String.fromCharCode(39) + ' and “ ” to ' + String.fromCharCode(34) + ', then trim, then lowercase.',
      '  Folding a wider set gives a different hash for any name that has one.',
      '  The digest goes in as base64url, no padding. Not hex.',
      'Sealing: AES-256-GCM, key = HKDF(master, info="taskboard/data"), over the',
      '  name as it is, not normalised — this is what I read on the board, so its',
      '  capitals should survive. No additional data. 12-byte IV, tag appended to',
      '  the ciphertext, and the tag is the usual 16 bytes. Format',
      '  v1.<iv>.<ciphertext+tag>, each part base64url with no padding.',
      '',
      '   ★ Build this body in ONE place and send it from every path.',
      '     Rule b below asks you to hold number 1 for ten seconds, which makes it',
      '     natural to end up with two places that send — and to seal only one.',
      '     This went wrong here. The held one still went out readable, the server',
      '     could not match it, and the phone rang "no square matches" every time',
      '     while the square never moved. Because stops are the ones that get held,',
      '     the board was silent for precisely what it exists to show.',
      '     After setting up, look at the body of a held send with your own eyes.',
    ] : []),
    '',
    '■ What to send',
    '',
    ...(state.keys ? [
      '1. When you stop and wait for my input:',
      '   {"matchHash": "…", "nameCipher": "…"}',
      '',
      '2. When I send you an instruction (this is what turns the square to running):',
      '   {"matchHash": "…", "nameCipher": "…", "event": "start"}',
      '',
      '   Both are built the same way, from the same name, as set out above.',
      '   Nothing readable goes in either. There is no other shape that works:',
      '   a readable name is accepted and then matches nothing, and the square',
      '   never moves.',
    ] : [
      '1. When you stop and wait for my input:',
      '   {"text": "*<session name>* — waiting for input"}',
      '',
      '2. When I send you an instruction (this is what turns the square to running):',
      '   {"text": "*<session name>* — working", "event": "start"}',
    ]),
    '',
    '   ★ Number 2 must carry "event": "start".',
    '     Without it the board cannot tell it apart from number 1 (you stopped),',
    '     and the square does not move. This went wrong here once: the send looked',
    '     fine and the marker was quietly missing. Once it is set up, look at the',
    '     body you actually send with your own eyes.',
    '',
    '■ The name',
    '',
    'Send whatever name identifies this session to you. The last part of the',
    'working directory is a reasonable choice, and it arrives in the hook input',
    'as `cwd`.',
    '',
    'Do not go looking for the title in my sidebar. It is not in the hook input',
    'and there is no supported way to reach it.',
    '',
    'Whatever you pick, the board lists every name it is told and I attach a',
    'square to one of them. The name has to be the same every time, and',
    'different for every session you want watched separately — two sessions',
    'sending one name share a square and overwrite each other. If two can run',
    'in the same directory, the directory name alone is not enough.',
    '',
    '■ Which hooks',
    'Add these three to hooks in `~/.claude/settings.json`.',
    '  number 1 … `Stop` (the `Notification` hook never fires in some environments)',
    '  number 2 … `UserPromptSubmit`',
    '  number 3 … `StopFailure` (a turn that ends on an API error — a usage limit,',
    '             for one — fires this instead of `Stop`). Register it the same way',
    '             as number 1.',
    '',
    '■ Rules for number 1 (you stopped)',
    '',
    'a. Send nothing while work is still running in the background.',
    '   Your turn ending does not mean the work ended. A background command or',
    '   an agent keeps going long after, and "waiting for you" is untrue then.',
    '',
    '   The Stop input carries `background_tasks`, an array. Each entry looks',
    '   like {"id", "type", "status", "description", "command"}, and the one',
    '   that matters is `status`. While any entry reads "running", send nothing.',
    '   (Taken from a real Stop payload with a background command in flight.)',
    '   An empty array means nothing is running. Only a missing field sends you',
    '   to the transcript.',
    '',
    '   If that field is missing, fall back to the transcript at',
    '   `transcript_path` — JSONL, one object per line, each with a `timestamp`.',
    '   It records both ends:',
    '     start:  Command running in background with ID: <id>',
    '     start:  "status":"async_launched","agentId":"<id>"',
    '     finish: <task-id>ID</task-id>   — a literal tag pair around the id',
    '',
    '   The second start marker sits inside a JSON string, so in the file it',
    '   arrives escaped — \\"status\\":\\"async_launched\\" and so on. Counted in a real',
    '   transcript: 34 escaped against 9 bare. The finish marker can arrive the',
    '   same way. Match both forms of both, or agents starting go',
    '   unnoticed and the board says you are free while one is running.',
    '',
    '   While even one start has no finish, do not send. Ignore starts older than',
    '   24 hours: those are leftovers whose finish notice was lost, and counting',
    '   them silences that session for good.',
    '',
    '   If the transcript cannot be read at all, send. Staying quiet on a file you',
    '   could not open means the session goes silent and nobody finds out why.',
    '',
    'b. A turn often ends and another begins immediately. Hold for about 10',
    '   seconds, and if another turn ends within it, drop the older one — send',
    '   only the last of a chain, and start the ten seconds again from the new',
    '   one rather than keeping the first deadline. A chain is per session_id —',
    '   two sessions',
    '   stopping at the same moment are not one.',
    '',
    '   An instruction arriving during that hold cancels it. Number 2 goes out at',
    '   once and says the session is working; if the held stop then fires behind',
    '   it, the square reads "waiting for you" while the session is busy, and',
    '   stays that way. So the first thing number 2 does is throw away any stop',
    '   this session is still holding.',
    '',
    '   Check for background work again when the hold expires, not only when the',
    '   hook fires. A job can start during those ten seconds, and sending then',
    '   says the session is waiting for you while it is busy.',
    '',
    '   At that point `background_tasks` is ten seconds stale — it came with the',
    '   hook and there is no way to ask for a fresh one — so read the transcript',
    '   for this second look, whether or not the field was there the first time.',
    '   This is the one place the transcript is not a fallback. If it cannot be',
    '   read then, send anyway, for the same reason as above — which does mean',
    '   the second look protects nothing on a session whose transcript is',
    '   unreadable. Better that than a session that goes quiet for good.',
    '',
    '   And if you hold a stop back because work is running, throw away any stop',
    '   that session is still holding. The newer news is that it is busy.',
    '',
    '■ Rules for number 2 (you received an instruction)',
    '',
    'c. Send at once, without holding. There is nothing to wait for, and no need',
    '   to check for background work — it is about to start, not finishing.',
    '',
    'd. This hook runs before my prompt is processed. If you wait for the send to',
    '   complete, everything I type gets slower. Hand it to another process and',
    '   return from the hook immediately.',
    '',
    '■ All three',
    '',
    'e. One attempt per send. If it fails, note it where you can read it later',
    '   and let it go — a retry queue is not worth its failure modes here.',
    '',
    'f. Always exit 0, even on failure. `UserPromptSubmit` in particular will',
    '   swallow my prompt if it exits with 2. Never exit 2, whatever happens.',
    '',
    'g. Use the URL exactly as given, including its scheme and port.',
    '',
    '■ Rules for number 3 (you stopped on an error)',
    '',
    'h. Without it the square stays on running after an error ends the turn.',
    '   Treat it as number 1 with two differences:',
    '',
    ...(state.keys ? [
      '   - The body is number 1\'s with "event": "failure" added:',
      '     {"matchHash": "…", "nameCipher": "…", "event": "failure"}',
      '     Nothing readable goes in it. The marker is what lets the board say',
      '     "Claude stopped on an error" on my phone; without it the square still',
      '     moves, but the phone says only that Claude stopped.',
    ] : [
      '   - The wording is "stopped on an error" in place of "waiting for input",',
      '     and the body carries "event": "failure":',
      '     {"text": "*<session name>* — stopped on an error", "event": "failure"}',
      '     The marker is what lets the board say "Claude stopped on an error" on',
      '     my phone; without it the square still moves, but the phone says only',
      '     that Claude stopped.',
    ]),
    '   - Do not check for background work (rule a) — neither when the hook',
    '     fires nor when the hold expires. The session has stopped whatever is',
    '     still running behind it, and waiting on that work leaves the square',
    '     on running.',
    '',
    '   Everything in rule b holds as for number 1: hold it the same ten',
    '   seconds, and an instruction arriving during the hold cancels it.',
    '   Treat every StopFailure the same, whatever its `error_type`.',
    '',
    'When it is set up, try both once and tell me the body you sent and what came',
    'back. The reply says which it was:',
    '  200 ok: moved',
    '      the square moved.',
    '  200 ok: matched, nowhere to move from here',
    '      the square is there; the state it is in has no arrow for this.',
    '  422 sealed, but no square carries this name',
    '      the sealing is right and I have not attached a square to that name',
    '      yet. Tell me the name and I will.',
    '  422 this board is encrypted — a readable name can never match a square',
    '      the body went out unsealed. Nothing will ever move until that is fixed.',
    '  404 unknown hook',
    '      the address is wrong, not the name.',
    '',
    `Reply to me in ${langNameInEnglish()}.`,
  ].join('\n');
}

async function copyText(text, message) {
  const status = $('copy-status');
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = message;
  } catch (_) {
    // Safari refuses the clipboard outside a user gesture it recognises, and
    // iOS in particular. Falling back to a selection at least lets the owner
    // copy by hand rather than leaving them with nothing.
    const box = $('hook-url');
    box.value = text;
    box.select();
    try { document.execCommand('copy'); status.textContent = message; }
    catch (__) { status.textContent = t('settings.hook.copyFailed'); }
    renderSettings();
  }
}

$('change-password').addEventListener('click', async () => {
  const status = $('account-status');
  try {
    if ($('pw-next').value.length < PASSWORD_MIN) {
      throw new Error(t('settings.account.tooShort', { n: PASSWORD_MIN }));
    }
    // The new salt falls out of the re-wrapping, and the new proof with it.
    // Neither password is sent: the old one only as a proof made under the old
    // salt, the new one only as the proof the server should expect from now on.
    const rewrapped = await rewrapForPassword(state.keys.master, $('pw-next').value);
    await api('/api/account/password', {
      current: await proofOf($('pw-current').value),
      next: rewrapped.authToken,
      kdfSalt: rewrapped.kdfSalt,
      wrappedByPassword: rewrapped.wrappedByPassword,
    });
    $('pw-current').value = ''; $('pw-next').value = '';
    status.textContent = t('settings.account.changed');
    status.className = 'note';
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
  }
});

$('delete-account').addEventListener('click', async () => {
  const status = $('account-status');
  if (!confirm(t('settings.account.deleteConfirm'))) return;
  try {
    await api('/api/account/delete', { password: await proofOf($('delete-password').value) });
    location.reload();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
  }
});

$('copy-hook').addEventListener('click', () => copyText($('hook-url').value, t('settings.hook.copiedUrl')));
$('copy-hook-key').addEventListener('click', () => copyText(
  state.keys ? toB64(state.keys.master) : '',
  t('settings.hook.copiedKey')));

$('reveal-hook-key').addEventListener('click', () => { keyShown = !keyShown; drawKey(); });

$('copy-prompt').addEventListener('click', () =>
  copyText(setupPrompt($('hook-url').value), t('settings.hook.copiedPrompt')));

$('regen-hook').addEventListener('click', async () => {
  const ok = confirm(t('settings.hook.regenConfirm'));
  if (!ok) return;
  state.board = await api('/api/webhook/regenerate', {});
  renderHook();
  $('copy-status').textContent = t('settings.hook.regenDone');
});

$('connect-pc').addEventListener('click', () => { connectThisPc().catch((err) => { $('pc-connect-status').textContent = err.message; }); });

// The fallback and the phone: the same registration, the same string, shown
// as text to be pasted rather than handed over by the OS.
$('make-pc-code').addEventListener('click', async () => {
  if (!state.keys) return;
  if (somePcConnected() && !confirm(t('settings.pc.connectAnother'))) return;
  try {
    await makeConnectCode();
    $('pc-copy-status').textContent = '';
  } catch (err) {
    $('pc-copy-status').textContent = err.message;
  }
});

$('copy-pc-code').addEventListener('click', async () => {
  const status = $('pc-copy-status');
  try {
    await navigator.clipboard.writeText($('pc-code').value);
    status.textContent = t('settings.pc.copiedCode');
  } catch (_) {
    $('pc-code').select();
    status.textContent = t('settings.pc.selectedCode');
  }
});

// The emergency stop (T-077): every PC of the account is cut off, the way a
// sign-in from a new device cuts them off, and only 「再接続」 on each PC
// brings it back. One question first, because there is no undo from here.
$('kill-pcs').addEventListener('click', async () => {
  if (!confirm(t('settings.pc.killConfirm'))) return;
  try {
    state.board = await api('/api/agents/kill', {});
    renderAgent();
    $('pc-copy-status').textContent = t('settings.pc.killed');
  } catch (err) {
    $('pc-copy-status').textContent = err.message;
  }
});

// The address for donations sits in index.html, in the box this copies from,
// so there is one place it is written. Same shape as the connect code above.
$('copy-donate-address').addEventListener('click', async () => {
  const status = $('donate-copy-status');
  try {
    await navigator.clipboard.writeText($('donate-address').value);
    status.textContent = t('settings.donate.copied');
  } catch (_) {
    $('donate-address').select();
    status.textContent = t('settings.donate.selected');
  }
});

// The hand route: a bare token, for someone filling the program's Advanced
// fields themselves. It adds a PC to the list like ③ does; the PCs already
// there keep their tokens and go on working, so there is nothing to warn about.
$('register-pc').addEventListener('click', async () => {
  try {
    const result = await api('/api/agent/register', {});
    freshToken = result.token;
    freshId = result.id;
    freshCode = null;                // the code on screen was for a different row
    if (result.board) state.board = result.board;
    renderAgent();
  } catch (err) {
    $('pc-copy-status').textContent = err.message;
  }
});

$('copy-pc-token').addEventListener('click', async () => {
  const status = $('pc-copy-status');
  try {
    await navigator.clipboard.writeText($('pc-token').value);
    status.textContent = t('settings.pc.copiedToken');
  } catch (_) {
    $('pc-token').select();
    status.textContent = t('settings.pc.selectedToken');
  }
});

// The status line above the steps stays true while the settings are open:
// a PC that comes in, or goes away, shows within a few seconds without
// anyone reloading. Only while this screen is on show and the page is
// visible — the board screen has its own refresh, and a phone in a pocket
// should not be asking.
setInterval(() => {
  if ($('settings').hidden || document.visibilityState !== 'visible') return;
  if (!state.me || !state.me.user || connecting) return;
  pollAgent().catch(() => {});
}, 3000);

$('change-email').addEventListener('click', async () => {
  const note = $('account-status');
  try {
    const result = await api('/api/account/email', {
      email: $('new-email').value, password: await proofOf($('email-password').value),
    });
    state.me.user = { ...(state.me.user || {}), email: result.email };
    $('email-password').value = '';
    flash(note, t('settings.account.emailChanged'));
  } catch (err) {
    flash(note, err.message);
  }
});

// Everything this board holds about the person, in the clear, from the one
// place that can read it. The server could not produce this file: it does not
// know what any of the names say.
$('export').addEventListener('click', () => {
  const board = state.board;
  const copy = {
    takenAt: new Date().toISOString(),
    account: { email: state.me && state.me.user ? state.me.user.email : null, language: getLang() },
    pages: (board.pages || []).map((p) => ({ id: p.id, name: p.name })),
    states: (board.states || []).map((s) => ({
      id: s.id, name: s.name, colour: s.colour, runsTimer: s.runs_timer,
      leftTo: s.left_to, rightTo: s.right_to, onStop: s.auto_to, onInstruction: s.start_to,
    })),
    squares: (board.tasks || []).map((task) => ({
      id: task.id, page: board.page, position: task.slot,
      title: task.title, session: task.match_key,
      state: task.state_id, expectedSeconds: task.expected_seconds,
      inThisStateSince: task.state_since,
      usuallyTakesSeconds: (board.typical || {})[task.id]
        ? (board.typical || {})[task.id].seconds : null,
    })),
    namesReceived: (board.seenNames || []).map((row) => ({ name: row.name, times: row.hits, lastAt: row.last_at })),
    note: 'Only the page currently open is listed under squares. Switch pages and download again for the others.',
  };

  const blob = new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `taskboard-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  flash($('export-status'), t('settings.data.exported'));
});

$('open-pages').addEventListener('click', openPages);
$('page-cancel').addEventListener('click', () => $('page-dialog').close());

$('add-page').addEventListener('click', async () => {
  const name = prompt(t('settings.pages.newName'));
  if (!name) return;
  state.board = await api('/api/page', {
    name: state.keys ? '' : name,
    ...(state.keys ? { nameCipher: await sealText(name) } : {}),
  });
  renderPages(); renderPageButton();
});

$('add-slot').addEventListener('click', async () => {
  state.board = await api('/api/slot/add', { page: state.board.page });
  renderSlots(); renderBoard();
});

$('add-state').addEventListener('click', async () => {
  const name = prompt(t('settings.states.newName'));
  if (!name) return;
  state.board = await api('/api/state', {
    // A placeholder the server can keep unique; the readable name is sealed.
    name: state.keys ? `#${Date.now()}` : name,
    ...(state.keys ? { nameCipher: await sealText(name) } : {}),
    sortOrder: state.board.states.length,
  });
  renderStates();
});

// The ring has to move every second, but the board only has to be re-read often
// enough to catch a change the server made on its own.
// `board-screen` being on show is not the same as the page being on show. Both
// of these kept running with the phone in a pocket — a redraw every second and
// a request every five — which is work nobody could see, battery nobody asked
// to spend, and a reason for the phone to decide the page is not worth keeping.
const onScreen = () => !$('board-screen').hidden && document.visibilityState === 'visible';

setInterval(() => { if (onScreen()) renderBoard(); }, 1000);

// Coming back should not mean waiting up to five seconds to find out what
// happened while the phone was away.
document.addEventListener('visibilitychange', () => {
  if (!onScreen()) return;
  renderBoard();
  refresh().catch(() => {});
});
// Refreshes swallow their errors so a blip does not disturb the board. That
// is right, but doing it silently is not: a board that has stopped being
// updated looks exactly like a board with nothing happening on it.
let refreshFailures = 0;
setInterval(() => {
  if (!onScreen()) return;
  refresh().then(() => {
    if (refreshFailures >= 3) record('refresh recovered after ' + refreshFailures);
    refreshFailures = 0;
    $('stale').hidden = true;
  }).catch((err) => {
    refreshFailures += 1;
    // Once is a blip. Three in a row — fifteen seconds — is worth saying, and
    // saying it where it is being looked at, not only in a log.
    if (refreshFailures === 3) {
      record('refresh failing: ' + (err && err.message));
      $('stale').textContent = (err && err.status === 401) ? t('board.signedOut') : t('board.stale');
      $('stale').hidden = false;
    }
  });
}, 5000);

async function bootOrKeepTrying() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await boot();
      $('offline').hidden = true;
      return;
    } catch (err) {
      // Nothing on screen yet is the case worth covering. Once a screen is up,
      // the same failure is only a stale board, which is far less alarming than
      // a white page and does not need taking over.
      const nothingShown = ['login', 'reset-screen', 'board-screen', 'settings']
        .every((id) => $(id).hidden);
      if (nothingShown) {
        $('offline').hidden = false;
        $('offline-detail').textContent = err && err.message ? err.message : '';
      }
      // Backs off to half a minute and stays there: the board is usually back
      // within a minute or two, and a phone in a pocket should not be asking
      // every second for an hour.
      const wait = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

// The loop is already trying; this is for someone who does not want to wait
// out the current gap. A reload rather than a nudge, because whatever state the
// page is in when nothing has loaded is not worth preserving.
$('offline-retry').addEventListener('click', () => location.reload());

bootOrKeepTrying();
