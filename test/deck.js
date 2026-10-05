// A square that presses something on a PC, walked end to end against a real
// Postgres and a real server: the command is sealed in the browser's own code,
// the PC's side is played here over the same stream and the same three
// addresses the real one will use, and the square is watched moving.
//
// Also the refusals: no command on an unencrypted board, no stream for a token
// nobody has, no touching another account's instruction, and a ceiling.
import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { subKeysFrom, encryptText, decryptText, toB64 } from '../public/crypto.js';
import {
  pairLink, parsePairLink, normalizeUrl, isMobile, PAIR_PREFIX, TEXT_MAX, textTooLong, TEXT_MODES, textMode,
  MARKER_LABEL_MAX, markerLabel, markerArgs,
} from '../public/pair.js';
import { newAccount } from './browser.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  let cookie = '';
  return async function call(path, body) {
    const res = await fetch(BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    try { return { status: res.status, data: text ? JSON.parse(text) : null }; }
    catch (_) { return { status: res.status, data: text }; }
  };
}

// The PC's three calls, without a cookie: the token in the address is the
// whole of what identifies it.
async function agentPost(token, path, body) {
  const res = await fetch(`${BASE}/agent/${token}${path}`, {
    method: 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: (await res.text()).trim() };
}

// A stand-in for the PC's stream reader. Splits the response into events and
// hands out `event: job` blocks one at a time; close() drops the connection
// the way a laptop lid would. `name` is what the machine calls itself, sent
// the way the real program sends it.
async function openStream(token, name) {
  const controller = new AbortController();
  const where = `${BASE}/agent/${token}/events${name ? `?name=${encodeURIComponent(name)}` : ''}`;
  const res = await fetch(where, { signal: controller.signal });
  const jobs = [];
  const waiting = [];
  let buffer = '';
  let closed = false;
  const push = (job) => {
    if (waiting.length) waiting.shift()(job);
    else jobs.push(job);
  };
  (async () => {
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (event === 'job' && data) push(JSON.parse(data));
        }
      }
    } catch (_) { /* aborted */ }
    closed = true;
  })();
  return {
    status: res.status,
    type: res.headers.get('content-type') || '',
    // The waiter that goes into the queue has to be the one the timeout takes
    // out again. It was looking for `resolve`, which is never what was pushed,
    // so a `next()` that timed out left its waiter in the queue for ever — and
    // the next job to arrive was handed to that dead waiter and vanished. It
    // never showed while every test asked for one job and got it; it shows the
    // moment a test asks "did nothing arrive?" and then asks again later.
    next(ms = 3000) {
      if (jobs.length) return Promise.resolve(jobs.shift());
      return new Promise((resolve) => {
        const take = (job) => { clearTimeout(timer); resolve(job); };
        const timer = setTimeout(() => {
          const i = waiting.indexOf(take);
          if (i >= 0) waiting.splice(i, 1);
          resolve(null);
        }, ms);
        waiting.push(take);
      });
    },
    close() { controller.abort(); },
    get closed() { return closed; },
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 「かんたん接続」's two pure pieces, before anything touches the database:
// the link the board hands the PC program, and the tidying of a typed
// address. Both live in public/pair.js so this file and app.js share them.
console.log('the connect code, from a known key');
{
  const master = 'CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY';   // test/vectors/deck-seal.json
  const token = 'abcdefghijklmnopqrstuvwxyz012345';
  const link = pairLink('https://board.example.com', token, master);
  check('is exactly the pinned string',
    link === 'multitasker://pair#v1|https://board.example.com|abcdefghijklmnopqrstuvwxyz012345|CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY',
    link);
  check('and starts with the scheme the PC registers', link.startsWith(PAIR_PREFIX));
  const back = parsePairLink(link);
  check('it reads back into its four parts', Boolean(back) && back.version === 'v1'
    && back.origin === 'https://board.example.com' && back.token === token && back.key === master,
    JSON.stringify(back));
  check('a percent-encoded fragment reads the same',
    JSON.stringify(parsePairLink(`multitasker://pair#v1%7Chttps://board.example.com%7C${token}%7C${master}`)) === JSON.stringify(back));
  check('an http origin is allowed (local boards)',
    Boolean(parsePairLink(pairLink('http://127.0.0.1:3040', token, master))));
  check('a wrong version is refused', parsePairLink(`multitasker://pair#v2|https://b|${token}|${master}`) === null);
  check('three parts are refused', parsePairLink(`multitasker://pair#v1|https://b|${token}`) === null);
  check('a short key is refused', parsePairLink(`multitasker://pair#v1|https://b|${token}|abc`) === null);
  check('another scheme is refused', parsePairLink(`https://pair#v1|https://b|${token}|${master}`) === null);
  check('an origin with a path is refused', parsePairLink(`multitasker://pair#v1|https://b/x|${token}|${master}`) === null);
  check('nothing is refused', parsePairLink('') === null && parsePairLink(null) === null);
  // Windows rewrites `pair#` into `pair/#` on the way to the PC program
  // (docs/DECK_AGENT_PROTOCOL.md 0.5); the reader accepts that form too.
  check('the pair/# form the OS delivers reads the same',
    JSON.stringify(parsePairLink(`multitasker://pair/#v1|https://board.example.com|${token}|${master}`)) === JSON.stringify(back));
  check('pair/# with a percent-encoded fragment too',
    JSON.stringify(parsePairLink(`MULTITASKER://PAIR/#v1%7Chttps://board.example.com%7C${token}%7C${master}`)) === JSON.stringify(back));
  check('two slashes are refused', parsePairLink(`multitasker://pair//#v1|https://board.example.com|${token}|${master}`) === null);
  check('a slash without the # is refused', parsePairLink(`multitasker://pair/v1|https://board.example.com|${token}|${master}`) === null);
}

console.log('a typed web address');
{
  check('example.com gets https:// in front', normalizeUrl('example.com') === 'https://example.com');
  check('with a path too', normalizeUrl('example.com/a/b?c=1') === 'https://example.com/a/b?c=1');
  check('http:// is kept as it is', normalizeUrl('http://example.com/x') === 'http://example.com/x');
  check('https:// is kept as it is', normalizeUrl('https://example.com/x') === 'https://example.com/x');
  check('so is a capitalised scheme', normalizeUrl('HTTPS://Example.com') === 'HTTPS://Example.com');
  check('spaces around it are dropped', normalizeUrl('  example.com  ') === 'https://example.com');
  check('a leading slash is not doubled', normalizeUrl('//example.com') === 'https://example.com');
  check('empty stays empty', normalizeUrl('') === '' && normalizeUrl(null) === '');
  // Left as typed on purpose: the PC refuses it, and that refusal should be
  // visible rather than turned into https://file:///...
  check('some other scheme is left alone', normalizeUrl('file:///C:/x.txt') === 'file:///C:/x.txt');
}

// A line the PC cannot finish typing inside the 60 seconds the board waits is
// a square that fails every time it is pressed, so the board refuses to save
// one. The ceiling and the counting are in public/pair.js; the screen turns a
// true from here into the sentence it shows instead of saving.
console.log('the line a text square types has a ceiling');
{
  check('the ceiling is 500 characters', TEXT_MAX === 500, String(TEXT_MAX));
  check('exactly 500 is allowed', !textTooLong('x'.repeat(500)));
  check('501 is not', textTooLong('x'.repeat(501)));
  check('nor is anything longer', textTooLong('x'.repeat(2000)));
  check('an empty line is allowed', !textTooLong('') && !textTooLong(null) && !textTooLong(undefined));
  // The PC types a surrogate pair in one call and waits once after it, so it
  // is one character to it and has to be one character here.
  const astral = '\u{1F642}';
  check('a character outside the basic plane counts once', !textTooLong(astral.repeat(500)));
  check('and 501 of them is still too long', textTooLong(astral.repeat(501)));
  // Japanese takes one unit each, so 500 of them fit where 500 letters do.
  check('Japanese counts the same', !textTooLong('あ'.repeat(500)) && textTooLong('あ'.repeat(501)));
}

// How the line is typed is the square's choice (T-087), read back the same
// way the settings screen reads it: a square saved before there was a choice
// has no `mode`, and types one character at a time as it always did.
console.log('the way a text square types is chosen per square');
{
  check('the two ways are burst then paced, burst first as the default (T-092)', JSON.stringify(TEXT_MODES) === '["burst","paced"]', JSON.stringify(TEXT_MODES));
  check('burst reads as burst', textMode({ mode: 'burst' }) === 'burst');
  check('paced reads as paced', textMode({ mode: 'paced' }) === 'paced');
  check('no mode at all reads as burst', textMode({ key: 't', text: 'hi' }) === 'burst'
    && textMode({}) === 'burst' && textMode(undefined) === 'burst' && textMode(null) === 'burst');
  check('and so does a value nobody knows', textMode({ mode: 'fast' }) === 'burst' && textMode({ mode: true }) === 'burst');
}

// A stream marker's label is optional and held to 40 characters on the board
// (docs/briefs/marker.md). Counted the way the text ceiling is.
console.log('a stream marker\'s label has a ceiling');
{
  check('the ceiling is 40 characters', MARKER_LABEL_MAX === 40, String(MARKER_LABEL_MAX));
  check('40 are kept whole', markerLabel('x'.repeat(40)) === 'x'.repeat(40));
  check('the 41st is cut off', markerLabel('x'.repeat(41)) === 'x'.repeat(40));
  check('Japanese counts one a character', markerLabel('あ'.repeat(45)) === 'あ'.repeat(40));
  const astral = '\u{1F642}';
  check('a character outside the basic plane counts once', markerLabel(astral.repeat(45)) === astral.repeat(40));
  check('none at all is an empty label', markerLabel('') === '' && markerLabel(null) === '' && markerLabel(undefined) === '');
}

// What a pressed marker carries: its label and the board's language at the
// press (2026-10-05, T-505 = A). The PC writes 配信／録画 for "ja" and
// Stream／Recording for anything else (agent --check-marker).
console.log('a pressed stream marker carries the board\'s language');
{
  check('Japanese', JSON.stringify(markerArgs({ label: '神プレイ' }, 'ja')) === '{"label":"神プレイ","lang":"ja"}',
    JSON.stringify(markerArgs({ label: '神プレイ' }, 'ja')));
  check('English', JSON.stringify(markerArgs({ label: 'best play' }, 'en')) === '{"label":"best play","lang":"en"}',
    JSON.stringify(markerArgs({ label: 'best play' }, 'en')));
  check('the label is still held to 40 characters', markerArgs({ label: 'x'.repeat(41) }, 'ja').label === 'x'.repeat(40));
  check('no label is an empty one', markerArgs({}, 'en').label === '' && markerArgs(null, 'en').label === ''
    && markerArgs({ label: 3 }, 'en').label === '');
  check('a saved square\'s other keys do not ride along', Object.keys(markerArgs({ label: 'a', lang: 'xx', extra: 1 }, 'ja')).join() === 'label,lang'
    && markerArgs({ label: 'a', lang: 'xx' }, 'ja').lang === 'ja');
}

console.log('a phone is told apart from a PC');
{
  check('an iPhone', isMobile('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'));
  check('an Android phone', isMobile('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'));
  check('an iPad that says it is a Mac, by its touch points', isMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1', 5));
  check('a Windows PC is not', !isMobile('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 0));
  check('a Mac with no touch is not', !isMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1', 0));
}

console.log('what the board hands out for the PC to install');
{
  const res = await fetch(`${BASE}/download/agent/version.json`);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) {}
  check('version.json is served', res.status === 200, `status ${res.status}`);
  check('as JSON', (res.headers.get('content-type') || '').startsWith('application/json'), res.headers.get('content-type'));
  check('naming the installer', parsed && parsed.file === 'DeckAgentSetup.exe' && /^\d+\.\d+\.\d+$/.test(parsed.version), text);

  const exe = path.join(HERE, '..', 'public', 'download', 'DeckAgentSetup.exe');
  if (fs.existsSync(exe)) {
    const head = await fetch(`${BASE}/download/DeckAgentSetup.exe`);
    check('the installer is served', head.status === 200, `status ${head.status}`);
    check('as a download', (head.headers.get('content-type') || '') === 'application/octet-stream', head.headers.get('content-type'));
    check('with its whole length', Number(head.headers.get('content-length')) === fs.statSync(exe).size, head.headers.get('content-length'));
    const body = await head.arrayBuffer();
    check('and the bytes arrive', body.byteLength === fs.statSync(exe).size, String(body.byteLength));
  } else {
    console.log('  (public/download/DeckAgentSetup.exe is not built on this machine — its download is not checked)');
    const missing = await fetch(`${BASE}/download/DeckAgentSetup.exe`);
    check('a missing installer is a plain 404, not a crash', missing.status === 404, `status ${missing.status}`);
  }
  const outside = await fetch(`${BASE}/download/../../package.json`);
  check('the download folder cannot be climbed out of', outside.status !== 200 || !(await outside.text()).includes('"name"'), `status ${outside.status}`);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const PASSWORD = 'a-long-enough-password';
const stamp = Date.now();

const named = (b, n) => b.states.find((s) => s.name === n);
const nameOf = (b, id) => (b.states.find((s) => String(s.id) === String(id)) || {}).name;
const first = (b) => b.tasks.find((t) => t.slot === 0);
const pcs = (b) => b.agents || [];
const pc = (b, id) => pcs(b).find((a) => String(a.id) === String(id));

console.log('an encrypted account, holding its own key');
const call = client();
const { keys, body } = await newAccount(`deck${stamp}@example.com`, PASSWORD);
let r = await call('/api/register', body);
check('the account was made', r.status === 200, JSON.stringify(r.data));
const { dataKey } = await subKeysFrom(keys.masterRaw);
const { rows: me } = await db.query('select id from users where email = $1', [`deck${stamp}@example.com`]);
const userId = me[0].id;

let board = (await call('/api/board')).data;
const square = first(board);
const seal = (obj) => encryptText(dataKey, JSON.stringify(obj));

console.log('a command cannot be put on a board that is not encrypted');
{
  // Registration always makes keys now, so the only way to have such a board
  // is to be one from before — which is what this account is made into for a
  // moment, straight in the database, and then made back.
  await db.query('update users set encryption_version = 0 where id = $1', [userId]);
  r = await call('/api/task', {
    taskId: square.id, page: board.page,
    commandSealed: await seal({ kind: 'url', args: { url: 'https://example.com' } }),
  });
  check('the command is refused', r.status === 400, `status ${r.status}`);
  check('and the refusal says why', String(r.data && r.data.error).includes('encryption'),
    JSON.stringify(r.data));
  await db.query('update users set encryption_version = 1 where id = $1', [userId]);

  const view = (await call('/api/board')).data;
  check('nothing was stored', !first(view).command_sealed);
}

console.log('a command on a square, sealed here');
{
  r = await call('/api/task', {
    taskId: square.id, page: board.page,
    commandSealed: await seal({ kind: 'url', args: { url: 'https://example.com' } }),
    runStateId: '', okStateId: '', failStateId: '',
  });
  check('the save is accepted', r.status === 200, JSON.stringify(r.data));
  board = r.data;
  check('the board carries the sealed command', Boolean(first(board).command_sealed));
  check('the pickers were left to the defaults',
    first(board).run_state_id === null && first(board).ok_state_id === null
    && first(board).fail_state_id === null);
  check('the command is not readable in the database',
    !(await db.query('select command_sealed from tasks where id = $1', [square.id]))
      .rows[0].command_sealed.includes('echo'));

  const stranger = await call('/api/task', { taskId: square.id, page: board.page, runStateId: 999999999 });
  check('a state that is not this account\'s is refused', stranger.status === 400, `status ${stranger.status}`);

  // A text square's way of typing travels inside the seal with the rest
  // (T-087): saved as chosen, read back as chosen — and a square sealed
  // without one, as every text square was before, reads as burst (T-092).
  r = await call('/api/task', { taskId: square.id, page: board.page,
    commandSealed: await seal({ kind: 'text', args: { key: 't', text: '/gamemode creative', mode: 'burst' } }) });
  check('a text square saved with burst is accepted', r.status === 200, JSON.stringify(r.data));
  let stored = JSON.parse(await decryptText(dataKey, first(r.data).command_sealed));
  check('and reads back as burst', stored.kind === 'text' && stored.args.mode === 'burst'
    && textMode(stored.args) === 'burst', JSON.stringify(stored));
  r = await call('/api/task', { taskId: square.id, page: board.page,
    commandSealed: await seal({ kind: 'text', args: { key: 't', text: '/gamemode creative' } }) });
  stored = JSON.parse(await decryptText(dataKey, first(r.data).command_sealed));
  check('one saved without a mode reads as burst', stored.args.mode === undefined && textMode(stored.args) === 'burst',
    JSON.stringify(stored));
  // Back to the url command the rest of this file presses.
  r = await call('/api/task', { taskId: square.id, page: board.page,
    commandSealed: await seal({ kind: 'url', args: { url: 'https://example.com' } }) });
  check('and the square takes the url command back', r.status === 200, JSON.stringify(r.data));
  board = r.data;
}

console.log('a tap on a command square follows no arrow');
{
  const before = nameOf(board, first(board).state_id);
  r = await call('/api/tap', { taskId: square.id, page: board.page, side: 'left' });
  check('the tap answers, and says it is a command square',
    r.status === 200 && r.data.command === true && r.data.moved === false, JSON.stringify(r.data));
  check('and the square did not move', nameOf(r.data.board, first(r.data.board).state_id) === before);
}

console.log('a token nobody has');
{
  const res = await fetch(`${BASE}/agent/nobody-has-this-token/events`);
  check('the stream is refused with 404', res.status === 404, `status ${res.status}`);
  const ack = await agentPost('nobody-has-this-token', '/jobs/1/ack');
  check('and so is a receipt', ack.status === 404, `status ${ack.status}`);
}

console.log('registering the PC');
let token;
let pcId;
{
  r = await call('/api/agent/register', { name: 'desk' });
  check('a token is handed over', r.status === 200 && typeof r.data.token === 'string' && r.data.token.length >= 30,
    JSON.stringify(r.data && r.data.token));
  token = r.data.token;
  pcId = r.data.id;
  board = r.data.board;
  check('and a number for it, which is no secret', /^\d+$/.test(String(pcId)), String(pcId));
  check('the board knows there is a PC', pcs(board).length === 1 && pcs(board)[0].name === 'desk',
    JSON.stringify(pcs(board)));
  check('and that one is the one just registered', String(pcs(board)[0].id) === String(pcId));
  check('switched on to begin with', pcs(board)[0].enabled === true);
  check('but the board never carries the token', !JSON.stringify(board).includes(token));
  check('it has not connected yet', pcs(board)[0].last_seen === null);
  check('and says so as an age too', pcs(board)[0].seen_ago === null);

  // What ③ 「この PC をつなぐ」 builds in the browser from this reply and the
  // key it already holds: the key is in the link and nowhere on the server.
  const link = pairLink(BASE, token, toB64(keys.masterRaw));
  const parts = parsePairLink(link);
  check('the connect code carries this token', Boolean(parts) && parts.token === token, link);
  check('and this board\'s key', Boolean(parts) && parts.key === toB64(keys.masterRaw));
  check('and this board\'s address', Boolean(parts) && parts.origin === BASE);
  const { rows: stored } = await db.query('select token from agents where user_id = $1', [userId]);
  check('the server holds the token and not the key',
    stored[0].token === token && !JSON.stringify(stored).includes(toB64(keys.masterRaw)));
}

// A board made before there was more than one PC comes through the migration
// in exactly the shape a new one starts in: the PC that was registered is
// switched on, and no square names a PC — so every square goes on reaching it.
// That is what the whole of the rest of this file then presses, unchanged.
// (The migration itself was run against a database already holding a PC and a
// square, and left both alone; see sql/011_multi_pc.sql for why the square is
// not re-aimed.)
console.log('what a board carried over from before looks like');
{
  const { rows } = await db.query('select enabled from agents where user_id = $1', [userId]);
  check('the PC that is registered is switched on', rows.every((a) => a.enabled === true),
    JSON.stringify(rows));
  const { rows: pointed } = await db.query(
    'select count(*)::int as n from tasks where user_id = $1 and agent_id is not null', [userId]);
  check('and no square names one until someone chooses', pointed[0].n === 0, JSON.stringify(pointed[0]));
}

console.log('the stream: the press, the receipt, the answer');
{
  const stream = await openStream(token, 'DESKTOP-ONE');
  check('the stream opens', stream.status === 200, `status ${stream.status}`);
  check('as server-sent events', stream.type.startsWith('text/event-stream'), stream.type);
  await wait(300);
  const seen = (await db.query('select last_seen from agents where token = $1', [token])).rows[0];
  check('connecting is noted as last seen', Boolean(seen.last_seen));
  const live = pc((await call('/api/board')).data, pcId);
  check('and the board reports it as seconds ago', live && Number.isInteger(live.seen_ago) && live.seen_ago >= 0 && live.seen_ago < 45,
    JSON.stringify(live));
  // What the machine calls itself, said on the way in, over the browser's guess.
  check('the name the PC gave itself is what the board shows', live && live.name === 'DESKTOP-ONE',
    live && live.name);

  // What the browser does on a press: an id first, then the instruction sealed
  // with that id inside it.
  r = await call('/api/job/new', { taskId: square.id });
  check('an id is reserved', r.status === 200 && /^\d+$/.test(r.data.id), JSON.stringify(r.data));
  const id = r.data.id;
  const at = Date.now();
  r = await call('/api/job/submit', {
    id, page: board.page,
    sealed: await seal({ id, at, kind: 'url', args: { url: 'https://example.com' } }),
  });
  check('the sealed instruction is accepted', r.status === 200, JSON.stringify(r.data));
  board = r.data.board;
  check('the square is now Running', nameOf(board, first(board).state_id) === 'Running',
    `now ${nameOf(board, first(board).state_id)}`);

  const job = await stream.next();
  check('the PC is handed the instruction', Boolean(job), 'nothing arrived on the stream');
  check('with the same id', job && job.id === id, job && job.id);
  check('and the sealed text as sent', job && typeof job.sealed === 'string' && job.sealed.startsWith('v1.'));
  check('and when it was made', job && typeof job.createdAt === 'string' && !Number.isNaN(Date.parse(job.createdAt)));
  const opened = job ? JSON.parse(await decryptText(dataKey, job.sealed)) : null;
  check('the PC can open it with the board\'s key', Boolean(opened) && opened.kind === 'url'
    && opened.args.url === 'https://example.com', JSON.stringify(opened));
  check('the id inside matches the id outside', Boolean(opened) && opened.id === id);
  check('and the time inside is the time of the press', Boolean(opened) && opened.at === at);
  check('nothing readable travelled', !job.sealed.includes('example'));

  const ack = await agentPost(token, `/jobs/${id}/ack`);
  check('the receipt is taken', ack.status === 200, `${ack.status} ${ack.text}`);
  const again = await agentPost(token, `/jobs/${id}/ack`);
  check('a second receipt is refused', again.status === 409, `${again.status} ${again.text}`);

  const bad = await agentPost(token, `/jobs/${id}/result`, { ok: 'yes' });
  check('a result that is not true or false is refused', bad.status === 400, `${bad.status} ${bad.text}`);

  const done = await agentPost(token, `/jobs/${id}/result`, { ok: true });
  check('the answer is taken', done.status === 200, `${done.status} ${done.text}`);
  board = (await call('/api/board')).data;
  check('success puts the square in Waiting', nameOf(board, first(board).state_id) === 'Waiting',
    `now ${nameOf(board, first(board).state_id)}`);

  const { rows: log } = await db.query(
    'select cause from moves where task_id = $1 order by id desc limit 2', [square.id]);
  check('the press was recorded as the person\'s own move',
    log[1] && log[1].cause === 'command', JSON.stringify(log));
  check('and the answer as one the board heard', log[0] && log[0].cause === 'done', JSON.stringify(log));
  const { rows: row } = await db.query('select status, result_ok, taken_at, finished_at from jobs where id = $1', [id]);
  check('the instruction is closed as done', row[0].status === 'done' && row[0].result_ok === true
    && row[0].taken_at && row[0].finished_at, JSON.stringify(row[0]));

  const late = await agentPost(token, `/jobs/${id}/result`, { ok: false });
  check('an answer to a closed instruction is refused', late.status === 409, `${late.status} ${late.text}`);

  console.log('a failure');
  r = await call('/api/job/new', { taskId: square.id });
  const id2 = r.data.id;
  await call('/api/job/submit', { id: id2, page: board.page,
    sealed: await seal({ id: id2, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  const job2 = await stream.next();
  check('the second instruction arrives on the same stream', job2 && job2.id === id2, JSON.stringify(job2));
  await agentPost(token, `/jobs/${id2}/ack`);
  const failed = await agentPost(token, `/jobs/${id2}/result`, { ok: false });
  check('the answer is taken', failed.status === 200, `${failed.status} ${failed.text}`);
  board = (await call('/api/board')).data;
  check('failure puts the square in Stopped', nameOf(board, first(board).state_id) === 'Stopped',
    `now ${nameOf(board, first(board).state_id)}`);

  console.log('an answer without a receipt');
  r = await call('/api/job/new', { taskId: square.id });
  const id3 = r.data.id;
  await call('/api/job/submit', { id: id3, page: board.page,
    sealed: await seal({ id: id3, at: Date.now(), kind: 'hotkey', args: { keys: 'ctrl+shift+f13' } }) });
  await stream.next();
  const direct = await agentPost(token, `/jobs/${id3}/result`, { ok: true });
  check('is still taken — the answer outranks the receipt', direct.status === 200, `${direct.status} ${direct.text}`);
  board = (await call('/api/board')).data;
  check('and the square moved on it', nameOf(board, first(board).state_id) === 'Waiting');

  console.log('the PC is connected but never says it has it');
  r = await call('/api/job/new', { taskId: square.id });
  const id4 = r.data.id;
  await call('/api/job/submit', { id: id4, page: board.page,
    sealed: await seal({ id: id4, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  await stream.next();
  board = (await call('/api/board')).data;
  check('Running while the five seconds run', nameOf(board, first(board).state_id) === 'Running');
  await wait(6500);
  board = (await call('/api/board')).data;
  check('after five seconds without a receipt the square is Stopped',
    nameOf(board, first(board).state_id) === 'Stopped', `now ${nameOf(board, first(board).state_id)}`);
  const { rows: gone } = await db.query('select status from jobs where id = $1', [id4]);
  check('and the instruction is marked expired', gone[0].status === 'expired', gone[0].status);
  const lateAck = await agentPost(token, `/jobs/${id4}/ack`);
  check('a receipt after that is refused', lateAck.status === 409, `${lateAck.status} ${lateAck.text}`);
  const { rows: why } = await db.query(
    'select cause from moves where task_id = $1 order by id desc limit 1', [square.id]);
  check('the move is recorded as an expiry', why[0].cause === 'expired', why[0].cause);

  stream.close();
  await wait(200);
}

console.log('no PC connected at all');
{
  r = await call('/api/job/new', { taskId: square.id });
  const id = r.data.id;
  await call('/api/job/submit', { id, page: board.page,
    sealed: await seal({ id, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  board = (await call('/api/board')).data;
  check('the square goes to Running on the press', nameOf(board, first(board).state_id) === 'Running');
  await wait(6500);
  board = (await call('/api/board')).data;
  check('and to Stopped when nobody came for it',
    nameOf(board, first(board).state_id) === 'Stopped', `now ${nameOf(board, first(board).state_id)}`);
  const { rows } = await db.query('select status from jobs where id = $1', [id]);
  check('the instruction expired', rows[0].status === 'expired', rows[0].status);

  // An expired instruction is not offered to a PC that turns up later: the
  // square has already said what became of it.
  const stream = await openStream(token);
  const stale = await stream.next(1500);
  check('a PC arriving later is not handed the expired one', stale === null, JSON.stringify(stale));
  stream.close();
}

console.log('an instruction waiting when the PC connects');
{
  r = await call('/api/job/new', { taskId: square.id });
  const id = r.data.id;
  await call('/api/job/submit', { id, page: board.page,
    sealed: await seal({ id, at: Date.now(), kind: 'obs', args: { op: 'scene', arg: 'Main' } }) });
  await wait(500);
  const stream = await openStream(token);
  const job = await stream.next();
  check('is handed over at once', job && job.id === id, JSON.stringify(job));
  await agentPost(token, `/jobs/${id}/ack`);
  await agentPost(token, `/jobs/${id}/result`, { ok: true });
  board = (await call('/api/board')).data;
  check('and runs to completion', nameOf(board, first(board).state_id) === 'Waiting');
  stream.close();
}

console.log('the square\'s own choice of states');
{
  // Point failure at the timed state instead, and see the failure land there.
  r = await call('/api/task', { taskId: square.id, page: board.page,
    failStateId: named(board, 'On it').id });
  check('the picker is stored', String(first(r.data).fail_state_id) === String(named(board, 'On it').id));
  const stream = await openStream(token);
  r = await call('/api/job/new', { taskId: square.id });
  const id = r.data.id;
  await call('/api/job/submit', { id, page: board.page,
    sealed: await seal({ id, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  await stream.next();
  await agentPost(token, `/jobs/${id}/ack`);
  await agentPost(token, `/jobs/${id}/result`, { ok: false });
  board = (await call('/api/board')).data;
  check('failure goes where the square says', nameOf(board, first(board).state_id) === 'On it',
    `now ${nameOf(board, first(board).state_id)}`);
  stream.close();
  await call('/api/task', { taskId: square.id, page: board.page, failStateId: '' });
}

console.log('taking the command off again');
{
  r = await call('/api/task', { taskId: square.id, page: board.page, commandSealed: null });
  check('an ordinary square again', !first(r.data).command_sealed);
  const refused = await call('/api/job/new', { taskId: square.id });
  check('which cannot be pressed as a command', refused.status === 400, `status ${refused.status}`);
  r = await call('/api/task', { taskId: square.id, page: board.page,
    commandSealed: await seal({ kind: 'url', args: { url: 'https://example.com' } }) });
  board = r.data;
}

console.log('another account\'s instruction is not this PC\'s business');
{
  const other = client();
  const theirs = await newAccount(`deckother${stamp}@example.com`, PASSWORD);
  await other('/api/register', theirs.body);
  const theirToken = (await other('/api/agent/register', {})).data.token;

  r = await call('/api/job/new', { taskId: square.id });
  const id = r.data.id;
  await call('/api/job/submit', { id, page: board.page,
    sealed: await seal({ id, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  const ack = await agentPost(theirToken, `/jobs/${id}/ack`);
  check('a receipt from the other PC is 404', ack.status === 404, `${ack.status} ${ack.text}`);
  const result = await agentPost(theirToken, `/jobs/${id}/result`, { ok: true });
  check('and so is an answer', result.status === 404, `${result.status} ${result.text}`);
  const theirStream = await openStream(theirToken);
  const leaked = await theirStream.next(1000);
  check('and their stream does not carry it', leaked === null, JSON.stringify(leaked));
  theirStream.close();
  const mine = await agentPost(token, `/jobs/${id}/ack`);
  check('while the right PC can still take it', mine.status === 200, `${mine.status} ${mine.text}`);
  await agentPost(token, `/jobs/${id}/result`, { ok: true });
}

// The stream marker (2026-10-05): the instruction is made and reaches the PC
// like any other; and its square, marked quiet when saved, moves on the PC's
// answer without ringing (T-500 = B). Counted at a stand-in push service, the
// way test/push-rule.js does — and checked against an ordinary square on the
// same phone first, so a silence here means quiet and not "push is not
// working". Needs what push-rule needs: test/*.pem and the notification keys.
console.log('a stream marker');
{
  const CAPTURE_PORT = Number(process.env.CAPTURE_PORT || 3099);
  let received = 0;
  const capture = https.createServer({
    key: fs.readFileSync(path.join(HERE, 'key.pem')),
    cert: fs.readFileSync(path.join(HERE, 'cert.pem')),
  }, (req, res) => {
    req.resume();
    req.on('end', () => { received += 1; res.writeHead(201); res.end(); });
  });
  await new Promise((done) => capture.listen(CAPTURE_PORT, '127.0.0.1', done));
  const endpoint = `https://127.0.0.1:${CAPTURE_PORT}/push`;
  const ecdh = crypto.createECDH('prime256v1');
  await db.query(
    `insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
     on conflict (endpoint) do update set user_id = excluded.user_id,
           p256dh = excluded.p256dh, auth = excluded.auth`,
    [userId, endpoint, ecdh.generateKeys().toString('base64url'), crypto.randomBytes(16).toString('base64url')]);
  check('the server has push keys configured', (await call('/api/me')).data.pushConfigured === true);

  const stream = await openStream(token);
  // Presses the square with the given instruction and answers as the PC:
  // `ok` true or false, or null to never come for it.
  const pressAndAnswer = async (kind, args, ok) => {
    r = await call('/api/job/new', { taskId: square.id });
    const id = r.data.id;
    const at = Date.now();
    await call('/api/job/submit', { id, page: board.page, sealed: await seal({ id, at, kind, args }) });
    const job = await stream.next();
    if (ok !== null) {
      await agentPost(token, `/jobs/${id}/ack`);
      await agentPost(token, `/jobs/${id}/result`, { ok });
      await wait(1500);
    } else {
      await wait(7000);
    }
    return { id, at, job };
  };

  received = 0;
  await pressAndAnswer('url', { url: 'https://example.com' }, true);
  check('an ordinary square on this phone rings once when the PC answers', received === 1, `received ${received}`);

  r = await call('/api/task', { taskId: square.id, page: board.page,
    commandSealed: await seal({ kind: 'marker', args: { label: '神プレイ' } }), quiet: true });
  check('a marker square is saved', r.status === 200, JSON.stringify(r.data));
  board = r.data;
  check('the board holds it as quiet', first(board).quiet === true, String(first(board).quiet));
  const stored = JSON.parse(await decryptText(dataKey, first(board).command_sealed));
  check('and the command, sealed, is the marker with its label', stored.kind === 'marker'
    && stored.args.label === '神プレイ', JSON.stringify(stored));
  check('which the database cannot read', !first(board).command_sealed.includes('marker'));

  received = 0;
  const { id, at, job } = await pressAndAnswer('marker', markerArgs({ label: '神プレイ' }, 'ja'), true);
  check('the PC is handed the marker', job && job.id === id, JSON.stringify(job));
  const opened = job ? JSON.parse(await decryptText(dataKey, job.sealed)) : null;
  check('and opens it as {"kind":"marker","args":{"label":…,"lang":"ja"}} with the press time',
    Boolean(opened) && opened.kind === 'marker' && opened.args.label === '神プレイ' && opened.args.lang === 'ja'
    && opened.id === id && opened.at === at, JSON.stringify(opened));
  board = (await call('/api/board')).data;
  check('success still moves the square to Waiting', nameOf(board, first(board).state_id) === 'Waiting',
    nameOf(board, first(board).state_id));
  check('but nothing rang', received === 0, `received ${received}`);

  received = 0;
  await pressAndAnswer('marker', markerArgs({ label: '' }, 'en'), false);
  board = (await call('/api/board')).data;
  check('a failure moves it to Stopped', nameOf(board, first(board).state_id) === 'Stopped',
    nameOf(board, first(board).state_id));
  const lastCause = async () => (await db.query(
    'select cause from moves where task_id = $1 order by id desc limit 1', [square.id])).rows[0].cause;
  check('recorded as the failure', (await lastCause()) === 'failed');
  check('and rings nothing either', received === 0, `received ${received}`);

  received = 0;
  await pressAndAnswer('marker', markerArgs({ label: '' }, 'en'), null);
  board = (await call('/api/board')).data;
  check('nobody coming for it moves it to Stopped', nameOf(board, first(board).state_id) === 'Stopped',
    nameOf(board, first(board).state_id));
  check('recorded as the expiry', (await lastCause()) === 'expired');
  check('and rings nothing', received === 0, `received ${received}`);

  // Anything but a strict true is not quiet; and saved back as an ordinary
  // command, the same square rings again.
  r = await call('/api/task', { taskId: square.id, page: board.page, quiet: 'yes' });
  check('quiet is only ever a strict true', first(r.data).quiet === false, String(first(r.data).quiet));
  r = await call('/api/task', { taskId: square.id, page: board.page,
    commandSealed: await seal({ kind: 'url', args: { url: 'https://example.com' } }), quiet: false });
  board = r.data;
  check('back to an ordinary command, not quiet', first(board).quiet === false);
  received = 0;
  await pressAndAnswer('url', { url: 'https://example.com' }, true);
  check('and it rings once again', received === 1, `received ${received}`);

  stream.close();
  await db.query('delete from push_subscriptions where endpoint = $1', [endpoint]);
  capture.close();
  await wait(200);
}

console.log('registering again adds a second PC rather than replacing the first');
let token2;
let pcId2;
{
  r = await call('/api/agent/register', { name: 'laptop' });
  token2 = r.data.token;
  pcId2 = r.data.id;
  check('a different token', token2 && token2 !== token);
  check('and a different number', String(pcId2) !== String(pcId));
  check('both PCs are on the account',
    Number((await db.query('select count(*) from agents where user_id = $1', [userId])).rows[0].count) === 2);
  board = r.data.board;
  // The first one is called what it said it was called when it connected,
  // which is no longer 「desk」; the second has only the browser's guess so far.
  check('and the board lists both', pcs(board).length === 2
    && pcs(board).map((a) => a.name).join(',') === 'DESKTOP-ONE,laptop', JSON.stringify(pcs(board)));
  check('neither token is on the board', !JSON.stringify(board).includes(token)
    && !JSON.stringify(board).includes(token2));

  // The first PC's token used to stop working at this point. It is the whole
  // of the reason the second one could not be added before.
  const older = await openStream(token);
  check('the first one still works', older.status === 200, `status ${older.status}`);
  older.close();
  await wait(200);
}

// With nothing chosen on the square, an instruction goes to every PC that is
// switched on — which is what every square made before today means, and what
// the one on this board still means.
console.log('an instruction with no PC chosen goes to both');
{
  const one_ = await openStream(token);
  const two = await openStream(token2);
  r = await call('/api/job/new', { taskId: square.id });
  const id = r.data.id;
  await call('/api/job/submit', { id, page: board.page,
    sealed: await seal({ id, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  const [a, b] = [await one_.next(), await two.next()];
  check('the first PC is handed it', a && a.id === id, JSON.stringify(a));
  check('and so is the second', b && b.id === id, JSON.stringify(b));

  // Two PCs carrying out the same instruction is the ordinary case now, and
  // the answer is the first one's. This is the behaviour the brief says not
  // to change, so it is written down.
  const first_ = await agentPost(token, `/jobs/${id}/ack`);
  check('the first receipt is taken', first_.status === 200, `${first_.status} ${first_.text}`);
  const second = await agentPost(token2, `/jobs/${id}/ack`);
  check('the second is refused as already taken', second.status === 409, `${second.status} ${second.text}`);
  await agentPost(token2, `/jobs/${id}/result`, { ok: true });
  board = (await call('/api/board')).data;
  check('and whichever answered first decides where the square goes',
    nameOf(board, first(board).state_id) === 'Waiting', nameOf(board, first(board).state_id));
  one_.close(); two.close();
  await wait(200);
}

console.log('a PC that is switched off');
{
  const one_ = await openStream(token);
  const two = await openStream(token2);
  r = await call('/api/agent/enabled', { id: pcId2, on: false });
  check('the switch is stored', pc(r.data, pcId2).enabled === false, JSON.stringify(pcs(r.data)));
  check('and the other one is untouched', pc(r.data, pcId).enabled === true);

  r = await call('/api/job/new', { taskId: square.id });
  const id = r.data.id;
  await call('/api/job/submit', { id, page: board.page,
    sealed: await seal({ id, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  const went = await one_.next();
  check('the PC that is on still gets it', went && went.id === id, JSON.stringify(went));
  check('the one that is off gets nothing', (await two.next(1200)) === null);
  // Switched off is not unregistered: the connection is still open.
  check('but it is still connected', !two.closed);
  await agentPost(token, `/jobs/${id}/ack`);
  await agentPost(token, `/jobs/${id}/result`, { ok: true });

  // Nor is it handed the waiting ones when it comes back: they were never for
  // it. A fresh connection while switched off is offered nothing at all.
  r = await call('/api/job/new', { taskId: square.id });
  const id2 = r.data.id;
  await call('/api/job/submit', { id: id2, page: board.page,
    sealed: await seal({ id: id2, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  await one_.next();
  const rejoined = await openStream(token2);
  check('and connecting again while off is handed nothing', (await rejoined.next(1200)) === null);
  rejoined.close();
  await agentPost(token, `/jobs/${id2}/ack`);
  await agentPost(token, `/jobs/${id2}/result`, { ok: true });

  console.log('switched back on');
  r = await call('/api/agent/enabled', { id: pcId2, on: true });
  check('the switch is stored the other way', pc(r.data, pcId2).enabled === true);
  r = await call('/api/job/new', { taskId: square.id });
  const id3 = r.data.id;
  await call('/api/job/submit', { id: id3, page: board.page,
    sealed: await seal({ id: id3, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  const back = await two.next();
  // On the stream that was open the whole time: nothing had to reconnect.
  check('it is receiving again at once, on the connection it never dropped',
    back && back.id === id3, JSON.stringify(back));
  await agentPost(token2, `/jobs/${id3}/ack`);
  await agentPost(token2, `/jobs/${id3}/result`, { ok: true });
  one_.close(); two.close();
  await wait(200);
}

console.log('a square that names one PC');
{
  const one_ = await openStream(token);
  const two = await openStream(token2);
  r = await call('/api/task', { taskId: square.id, page: board.page, agentId: pcId2 });
  check('the choice is stored', String(first(r.data).agent_id) === String(pcId2),
    String(first(r.data).agent_id));
  // The board has to read the address to deliver, so that one field is in the
  // clear. What the instruction says stays sealed, which is the property that
  // matters and the one this checks has not moved.
  check('the command itself is still unreadable here', Boolean(first(r.data).command_sealed)
    && !first(r.data).command_sealed.includes('echo'));

  r = await call('/api/job/new', { taskId: square.id });
  const id = r.data.id;
  await call('/api/job/submit', { id, page: board.page,
    sealed: await seal({ id, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  const mine = await two.next();
  check('the named PC is handed it', mine && mine.id === id, JSON.stringify(mine));
  check('and the other one is not', (await one_.next(1200)) === null);
  await agentPost(token2, `/jobs/${id}/ack`);
  await agentPost(token2, `/jobs/${id}/result`, { ok: true });

  // Aimed at a PC that is switched off: not handed to the others instead.
  console.log('the named PC is switched off');
  await call('/api/agent/enabled', { id: pcId2, on: false });
  r = await call('/api/job/new', { taskId: square.id });
  const id2 = r.data.id;
  await call('/api/job/submit', { id: id2, page: board.page,
    sealed: await seal({ id: id2, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  check('the PC that is on is not given it instead', (await one_.next(1200)) === null);
  check('nor is the one it was for', (await two.next(1200)) === null);
  await wait(5000);
  board = (await call('/api/board')).data;
  check('and the square fails the way it does when nobody comes',
    nameOf(board, first(board).state_id) === 'Stopped', nameOf(board, first(board).state_id));
  const { rows: how } = await db.query('select status from jobs where id = $1', [id2]);
  check('the instruction expired — no new kind of failure', how[0].status === 'expired', how[0].status);
  await call('/api/agent/enabled', { id: pcId2, on: true });
  one_.close(); two.close();
  await wait(200);
}

console.log('unregistering one PC');
{
  const one_ = await openStream(token);
  const two = await openStream(token2);
  await wait(200);
  r = await call('/api/agent/delete', { id: pcId2 });
  check('it is off the list', pcs(r.data).length === 1 && String(pcs(r.data)[0].id) === String(pcId),
    JSON.stringify(pcs(r.data)));
  await wait(400);
  check('its stream was closed from this end', two.closed);
  check('and the other PC was left alone', !one_.closed);
  const back = await fetch(`${BASE}/agent/${token2}/events`);
  check('its token cannot be used to come back', back.status === 404, `status ${back.status}`);

  // The square is still pointed at it. It is not quietly re-aimed at every PC:
  // that would send an instruction meant for one machine to all of them, on a
  // day nobody asked for it.
  board = (await call('/api/board')).data;
  check('the square still names the PC that is gone',
    String(first(board).agent_id) === String(pcId2), String(first(board).agent_id));
  r = await call('/api/job/new', { taskId: square.id });
  const id = r.data.id;
  await call('/api/job/submit', { id, page: board.page,
    sealed: await seal({ id, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  check('the PC still registered is not handed it', (await one_.next(1200)) === null);
  await wait(5000);
  board = (await call('/api/board')).data;
  check('and the square fails', nameOf(board, first(board).state_id) === 'Stopped',
    nameOf(board, first(board).state_id));

  // The square may keep naming the PC that has gone — but it may not be
  // pointed at a number that was never this account's.
  const stranger = await call('/api/task', { taskId: square.id, page: board.page, agentId: 999999999 });
  check('a PC that is not this account\'s is refused', stranger.status === 400, `status ${stranger.status}`);
  const kept = await call('/api/task', { taskId: square.id, page: board.page, agentId: pcId2 });
  check('but saving the square again keeps the one it already names', kept.status === 200,
    JSON.stringify(kept.data));

  one_.close();
  await wait(200);
}

console.log('pointing the square back at every PC that is on');
{
  r = await call('/api/task', { taskId: square.id, page: board.page, agentId: '' });
  check('the choice is cleared', first(r.data).agent_id === null, String(first(r.data).agent_id));
  board = r.data;
  const stream = await openStream(token);
  r = await call('/api/job/new', { taskId: square.id });
  const id = r.data.id;
  await call('/api/job/submit', { id, page: board.page,
    sealed: await seal({ id, at: Date.now(), kind: 'url', args: { url: 'https://example.com' } }) });
  const job = await stream.next();
  check('and it reaches the PC again', job && job.id === id, JSON.stringify(job));
  await agentPost(token, `/jobs/${id}/ack`);
  await agentPost(token, `/jobs/${id}/result`, { ok: true });
  stream.close();
  await wait(200);
}

console.log('a ceiling on the PC\'s inlet');
{
  let limited = 0;
  let accepted = 0;
  for (let i = 0; i < 620; i += 1) {
    const res = await fetch(`${BASE}/agent/${token}/jobs/1/ack`, { method: 'POST' });
    if (res.status === 429) limited += 1; else accepted += 1;
  }
  check('calls are refused once the ceiling is passed', limited > 0, `accepted all ${accepted}`);
  check('ordinary volumes are not touched', accepted >= 500, `only ${accepted} got through`);
  const stream = await fetch(`${BASE}/agent/${token}/events`);
  check('the stream is held off too', stream.status === 429, `status ${stream.status}`);
}

await db.end();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
