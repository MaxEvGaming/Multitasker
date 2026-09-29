// The real PC program against the real board: DeckAgent.exe is started with
// a settings file pointing at this server, a command square is pressed the
// way the browser presses it, and the square is watched land where the
// verdict says. Then the agent is stopped and the five-second rule is seen
// to do its work with nobody listening.
//
// Then 「かんたん接続」: the exe is started with a `multitasker://pair/#…`
// link as its argument (the way Windows starts it from the browser — it
// rewrites the board's `pair#` into `pair/#` on the way; no registry
// involved here: `--no-register`, and the link is passed straight in), and
// is seen to write agent.json, connect, and carry an instruction out. A second start with another link is seen to hand it to the running
// one and exit. Finally the parser and the url rule are tried through the
// exe's --check-pair / --check-url, which have no window to block on.
//
//   DATABASE_URL=... BASE=http://127.0.0.1:3040 node test/deck-agent.js
//
// Needs the server running against DATABASE_URL, and a built agent —
// agent/publish/DeckAgent.exe or DECK_AGENT_EXE. Windows only. The agent is
// given its own settings file in a temporary directory; the real
// %APPDATA%\Multitasker\agent.json is not touched.
//
// The presses that have to succeed use `hotkey` with `f24` — a key nothing on
// an ordinary desktop is listening for — since `exec`, which used to run
// `cmd /c exit 0`, was stopped on 2026-09-14 and is now one of the things the
// PC refuses. DECK_AGENT_HOTKEY=1 adds a `hotkey` press of volume_mute twice
// (net no change). Off by default: it presses a key that does something.
//
// Passes with an installed, resident agent present: only processes whose
// executable path is the exe this test started are counted, and
// %APPDATA%\Multitasker / HKCU\Software\Classes\multitasker are required to
// be absent at the end only if they were absent when the test began.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { subKeysFrom, encryptText, toB64 } from '../public/crypto.js';
import { pairLink } from '../public/pair.js';
import { newAccount, loginBody } from './browser.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const exe = [
  process.env.DECK_AGENT_EXE,
  path.join(ROOT, 'agent', 'publish', 'DeckAgent.exe'),
  path.join(ROOT, 'agent', 'bin', 'Release', 'net10.0-windows', 'DeckAgent.exe'),
].filter(Boolean).find((p) => fs.existsSync(p));
if (!exe) { console.log('  FAIL no agent binary — run agent\\build.ps1 first or set DECK_AGENT_EXE'); process.exit(1); }

