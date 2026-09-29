// The C# side of the sealing, checked against the browser's, on the shipped
// binary rather than on a copy of its code: `DeckAgent.exe --check-seal` is
// run over test/vectors/deck-seal.json and over a text the browser's own
// encryptText sealed a moment ago (random IV), and what it prints is compared
// with what the browser holds.
//
//   node test/deck-seal-agent.js
//
// Needs a built agent — agent/publish/DeckAgent.exe (agent/build.ps1) or the
// Release/Debug build — or DECK_AGENT_EXE pointing at one. Windows only, as is
// the agent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { subKeysFrom, encryptText, fromB64 } from '../public/crypto.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const VECTOR = path.join(HERE, 'vectors', 'deck-seal.json');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const candidates = [
  process.env.DECK_AGENT_EXE,
  path.join(ROOT, 'agent', 'publish', 'DeckAgent.exe'),
  path.join(ROOT, 'agent', 'bin', 'Release', 'net10.0-windows', 'DeckAgent.exe'),
  path.join(ROOT, 'agent', 'bin', 'Debug', 'net10.0-windows', 'DeckAgent.exe'),
].filter(Boolean);
const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) {
  console.log(`  FAIL no agent binary — build it first (agent\\build.ps1) or set DECK_AGENT_EXE. Looked at:\n    ${candidates.join('\n    ')}`);
  process.exit(1);
}
console.log(`the agent: ${path.relative(process.cwd(), exe)}`);

// What the exe prints: one `name value` per line.
function run(vectorPath, extra) {
  const args = ['--check-seal', vectorPath];
  if (extra !== undefined) args.push(extra);
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
  const facts = {};
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const at = line.indexOf(' ');
    if (at > 0) facts[line.slice(0, at)] = line.slice(at + 1);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, facts };
}

const vector = JSON.parse(fs.readFileSync(VECTOR, 'utf8'));
const master = fromB64(vector.masterKeyBase64url);
const { dataKey } = await subKeysFrom(master);

console.log('the pinned vector, opened by the agent');
{
  const sealedByBrowser = await encryptText(dataKey, vector.plaintext);
  const r = run(VECTOR, sealedByBrowser);
  check('the agent runs and reports success', r.status === 0, `exit ${r.status}\n${r.stdout}${r.stderr}`);
  check('it derives the same data key', r.facts.dataKey === vector.dataKeyHex, `${r.facts.dataKey} vs ${vector.dataKeyHex}`);
  check('it opens the pinned sealed text to the pinned plaintext', r.facts.plaintext === vector.plaintext, JSON.stringify(r.facts.plaintext));
  check('and re-seals the plaintext under the pinned IV to the same bytes', r.facts.resealed === vector.sealed, r.facts.resealed);
  check('the browser\'s own seal (random IV) differs from the pinned one', sealedByBrowser !== vector.sealed);
  check('and the agent opens it to the same text', r.facts.extra === vector.plaintext, JSON.stringify(r.facts.extra) + (r.facts['extra-error'] ? ` (${r.facts['extra-error']})` : ''));
  check('nothing readable was in what the browser sent', !sealedByBrowser.includes('echo'));
}

console.log('what the agent must refuse');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-seal-agent-'));
  try {
    // A vector under a different key: the same sealed text opens to nothing.
    const other = { ...vector, masterKeyBase64url: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc' };
    const otherFile = path.join(tmp, 'other-key.json');
    fs.writeFileSync(otherFile, JSON.stringify(other));
    const wrongKey = run(otherFile);
    check('a different key does not open the pinned text', wrongKey.status !== 0 && wrongKey.facts.plaintext === undefined,
      `exit ${wrongKey.status}\n${wrongKey.stdout}`);

    // One character changed in the browser's seal: the tag no longer matches.
    const sealedByBrowser = await encryptText(dataKey, vector.plaintext);
    const last = sealedByBrowser.at(-1);
    const damaged = sealedByBrowser.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    const tampered = run(VECTOR, damaged);
    check('a damaged seal is refused', tampered.status !== 0 && tampered.facts.extra === undefined && Boolean(tampered.facts['extra-error']),
      `exit ${tampered.status}\n${tampered.stdout}`);

    const notV1 = run(VECTOR, sealedByBrowser.replace(/^v1\./, 'v2.'));
    check('a version it does not know is refused', notV1.status !== 0 && notV1.facts.extra === undefined, notV1.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
