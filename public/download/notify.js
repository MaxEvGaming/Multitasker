#!/usr/bin/env node
'use strict';
// Posts a line to the task board when a Claude Code session stops and waits for
// the owner. The payload keeps Slack's shape — {"text": "*name* — body"} — because
// the board's inlet was built to accept exactly that, so switching destinations
// was a change of address and nothing else.
//
// Wired to the Notification hook, so it must never fail loudly: a non-zero exit
// or a hang here would surface as a broken hook in every session. Every path
// below ends in exit 0.
//
//   <hook json on stdin> | node notify.js --hook
//   node notify.js --title "ProjectOne" --body "入力待ちです"     (manual test)

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

const HERE = __dirname;
const LOG = path.join(HERE, 'notify.log');

function log(line) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch (_) {}
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, file), 'utf8')); } catch (_) { return null; }
}

// --- sealing -----------------------------------------------------------------
//
// Once a board is encrypted it can no longer be told a session name: the server
// is the thing being locked out. So this end sends a keyed hash to match on, and
// the name itself encrypted for the owner. Nothing readable leaves the machine.
//
// The key comes from `notify.json` and is the same master key the browser holds.
// The two derivations below must agree with `public/crypto.js` exactly, and
// `test/crypto-agreement.js` in the taskboard project checks that they do.
const HKDF_INFO = { data: 'taskboard/data', index: 'taskboard/index' };

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function subKey(masterRaw, which, length = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', masterRaw, Buffer.alloc(0),
    Buffer.from(HKDF_INFO[which], 'utf8'), length));
}

// The same folding the browser does, so a name typed there and reported here
// come out as the same hash.
function normalise(name) {
  return String(name || '')
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .toLowerCase();
}

function blindIndex(masterRaw, name) {
  const normalised = normalise(name);
  if (!normalised) return '';
  return b64url(crypto.createHmac('sha256', subKey(masterRaw, 'index'))
    .update(normalised, 'utf8').digest());
}

function sealText(masterRaw, text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', subKey(masterRaw, 'data'), iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1.${b64url(iv)}.${b64url(Buffer.concat([body, cipher.getAuthTag()]))}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// Claude Code hands the hook its JSON on a pipe. Reading fd 0 synchronously
// looks simpler but fails intermittently on Windows pipes (EAGAIN), and the
// failure is silent — the hook appears to run and simply never notifies. Read
// the stream instead, with a deadline so a stdin that never closes cannot wedge
// the hook.
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 3000).unref();
  });
}

// The hook payload carries a session id but not the name the owner reads in the
// sidebar ("ProjectOne", "AnotherThing"). The desktop app keeps that title in a
// per-session file that also records the CLI session id, so we walk those and
// match. Without a real title the message cannot say which of several parallel
// sessions stopped, which is the whole point of sending it.
function sessionTitle(sessionId, cwd) {
  const fallback = cwd ? path.basename(cwd) : 'Claude';
  if (!sessionId) return fallback;

  const root = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
                         'Claude', 'claude-code-sessions');
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.name.startsWith('local_') || !entry.name.endsWith('.json')) continue;
      let rec;
      try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) { continue; }
      if (rec.cliSessionId === sessionId && rec.title) return rec.title;
    }
  }
  return fallback;
}

// Whether the session still has work running that nobody has to answer for.
//
// A turn ending means the model stopped talking, not that the job is done: a
// background command or a background agent keeps running long after, sometimes
// for an hour, and telling the owner "waiting for you" then is simply wrong.
// The transcript records both ends of every such job, so we diff them:
//
//   started   "Command running in background with ID: <id>"
//             "status":"async_launched","agentId":"<id>"
//   finished  "<task-id><id></task-id>"   (the completion notification)
//
// Anything started and not finished is still out there. We read only the tail
// of the transcript — these files reach hundreds of megabytes and the hook has
// to return quickly. A start that scrolled out of the window is invisible to
// us, which is the one way this can still fire early.
const TRANSCRIPT_TAIL_BYTES = 40 * 1024 * 1024;
const MAX_JOB_AGE_HOURS = 24;