function client() {
  let cookie = '';
  return async function call(p, body) {
    const res = await fetch(BASE + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    try { return { status: res.status, data: text ? JSON.parse(text) : null }; }
    catch (_) { return { status: res.status, data: text }; }
  };
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const stamp = Date.now();
const email = `agent${stamp}@example.com`;
const call = client();
const { keys, body } = await newAccount(email, 'a-long-enough-password');
let r = await call('/api/register', body);
check('an encrypted account was made', r.status === 200, JSON.stringify(r.data));
const { dataKey } = await subKeysFrom(keys.masterRaw);
const seal = (obj) => encryptText(dataKey, JSON.stringify(obj));

let board = (await call('/api/board')).data;
const square = board.tasks.find((t) => t.slot === 0);
const nameOf = (b, id) => (b.states.find((s) => String(s.id) === String(id)) || {}).name;
const stateNow = async () => { const b = (await call('/api/board')).data; return nameOf(b, b.tasks.find((t) => t.slot === 0).state_id); };
const untilState = async (want, ms) => {
  const until = Date.now() + ms;
  let now = await stateNow();
  while (now !== want && Date.now() < until) { await wait(250); now = await stateNow(); }
  return now;
};
const jobRow = async (id) => (await db.query('select id, status, result_ok from jobs where id = $1', [id])).rows[0];

r = await call('/api/agent/register', { name: 'test-pc' });
const token = r.data.token;
check('the PC is registered', typeof token === 'string' && token.length >= 30);

// The settings file, the way the settings window would write it — with the
// guard written as off, the way 0.3.0 wrote it when off was the default. The
// board has this PC as on (sql/014_guard_default_on.sql), and the file is
// expected to follow the board once the PC has connected (T-085).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agent-'));
const configPath = path.join(dir, 'agent.json');
fs.writeFileSync(configPath, JSON.stringify({
  boardUrl: BASE, token, key: toB64(keys.masterRaw),
  obsHost: '127.0.0.1', obsPort: 4455, obsPassword: '', timeoutSeconds: 10, guard: false,
}, null, 2));

// What is there before the test touches anything. An installed agent owns
// %APPDATA%\Multitasker and the multitasker:// scheme key; the test only
// promises not to create what was not there.
const appdataDir = path.join(process.env.APPDATA || '', 'Multitasker');
const appdataExists = () => Boolean(process.env.APPDATA) && fs.existsSync(appdataDir);
const schemeQuery = () => spawnSync('reg', ['query', 'HKCU\\Software\\Classes\\multitasker'], { encoding: 'utf8', windowsHide: true });
const schemeExists = () => schemeQuery().status === 0;
const hadAppdata = appdataExists();
const hadScheme = schemeExists();
console.log(`before: %APPDATA%\\Multitasker ${hadAppdata ? 'exists' : 'absent'}, HKCU\\Software\\Classes\\multitasker ${hadScheme ? 'exists' : 'absent'}`);

console.log(`starting ${path.relative(process.cwd(), exe)}`);
// --no-register: a normal start writes the multitasker:// keys under HKCU
// for the browser to find; a test run must leave the registry as it was.
const agent = spawn(exe, ['--config', configPath, '--no-register'], { stdio: 'ignore', windowsHide: true });
const logPath = path.join(dir, 'agent.log');
const logTail = () => { try { return fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-12).join('\n'); } catch (_) { return '(no log yet)'; } };

// Connected = the board noted it.
{
  let seen = null;
  for (let i = 0; i < 40 && !seen; i += 1) {
    await wait(250);
    seen = (await db.query('select last_seen from agents where token = $1', [token])).rows[0].last_seen;
  }
  check('the agent connected within ten seconds', Boolean(seen), logTail());

  // And said what this machine is called on the way in, over the name the
  // browser guessed when the token was made. It is what tells one line from
  // another on the board's list once there is more than one PC.
  const named = (await db.query('select name from agents where token = $1', [token])).rows[0].name;
  check('and the board now shows this machine\'s own name', named === os.hostname()
    || named.toLowerCase() === os.hostname().toLowerCase(),
    `board says "${named}", this machine is "${os.hostname()}"`);
  const shown = (await call('/api/board')).data.agents.find((a) => a.name === named);
  check('which is what the board hands the screen', Boolean(shown), named);

  // And took the board's word on the guard (T-085): the board holds it as on
  // (the default), the file said off, and the file now says on.
  check('the board holds the guard as on for this PC — the default', shown && shown.guard === true,
    JSON.stringify(shown));
  let copied = null;
  for (let i = 0; i < 20 && copied !== true; i += 1) {
    await wait(250);
    try { copied = JSON.parse(fs.readFileSync(configPath, 'utf8')).guard; } catch (_) { /* being written */ }
  }
  check('and agent.json, written as off, now says on — the copy followed the board', copied === true,
    `${JSON.stringify(copied)}\n${logTail()}`);
  check('which the log says it did', logTail().includes('guard: the board says on')
    && logTail().includes('updated to on'), logTail());
}

// Presses the square the way public/app.js does: reserve an id, seal the
// instruction with the id and the time inside, submit.
async function press(kind, args, tweak = {}) {
  const fresh = (await call('/api/board')).data;
  r = await call('/api/task', { taskId: square.id, page: fresh.page, commandSealed: await seal({ kind, args }) });
  check(`the square holds a ${kind} command`, r.status === 200, JSON.stringify(r.data));
  r = await call('/api/job/new', { taskId: square.id });
  const id = r.data.id;
  const plain = { id, at: Date.now(), kind, args, ...tweak };
  r = await call('/api/job/submit', { id, page: fresh.page, sealed: await seal(plain) });
  check('the press is accepted', r.status === 200, JSON.stringify(r.data));
  return id;
}

const ids = [];

console.log('hotkey f24, which succeeds');
{
  const id = await press('hotkey', { keys: 'f24' }); ids.push(id);
  const landed = await untilState('Waiting', 8000);
  check('the square ends in Waiting (success)', landed === 'Waiting', `now ${landed}\n${logTail()}`);
  const row = await jobRow(id);
  check('the job is done with result_ok = true', row.status === 'done' && row.result_ok === true, JSON.stringify(row));
}

console.log('a hotkey with a name the PC does not know');
{
  const id = await press('hotkey', { keys: 'nosuchkey' }); ids.push(id);
  const landed = await untilState('Stopped', 8000);
  check('the square ends in Stopped (failure)', landed === 'Stopped', `now ${landed}\n${logTail()}`);
  const row = await jobRow(id);
  check('the job is failed with result_ok = false', row.status === 'failed' && row.result_ok === false, JSON.stringify(row));
}

console.log('exec, which was stopped on 2026-09-14');
{
  const id = await press('exec', { command: 'cmd /c exit 0' }); ids.push(id);
  const landed = await untilState('Stopped', 8000);
  check('is refused: Stopped', landed === 'Stopped', `now ${landed}\n${logTail()}`);
  const row = await jobRow(id);
  check('with a result of false (not left to expire)', row.status === 'failed' && row.result_ok === false, JSON.stringify(row));
  check('and the log says the kind is not one it knows', logTail().includes("kind 'exec' is not one this program knows — refused"), logTail());
}

console.log('an instruction whose inside does not match its outside');
{
  const id = await press('hotkey', { keys: 'f24' }, { id: '999999999' }); ids.push(id);
  const landed = await untilState('Stopped', 8000);
  check('is refused: Stopped', landed === 'Stopped', `now ${landed}\n${logTail()}`);
  const row = await jobRow(id);
  check('with a result of false (not left to expire)', row.status === 'failed' && row.result_ok === false, JSON.stringify(row));
}

console.log('an instruction pressed too long ago');
{
  const id = await press('hotkey', { keys: 'f24' }, { at: Date.now() - 10 * 60 * 1000 }); ids.push(id);
  const landed = await untilState('Stopped', 8000);
  check('is refused: Stopped', landed === 'Stopped', `now ${landed}\n${logTail()}`);
  const row = await jobRow(id);
  check('with a result of false', row.status === 'failed' && row.result_ok === false, JSON.stringify(row));
}

console.log('a url that is neither http nor https');
{
  const id = await press('url', { url: 'file:///C:/Windows/notepad.exe' }); ids.push(id);
  const landed = await untilState('Stopped', 8000);
  check('is refused: Stopped', landed === 'Stopped', `now ${landed}\n${logTail()}`);
}

if (process.env.DECK_AGENT_HOTKEY === '1') {
  console.log('hotkey: volume_mute twice');
  for (let i = 0; i < 2; i += 1) {
    const id = await press('hotkey', { keys: 'volume_mute' }); ids.push(id);
    const landed = await untilState('Waiting', 8000);
    check(`press ${i + 1} succeeds`, landed === 'Waiting', `now ${landed}\n${logTail()}`);
  }
} else {
  console.log('hotkey: skipped (set DECK_AGENT_HOTKEY=1 to press volume_mute twice on this machine)');
}

// The PC's own road, the way the program's settings window and 「再接続」 use
// it (docs/DECK_AGENT_PROTOCOL.md §1).
const agentPost = async (tok, p, payload) => {
  const res = await fetch(`${BASE}/agent/${tok}${p}`, {
    method: 'POST', headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, text: (await res.text()).trim() };
};

console.log('the guard is on, and someone signs in from a new device');
{
  let p = await agentPost(token, '/guard', { on: true });
  check('the PC switches the guard on', p.status === 200 && p.text === 'ok: guard on', `${p.status} ${p.text}`);
  // A browser with no cookie at all: the sign-in the guard is there for.
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await loginBody(email, 'a-long-enough-password')),
  });
  check('the sign-in is accepted', res.status === 200, `status ${res.status}`);
  let cut = false;
  for (let i = 0; i < 40 && !cut; i += 1) { await wait(250); cut = logTail().includes('stream: 403 suspended'); }
  check('the running exe sees 403 suspended and stops reconnecting', cut === true, logTail());
  await wait(2000);
  check('the exe is still running (it was cut off, not killed)', agent.exitCode === null && !agent.killed);
  const row = (await db.query('select suspended_at from agents where token = $1', [token])).rows[0];
  check('and the board holds the PC as cut off', Boolean(row && row.suspended_at));
  check('the log says it will wait for 再接続', logTail().includes('not reconnecting until 再接続'), logTail());
  p = await agentPost(token, '/resume');
  check('the PC\'s road brings it back on the board', p.status === 200 && p.text === 'ok: resumed', `${p.status} ${p.text}`);
  await agentPost(token, '/guard', { on: false });
}

