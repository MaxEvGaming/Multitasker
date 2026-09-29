// The script the board hands out has to be the script that actually works.
//
// Setting the hook up by having each person's Claude write its own was how it
// was done first, and the quality varied — the implementation in this repository
// had a fault where the held path went out unsealed, found only because a square
// stopped moving. Handing over a copy of the working one is safer, but only
// while it stays a copy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const served = path.join(HERE, '..', 'public', 'download', 'notify.js');
const real = path.join(HERE, '..', '..', '..', 'tools', 'claude-notify', 'notify.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('the copy on offer is the one in use');
{
  const a = fs.readFileSync(served);
  const b = fs.readFileSync(real);
  check('byte for byte the same', Buffer.compare(a, b) === 0,
    `served ${a.length} bytes, real ${b.length} bytes — copy it again`);
}

console.log('and it carries nothing personal');
{
  const text = fs.readFileSync(served, 'utf8');
  // The address and the key live in notify.json, which is not handed out. If
  // either ever leaks into the script itself, everyone who downloads it gets a
  // way into the board it came from.
  check('no webhook address baked in', !/board\.example\.com|\/hook\//.test(text));
  check('no key baked in', !/"key"\s*:\s*"[A-Za-z0-9_-]{20,}"/.test(text));
  check('no email baked in', !/@[a-z0-9-]+\.[a-z]{2,}/i.test(text.replace(/^\s*\/\/.*$/gm, '')));
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
