// A turn that ends on an API error — a usage limit, an overloaded server — fires
// StopFailure instead of Stop. The square used to stay on running for good,
// because the hook threw that event away.
//
// What it has to do now: say "エラーで止まりました", mark the send with
// "event": "failure" in the clear (so the board can say it was an error on the
// phone, sealed board or not), hold for the same quiet
// window as a normal stop, give way to an instruction that arrives inside it —
// and NOT wait on background work, because the session has stopped whatever is
// still running behind it. A normal Stop must still wait on that work as before.
//
// Runs a copy of the script that is handed out, in a scratch folder, against a
// listener on this machine. Nothing goes to a real board.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVED = path.join(HERE, '..', 'public', 'download', 'notify.js');
const QUIET = 2;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Everything that reaches the listener, with when it arrived.
const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body); } catch (_) {}
    received.push({ at: Date.now(), json });
    res.writeHead(200); res.end('ok: moved');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stopfailure-'));
const appdata = path.join(scratch, 'appdata'); // so the title lookup finds nothing and uses cwd
fs.mkdirSync(appdata);

function setup(name, extra) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir);
  fs.copyFileSync(SERVED, path.join(dir, 'notify.js'));
  fs.writeFileSync(path.join(dir, 'notify.json'), JSON.stringify({
    default: `http://127.0.0.1:${port}/in`, quietSeconds: QUIET, ...extra,
  }));
  return dir;
}
const plain = setup('plain', { allowPlaintext: true });

// A transcript that shows a background command started and never finished.
const stamp = () => new Date().toISOString();
const busyLine = () => `{"timestamp":"${stamp()}","text":"Command running in background with ID: bg123"}\n`;
const transcript = (name, busy) => {
  const file = path.join(scratch, `${name}.jsonl`);
  fs.writeFileSync(file, `{"timestamp":"${stamp()}","text":"hello"}\n` + (busy ? busyLine() : ''));
  return file;
};

function hook(dir, input, ...flags) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'notify.js'), '--hook', ...flags], {
      env: { ...process.env, APPDATA: appdata }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
    });
    child.on('exit', (code) => resolve({ code, at: Date.now() }));
    child.stdin.end(JSON.stringify(input));
  });
}
const logOf = (dir) => { try { return fs.readFileSync(path.join(dir, 'notify.log'), 'utf8'); } catch (_) { return ''; } };
const sentFor = (name) => received.filter((r) => r.json && typeof r.json.text === 'string' && r.json.text.startsWith(`*${name}*`));
const input = (event, name, file, extra = {}) => ({
  hook_event_name: event, session_id: `sess-${name}`, cwd: path.join(scratch, 'cwd', name), transcript_path: file, ...extra,
});

// --- the cases, started together so the quiet windows overlap ---------------

// 1. Error stop while a background job is running: held, then sent anyway.
const r1 = await hook(plain, input('StopFailure', 'errbusy', transcript('errbusy', true), { error_type: 'rate_limit', error_message: 'limit' }));
// 2. Error stop, then an instruction for the same session inside the hold.
const r2 = await hook(plain, input('StopFailure', 'errcancel', transcript('errcancel', false), { error_type: 'unknown' }));
await wait(300);
const r2b = await hook(plain, input('UserPromptSubmit', 'errcancel', transcript('errcancel', false)), '--start');
// 3. Error stop, a job starts during the hold: still sent.
const f3 = transcript('errlate', false);
const r3 = await hook(plain, input('StopFailure', 'errlate', f3, { error_type: 'overloaded' }));
fs.appendFileSync(f3, busyLine());
// 4. Normal stop while a background job runs: not sent, not even held.
const r4 = await hook(plain, input('Stop', 'stopbusy', transcript('stopbusy', true)));
// 5. Normal stop, nothing running: held, then "入力待ちです".
const r5 = await hook(plain, input('Stop', 'stopidle', transcript('stopidle', false)));
// 6. Normal stop, a job starts during the hold: dropped at delivery, as before.
const f6 = transcript('stoplate', false);
const r6 = await hook(plain, input('Stop', 'stoplate', f6));
fs.appendFileSync(f6, busyLine());
// 7. An error stop with no error_type at all is still taken.
const r7 = await hook(plain, input('StopFailure', 'errnotype', transcript('errnotype', false)));

console.log('every hook returns at once and exits 0');
for (const [label, r] of [['1', r1], ['2', r2], ['2b', r2b], ['3', r3], ['4', r4], ['5', r5], ['6', r6], ['7', r7]]) {
  check(`case ${label} exit 0`, r.code === 0, `exit ${r.code}`);
}

await wait(QUIET * 500);
console.log(`nothing leaves before the ${QUIET}s hold is up`);
check('no error stop sent yet', sentFor('errbusy').length === 0 && sentFor('errlate').length === 0,
  JSON.stringify(received.map((r) => r.json)));