console.log('the agent is stopped, and a press finds nobody');
{
  agent.kill();
  await wait(1000);
  check('the agent process is gone', agent.exitCode !== null || agent.killed);
  const id = await press('hotkey', { keys: 'f24' }); ids.push(id);
  const during = await stateNow();
  check('the square is Running while the five seconds run', during === 'Running', `now ${during}`);
  const landed = await untilState('Stopped', 8000);
  check('and Stopped after them', landed === 'Stopped', `now ${landed}`);
  const row = await jobRow(id);
  check('the job is expired', row.status === 'expired', JSON.stringify(row));
}

// How many copies of *this test's* exe are running right now, by asking
// Windows for the executable path of every DeckAgent.exe. An installed,
// resident agent (%LOCALAPPDATA%\Programs\...\DeckAgent.exe) is another path
// and is not counted. `tasklist` shows only names, hence CIM.
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const agentProcesses = () => {
  const out = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='DeckAgent.exe'\" | ForEach-Object { $_.ExecutablePath }",
  ], { encoding: 'utf8', windowsHide: true });
  return (out.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && samePath(l, exe)).length;
};
const readConfig = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const until = async (what, ms, every = 250) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await what();
    if (got || Date.now() >= end) return got;
    await wait(every);
  }
};
const lastSeenOf = async (tok) => (await db.query('select last_seen from agents where token = $1', [tok])).rows[0]?.last_seen || null;

