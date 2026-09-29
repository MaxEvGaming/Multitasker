// The route that hands over the nightly copy.
//
// It is worth being careful with: the file holds every account's data — email
// addresses, device addresses, and the ciphertext of everything else. So the
// interesting cases here are all the ways it should refuse, not the one way it
// should work.
//
// Runs its own server, because this needs a token and a directory of pretend
// backups that the shared one does not have.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3042;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'a-token-long-enough-to-be-accepted';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-backups-'));
fs.writeFileSync(path.join(dir, 'taskboard-20260101-000000.dump'), 'an older copy');
fs.writeFileSync(path.join(dir, 'taskboard-20260824-181652.dump'), 'the newest copy');
fs.writeFileSync(path.join(dir, 'env-20260101-000000'), 'OLD=1');
fs.writeFileSync(path.join(dir, 'env-20260824-181652'), 'VAPID_PRIVATE_KEY=newest');

const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), BACKUP_TOKEN: TOKEN, BACKUP_DIR: dir },
  stdio: 'ignore',
});
const stop = () => { try { server.kill(); } catch (_) {} };
process.on('exit', stop);

for (let tries = 0; tries < 60; tries += 1) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (_) { /* not yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

const ask = (token, what) => fetch(
  `${BASE}/api/backup${what ? `?what=${what}` : ''}`,
  token === null ? {} : { headers: { 'X-Backup-Token': token } }
);

console.log('without the token it does not admit to existing');
{
  const none = await ask(null);
  check('no token at all is a 404, not a 401', none.status === 404, `status ${none.status}`);

  const wrong = await ask('a-token-long-enough-to-be-rejected');
  check('a wrong token of the same length is a 404', wrong.status === 404, `status ${wrong.status}`);

  const shorter = await ask(TOKEN.slice(0, -1));
  check('a truncated token is a 404', shorter.status === 404, `status ${shorter.status}`);

  const longer = await ask(`${TOKEN}x`);
  check('an extended one is too', longer.status === 404, `status ${longer.status}`);

  // Nothing about the answer should hint that a token would help.
  check('and the body gives nothing away', (await none.text()).length < 40);
}

console.log('with it, the newest copy comes back');
{
  const res = await ask(TOKEN);
  check('the request is answered', res.status === 200, `status ${res.status}`);
  check('it is the newest one, not the first found',
    res.headers.get('x-backup-name') === 'taskboard-20260824-181652.dump',
    res.headers.get('x-backup-name'));
  check('the contents are the file itself', (await res.text()) === 'the newest copy');
  check('and it is offered as a download rather than shown',
    /attachment/.test(res.headers.get('content-disposition') || ''));
  check('nothing caches it', /no-store/.test(res.headers.get('cache-control') || ''));
}

console.log('the keys come separately');
{
  const res = await ask(TOKEN, 'env');
  check('the env is the newest env', res.headers.get('x-backup-name') === 'env-20260824-181652',
    res.headers.get('x-backup-name'));
  check('and not a dump', (await res.text()) === 'VAPID_PRIVATE_KEY=newest');
}

console.log('what cannot be asked for');
{
  // The name is chosen by the server from a fixed pair of prefixes, so there is
  // nothing here to point at another file.
  const climbing = await fetch(`${BASE}/api/backup?what=${encodeURIComponent('../../etc/passwd')}`,
    { headers: { 'X-Backup-Token': TOKEN } });
  check('an odd "what" falls back to the dump rather than reaching out',
    climbing.headers.get('x-backup-name') === 'taskboard-20260824-181652.dump',
    climbing.headers.get('x-backup-name'));
}

console.log('and when there is nothing to hand over');
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-empty-'));
  const bare = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: '3043', BACKUP_TOKEN: TOKEN, BACKUP_DIR: empty },
    stdio: 'ignore',
  });
  for (let tries = 0; tries < 60; tries += 1) {
    try { if ((await fetch('http://127.0.0.1:3043/api/health')).ok) break; } catch (_) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const res = await fetch('http://127.0.0.1:3043/api/backup', { headers: { 'X-Backup-Token': TOKEN } });
  check('it says so rather than pretending', res.status === 503, `status ${res.status}`);
  bare.kill();
  fs.rmSync(empty, { recursive: true, force: true });
}

console.log('and when nobody set a token, the route is not there at all');
{
  const { BACKUP_TOKEN, ...noToken } = process.env;
  const shut = spawn(process.execPath, ['src/server.js'], {
    env: { ...noToken, PORT: '3044', BACKUP_DIR: dir },
    stdio: 'ignore',
  });
  for (let tries = 0; tries < 60; tries += 1) {
    try { if ((await fetch('http://127.0.0.1:3044/api/health')).ok) break; } catch (_) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const res = await fetch('http://127.0.0.1:3044/api/backup', { headers: { 'X-Backup-Token': TOKEN } });
  check('closed by default', res.status === 404, `status ${res.status}`);
  shut.kill();
}

stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