check('no normal stop sent yet', sentFor('stopidle').length === 0);

await wait(QUIET * 1000 + 2500);
const log = logOf(plain);

console.log('a StopFailure says "エラーで止まりました" and waits the same hold');
{
  const sent = sentFor('errbusy');
  check('sent exactly once', sent.length === 1, `sent ${sent.length}`);
  check('wording', sent[0] && sent[0].json.text === '*errbusy* — エラーで止まりました', sent[0] && sent[0].json.text);
  check('carries the "failure" marker', sent[0] && sent[0].json.event === 'failure', sent[0] && JSON.stringify(sent[0].json));
  const held = sent[0] ? sent[0].at - r1.at : -1;
  check(`held about ${QUIET}s`, held >= QUIET * 1000 - 200, `${held} ms`);
  check('log says what it took and that background work was not checked',
    log.includes(`held ${QUIET}s: errbusy / エラーで止まりました (StopFailure rate_limit — background work not checked)`));
  check('log records the send', log.includes('sent: errbusy / エラーで止まりました'));
  // The skip line carries no name. Two hooks met a busy transcript — this one
  // and the normal Stop in case 4 — so exactly one skip means it was case 4's.
  check('not skipped for background work', (log.match(/skip: \d+ background job/g) || []).length === 1
    && !log.includes('dropped at delivery: errbusy'));
}

console.log('an instruction inside the hold cancels a held StopFailure');
{
  const stops = sentFor('errcancel').filter((r) => r.json.event !== 'start');
  const starts = sentFor('errcancel').filter((r) => r.json.event === 'start');
  check('the error stop was not sent', stops.length === 0, JSON.stringify(stops.map((r) => r.json)));
  check('the instruction went out as start', starts.length === 1 && starts[0].json.text === '*errcancel* — 作業中');
  check('log notes the drop', log.includes('dropped a held stop: an instruction arrived first'));
}

console.log('a job starting during the hold does not stop an error stop');
{
  const sent = sentFor('errlate');
  check('sent', sent.length === 1 && sent[0].json.text === '*errlate* — エラーで止まりました', JSON.stringify(sent.map((r) => r.json)));
  check('not dropped at delivery', !log.includes('dropped at delivery: errlate'));
  check('carries the "failure" marker', sent[0] && sent[0].json.event === 'failure');
}

console.log('a StopFailure without error_type is still taken');
{
  const sent = sentFor('errnotype');
  check('sent', sent.length === 1 && sent[0].json.text === '*errnotype* — エラーで止まりました');
  check('logged as unknown', log.includes('errnotype / エラーで止まりました (StopFailure unknown'));
  check('carries the "failure" marker', sent[0] && sent[0].json.event === 'failure');
}

console.log('a normal Stop still waits on background work');
{
  check('busy at the hook: nothing sent', sentFor('stopbusy').length === 0);
  check('busy at the hook: skipped, not held', log.includes('skip: 1 background job(s) still running (bg123)')
    && !log.includes('held 2s: stopbusy'));
  const idle = sentFor('stopidle');
  check('idle: sent "入力待ちです"', idle.length === 1 && idle[0].json.text === '*stopidle* — 入力待ちです');
  check('idle: no marker at all, as before', idle[0] && idle[0].json.event === undefined, idle[0] && JSON.stringify(idle[0].json));
  check('idle: held line unchanged', /held 2s: stopidle \/ 入力待ちです\n/.test(log));
  check('job started in the hold: nothing sent', sentFor('stoplate').length === 0);
  check('job started in the hold: dropped at delivery', log.includes('dropped at delivery: stoplate started 1 job(s) during the hold'));
}

console.log('on an encrypted board the error stop is sealed like any stop, with the marker in the clear');
{
  const key = Buffer.from(crypto.randomBytes(32)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sealed = setup('sealed', { key });
  const before = received.length;
  const r = await hook(sealed, input('StopFailure', 'errsealed', transcript('errsealed', true), { error_type: 'billing_error' }));
  check('exit 0', r.code === 0);
  await wait(QUIET * 1000 + 2500);
  const got = received.slice(before);
  check('one send', got.length === 1, `${got.length}`);
  const body = got[0] && got[0].json;
  check('hash, sealed name and the "failure" marker only', body && body.matchHash && /^v1\./.test(body.nameCipher)
    && body.event === 'failure' && body.text === undefined
    && Object.keys(body).sort().join(',') === 'event,matchHash,nameCipher', JSON.stringify(body));
  check('nothing readable in it', body && !JSON.stringify(body).includes('errsealed') && !JSON.stringify(body).includes('エラー'));
}

console.log('the shown log');
console.log(logOf(plain).trim().split('\n').map((l) => `    ${l}`).join('\n'));

server.close();
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