const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agent-pair-'));
const configPath2 = path.join(dir2, 'agent.json');
const logPath2 = path.join(dir2, 'agent.log');
const logTail2 = () => { try { return fs.readFileSync(logPath2, 'utf8').trim().split('\n').slice(-12).join('\n'); } catch (_) { return '(no log yet)'; } };
let agent2 = null;

// Windows rewrites `multitasker://pair#…` into `multitasker://pair/#…` when
// it hands the link to the handler (docs/DECK_AGENT_PROTOCOL.md 0.5). The
// exe is started with that form — the one it actually receives.
const asDelivered = (link) => link.replace(/^multitasker:\/\/pair#/, 'multitasker://pair/#');

console.log('handed everything in one link: DeckAgent.exe multitasker://pair/#…');
{
  r = await call('/api/agent/register', { name: 'pc' });
  const token2 = r.data.token;
  const built = pairLink(BASE, token2, toB64(keys.masterRaw));
  check('the link is what the board would build', built.startsWith('multitasker://pair#v1|') && built.includes(`|${token2}|`));
  const link = asDelivered(built);
  check('and is started in the form the OS delivers (pair/#)', link.startsWith('multitasker://pair/#v1|'), link);
  check('there is no settings file yet', !fs.existsSync(configPath2));
  check('and no agent running', agentProcesses() === 0, `${agentProcesses()} running`);

  agent2 = spawn(exe, ['--config', configPath2, '--no-register', link], { stdio: 'ignore', windowsHide: true });
  const written = await until(() => { const c = readConfig(configPath2); return c && c.token === token2 ? c : null; }, 10000);
  check('agent.json is written from the link', Boolean(written), logTail2());
  check('with the board address', written && written.boardUrl === BASE, JSON.stringify(written));
  check('the token', written && written.token === token2);
  check('and the key', written && written.key === toB64(keys.masterRaw));
  check('and the other settings at their defaults', written && written.obsPort === 4455 && written.timeoutSeconds === 60, JSON.stringify(written));

  const seen = await until(() => lastSeenOf(token2), 10000);
  check('the agent connected with that token within ten seconds', Boolean(seen), logTail2());
  check('one agent is running', agentProcesses() === 1, `${agentProcesses()} running`);

  const id = await press('hotkey', { keys: 'f24' }); ids.push(id);
  const landed = await untilState('Waiting', 8000);
  check('and carries an instruction out with the key from the link', landed === 'Waiting', `now ${landed}\n${logTail2()}`);
}

console.log('a second start with another link hands it to the running one');
{
  const before = readConfig(configPath2);
  r = await call('/api/agent/register', { name: 'pc' });
  const token3 = r.data.token;
  check('the board handed out another token (this registration adds a PC)', token3 !== before.token);
  const link = asDelivered(pairLink(BASE, token3, toB64(keys.masterRaw)));

  const second = spawn(exe, ['--config', configPath2, '--no-register', link], { stdio: 'ignore', windowsHide: true });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10000);
    second.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  check('the second copy exits on its own', exited !== null, 'still running after 10 s');
  check('with exit code 0', exited === 0, `exit ${exited}`);

  const taken = await until(() => { const c = readConfig(configPath2); return c && c.token === token3 ? c : null; }, 10000);
  check('the running copy took the link: agent.json now carries the new token', Boolean(taken), logTail2());
  const seen = await until(() => lastSeenOf(token3), 10000);
  check('and connected with it', Boolean(seen), logTail2());
  check('the first copy is still the one running', agent2.exitCode === null && !agent2.killed);
  check('and it is the only one', agentProcesses() === 1, `${agentProcesses()} running`);

  const id = await press('hotkey', { keys: 'f24' }); ids.push(id);
  const landed = await untilState('Waiting', 8000);
  check('an instruction runs under the new token', landed === 'Waiting', `now ${landed}\n${logTail2()}`);
}