function unfinishedWork(transcriptPath) {
  const open = new Set();
  if (!transcriptPath) return open;
  let text = '';
  try {
    const { size } = fs.statSync(transcriptPath);
    const from = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const length = size - from;
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(transcriptPath, 'r');
    try { fs.readSync(fd, buf, 0, length, from); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8');
  } catch (e) {
    log(`transcript unreadable (${e.code || e.message}) — treating as idle`);
    return open;
  }

  // A job whose completion notice never landed — the session was killed while it
  // ran — would otherwise sit in this set forever and mute the session for good.
  // One transcript here still carried six such entries from mid-July. So a start
  // only counts if it is recent; the transcript timestamps give us the age.
  const cutoff = Date.now() - MAX_JOB_AGE_HOURS * 3600 * 1000;
  const startedAt = (offset) => {
    const at = text.lastIndexOf('"timestamp":"', offset);
    if (at < 0) return 0;
    return Date.parse(text.substr(at + 13, 24)) || 0;
  };

  const add = (id, offset) => { if (startedAt(offset) >= cutoff) open.add(id); };
  for (const m of text.matchAll(/running in background with ID: ([A-Za-z0-9_-]+)/g)) add(m[1], m.index);
  for (const m of text.matchAll(/"status":"async_launched","agentId":"([A-Za-z0-9_-]+)"/g)) add(m[1], m.index);
  for (const m of text.matchAll(/<task-id>([A-Za-z0-9_-]+)<\/task-id>/g)) open.delete(m[1]);
  return open;
}

// Only the states where the owner has to do something. Everything else would be
// noise on a lock screen, and noise is how a notification channel dies.
const WORDING = {
  permission_prompt: '許可待ちです',
  idle_prompt:       '入力待ちです',
  agent_needs_input: '入力待ちです',
  // agent_completed is deliberately absent: it fires per background subagent,
  // and a channel that pings on every one of those stops being read. A session
  // that finishes its turn already surfaces as idle_prompt.
};

function fromHook(raw) {
  let hook = {};
  try { hook = JSON.parse(raw); }
  catch (_) { log(`skip: could not parse hook input (${raw.length} bytes)`); return null; }

  // Two events mean "this session has stopped and is waiting for you", and we
  // take whichever the app actually emits:
  //   Notification/idle_prompt — the terminal's own idle warning
  //   Stop                     — the turn ended, which is the same fact
  // Stop is the one proven to run in the desktop app. permission_prompt cannot
  // fire here at all: the owner runs in bypassPermissions, so nothing ever asks.
  const event = hook.hook_event_name || '';
  const type = hook.notification_type || '';

  if (event === 'UserPromptSubmit') {
    return { title: sessionTitle(hook.session_id, hook.cwd), body: '作業中',
      session: hook.session_id, transcript: hook.transcript_path, event: 'start' };
  }

  let wording = WORDING[type];
  if (!wording && event === 'Stop') wording = '入力待ちです';
  if (!wording) { log(`skip: unhandled event="${event}" type="${type}"`); return null; }

  return { title: sessionTitle(hook.session_id, hook.cwd), body: wording, session: hook.session_id, transcript: hook.transcript_path };
}

// Refuses to send anything readable unless that is asked for outright.
//
// Without a key the only thing that can be sent is the session name in the
// clear — and a board that is encrypted will not match it anyway, so the
// square never moves. The cost of guessing wrong is a name leaving the machine
// every turn, which is not something to default to.
//
// Set \"allowPlaintext\": true in notify.json for a board that is genuinely not
// encrypted. There is no way to send this by accident.
function payloadFor(config, message) {
  const masterB64 = config.key || '';
  const master = masterB64 ? fromB64url(masterB64) : null;
  if (!master && !config.allowPlaintext) return null;
  const starting = message.event === 'start' ? { event: 'start' } : {};
  return master
    // Nothing readable: a hash to match on, and the name sealed for its owner.
    ? {
      matchHash: blindIndex(master, message.title),
      nameCipher: sealText(master, message.title),
      ...starting,
    }
    : {
      text: `*${message.title}* — ${message.body}`,
      ...starting,
    };
}

function post(url, payload) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const target = new URL(url);
    // Honour the port and the scheme rather than assuming 443. The live address
    // is https on the default port either way, but assuming it meant the
    // destination could not be pointed anywhere else — including at a local
    // listener, which is how one would ever see what this actually sends.
    const transport = target.protocol === 'http:' ? http : https;
    const req = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: 8000,
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: text.trim() }));
    });
    req.on('error', (err) => resolve({ status: 0, text: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: 'timeout' }); });
    req.end(body);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readJson('notify.json');
  const quiet = Number(config && config.quietSeconds) > 0 ? Number(config.quietSeconds) : 90;

  if (args.deliver) {
    const [session, nonce] = process.argv.slice(process.argv.indexOf('--deliver') + 1);
    return deliver(session, nonce, quiet);
  }
  if (!config || !config.default) { log('abort: notify.json missing or has no default endpoint'); return; }

  const raw = args.hook ? await readStdin() : '';
  // Off unless asked for. What the app actually hands a hook is not written down
  // anywhere, and guessing at it is how the wrong field gets used.
  if (raw && config.capture) {
    try { fs.appendFileSync(path.join(HERE, 'capture.log'), raw + '\n'); } catch (_) {}
  }
  const message = args.hook
    ? fromHook(raw)
    : { title: args.title || 'Claude', body: args.body || '', event: args.event || 'stop' };
  if (!message) return;

  // The turn is beginning, not ending. Sent straight through: none of the
  // reasons to wait apply — there is nothing running yet to wait for, and the
  // person is at the keyboard, so there is nobody to notify either. It still
  // leaves by way of a detached child, because this hook runs before the prompt
  // is processed and must not put a network round trip in front of it.
  if (args.start) {
    // A stop from the turn just finished may still be sitting out its ten
    // seconds. An instruction arriving now makes it untrue — the person is at
    // the keyboard and the session is about to be busy — and worse, it would
    // land *after* this one and leave the square reading "waiting for you"
    // while the session works. Drop it before it can.
    if (dropPending(message.session)) log('dropped a held stop: an instruction arrived first');

    const child = spawn(process.execPath,
      [__filename, '--title', message.title, '--body', '作業中', '--event', 'start'],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log(`start: ${message.title}`);
    return;
  }

  // Still keyed by project name: the board matches the name against a square,
  // and a per-project address remains possible if one is ever wanted.
  const url = (config.byProject && config.byProject[message.title]) || config.default;

  // A turn ending is not the same as the work being finished. When a session
  // kicks off a background job the turn ends immediately, and firing then means
  // "waiting for you" while the owner can plainly see the task still running.
  // So hold the message, and drop it if the same session ends another turn
  // inside the window — the later turn supersedes this one, and only the last
  // one in a chain is a real stop.
  const quietSeconds = Number(config.quietSeconds) > 0 ? Number(config.quietSeconds) : 90;

  if (args.hook && !args.start) {
    const open = unfinishedWork(message.transcript);
    if (open.size > 0) {
      log(`skip: ${open.size} background job(s) still running (${[...open].join(', ')})`);
      return;
    }
  }

  if (args.hook && !args.deliver) {
    const nonce = `${Date.now()}-${process.pid}`;
    writePending(message.session, { nonce, title: message.title, body: message.body, url, transcript: message.transcript });
    // Detached: the hook must return at once or it holds up the session.
    const child = spawn(process.execPath, [__filename, '--deliver', message.session, nonce], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    log(`held ${quietSeconds}s: ${message.title} / ${message.body}`);
    return;
  }

  const payload = payloadFor(config, message);
  if (!payload) { log('skip: no key configured — refusing to send a readable name'); return; }
  const res = await post(url, payload);
  if (res.status === 200) log(`sent: ${message.title} / ${message.body}`);
  else log(`error ${res.status}: ${res.text}`);
  if (!args.hook) console.log(res.status === 200 ? 'sent' : `failed: ${res.status} ${res.text}`);
}

const PENDING = path.join(HERE, 'pending');

// Returns whether there was one, so the log only mentions it when it happened.
function dropPending(session) {
  try {
    fs.unlinkSync(pendingFile(session));
    return true;
  } catch (_) {
    return false;
  }
}

function pendingFile(session) {
  const safe = String(session || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(PENDING, safe + '.json');
}

function writePending(session, record) {
  try {
    fs.mkdirSync(PENDING, { recursive: true });
    fs.writeFileSync(pendingFile(session), JSON.stringify(record));
  } catch (e) { log(`pending write failed: ${e.message}`); }
}

// Runs in the detached child. Sleeps out the quiet window, then sends only if
// no newer turn has claimed this session in the meantime.
async function deliver(session, nonce, quietSeconds) {
  await new Promise((r) => setTimeout(r, quietSeconds * 1000));

  let record;
  try { record = JSON.parse(fs.readFileSync(pendingFile(session), 'utf8')); }
  catch (_) { return; }

  if (record.nonce !== nonce) { log(`superseded: ${record.title}`); return; }

  // The session can pick work back up during the hold — an agent finishes and
  // the next turn starts — and sending "waiting for you" then is exactly the
  // complaint this whole mechanism exists to answer. Look again before sending.
  const open = unfinishedWork(record.transcript);
  if (open.size > 0) {
    log(`dropped at delivery: ${record.title} started ${open.size} job(s) during the hold`);
    return;
  }

  const held = payloadFor(readJson('notify.json') || {}, record);
  if (!held) { log('skip: no key configured — refusing to send a readable name'); try { fs.unlinkSync(pendingFile(session)); } catch (_) {} return; }
  const res = await post(record.url, held);
  if (res.status === 200) log(`sent: ${record.title} / ${record.body}`);
  else log(`error ${res.status}: ${res.text}`);
  try { fs.unlinkSync(pendingFile(session)); } catch (_) {}
}

// Run when invoked, not when imported: the sealing below is checked against the
// browser's implementation by a test that has to be able to load this file
// without it trying to send anything.
if (require.main === module) {
  main().catch((e) => log(`crash: ${e && e.stack ? e.stack : e}`));
}

module.exports = { blindIndex, sealText, normalise, b64url, fromB64url, subKey, payloadFor, pendingFile, dropPending };