console.log('the parser, on links that must be refused (--check-pair)');
{
  const tryPair = (text) => {
    const out = spawnSync(exe, ['--check-pair', text], { encoding: 'utf8', windowsHide: true });
    return { status: out.status, line: (out.stdout || '').trim().split(/\r?\n/)[0] || '' };
  };
  const good = pairLink('https://board.example.com', 'abcdefghijklmnopqrstuvwxyz012345', 'CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY');
  let t = tryPair(good);
  check('the pinned link is accepted', t.status === 0 && t.line === 'ok origin=https://board.example.com token=abcdefghijklmnopqrstuvwxyz012345 keyBytes=32', t.line);
  t = tryPair(good.replace('pair#v1%7C', 'x').replace('#v1|', '#v1%7C'));
  check('a percent-encoded fragment is accepted too', t.status === 0, t.line);
  t = tryPair(asDelivered(good));
  check('the pair/# form the OS delivers is accepted', t.status === 0 && t.line === 'ok origin=https://board.example.com token=abcdefghijklmnopqrstuvwxyz012345 keyBytes=32', t.line);
  t = tryPair(asDelivered(good).replace(/\|/g, '%7C'));
  check('pair/# with a percent-encoded fragment too', t.status === 0 && t.line === 'ok origin=https://board.example.com token=abcdefghijklmnopqrstuvwxyz012345 keyBytes=32', t.line);
  t = tryPair(asDelivered(good).replace('pair/#', 'pair//#'));
  check('two slashes are refused', t.status === 2 && t.line === 'error pair.notALink', t.line);
  t = tryPair('multitasker://pair#v2|https://b|abcdefghijklmnopqrstuvwxyz012345|CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY');
  check('a wrong version is refused, and says so', t.status === 2 && t.line === 'error pair.badVersion', t.line);
  t = tryPair('multitasker://pair#v1|https://b|abcdefghijklmnopqrstuvwxyz012345');
  check('three parts are refused', t.status === 2 && t.line === 'error pair.badShape', t.line);
  t = tryPair('multitasker://pair#v1|https://b|abcdefghijklmnopqrstuvwxyz012345|abc');
  check('a short key is refused', t.status === 2 && t.line === 'error pair.badKey', t.line);
  t = tryPair('multitasker://pair#v1|ftp://b|abcdefghijklmnopqrstuvwxyz012345|CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY');
  check('an origin that is not http(s) is refused', t.status === 2 && t.line === 'error pair.badOrigin', t.line);
  t = tryPair('hello');
  check('something that is not a link at all is refused', t.status === 2 && t.line === 'error pair.notALink', t.line);
}

console.log('the url rule (--check-url)');
{
  const tryUrl = (text) => {
    const out = spawnSync(exe, ['--check-url', text], { encoding: 'utf8', windowsHide: true });
    return { status: out.status, line: (out.stdout || '').trim().split(/\r?\n/)[0] || '' };
  };
  let t = tryUrl('https://example.com/a');
  check('https is opened as it is', t.status === 0 && t.line === 'open https://example.com/a', t.line);
  t = tryUrl('http://example.com/a');
  check('http is opened as it is', t.status === 0 && t.line === 'open http://example.com/a', t.line);
  t = tryUrl('example.com');
  check('a bare host becomes https', t.status === 0 && t.line === 'open https://example.com', t.line);
  t = tryUrl('file:///C:/Windows/notepad.exe');
  check('file: is refused', t.status === 2 && t.line === 'refused', t.line);
  t = tryUrl('C:\\Windows\\notepad.exe');
  check('a path is refused', t.status === 2 && t.line === 'refused', t.line);
  t = tryUrl('ms-settings:display');
  check('another scheme is refused', t.status === 2 && t.line === 'refused', t.line);
  t = tryUrl('');
  check('nothing is refused', t.status === 2 && t.line === 'refused', t.line);
}

console.log('cleaning up');
{
  if (agent2) agent2.kill();
  const gone = await until(() => (agentProcesses() === 0 ? true : null), 5000);
  check('no copy of the test exe is left running', gone === true, `${agentProcesses()} running`);
  // Only what was absent at the start must still be absent: an installed
  // agent legitimately owns both of these, and the test must not mind it.
  if (hadAppdata) console.log('  --   %APPDATA%\\Multitasker existed before the test (installed agent); not checked');
  else check('%APPDATA%\\Multitasker was not created', !appdataExists(), appdataDir);
  if (hadScheme) console.log('  --   HKCU\\Software\\Classes\\multitasker existed before the test (installed agent); not checked');
  else check('HKCU\\Software\\Classes\\multitasker was not written (--no-register)', !schemeExists(), (schemeQuery().stdout || '').trim());
}

console.log('agent log (the link-started run)');
try { console.log(fs.readFileSync(logPath2, 'utf8').trim().split('\n').map((l) => `  ${l}`).join('\n')); } catch (_) {}
fs.rmSync(dir2, { recursive: true, force: true });

console.log('job rows');
const { rows } = await db.query('select id, status, result_ok from jobs where id = any($1::bigint[]) order by id', [ids]);
for (const row of rows) console.log(`  ${row.id}\t${row.status}\t${row.result_ok}`);

console.log('agent log (this run)');
try { console.log(fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => `  ${l}`).join('\n')); } catch (_) {}

fs.rmSync(dir, { recursive: true, force: true });
await db.end();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
