// The one thing the PC and the browser have to agree on exactly: how an
// instruction is sealed. A PC that derives the key one byte differently opens
// nothing, and the only symptom is a square that turns red five seconds after
// every press.
//
// So the exact bytes are pinned here. A known master key, a known IV, a known
// instruction, and the sealed text they must produce — computed with Node's
// own primitives (the same way `public/download/notify.js` seals a name) and
// then opened with the browser's `decryptText`, so both readings of the format
// are checked against each other and against the file the C# side will be
// handed: test/vectors/deck-seal.json.
//
//   node test/deck-seal.js           check against the file
//   node test/deck-seal.js --write   (re)write the file from the constants here
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { subKeysFrom, encryptText, decryptText, toB64, fromB64 } from '../public/crypto.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'vectors', 'deck-seal.json');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text) => Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// What the PC has to do, written out in Node so the steps are visible:
// HKDF-SHA256(master, salt = empty, info = "taskboard/data") → 32 bytes, then
// AES-256-GCM with a 12-byte IV, no additional data, 16-byte tag appended.
function dataKeyOf(master) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('taskboard/data', 'utf8'), 32));
}
function sealWith(master, iv, text) {
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKeyOf(master), iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1.${b64url(iv)}.${b64url(Buffer.concat([body, cipher.getAuthTag()]))}`;
}
function openWith(master, sealed) {
  const [version, ivB64, bodyB64] = String(sealed).split('.');
  if (version !== 'v1') throw new Error('not v1');
  const body = fromB64url(bodyB64);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKeyOf(master), fromB64url(ivB64));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
}

// The fixed inputs. The master key is the same one crypto-agreement.js uses;
// the IV counts up so nobody mistakes it for a real one.
const master = Buffer.alloc(32);
for (let i = 0; i < 32; i += 1) master[i] = (i * 37 + 11) % 256;
const iv = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const job = { id: '42', at: 1757400000000, kind: 'url', args: { url: 'https://example.com' } };
// Exactly this text: JSON.stringify with no spaces, keys in this order. The
// PC never has to produce this text, only open it — but a test that wants to
// compare bytes needs the bytes fixed.
const plaintext = JSON.stringify(job);

const vector = {
  note: 'Known-answer vector for sealing a job. See docs/DECK_AGENT_PROTOCOL.md 「暗号文の形」.',
  masterKeyBase64url: b64url(master),
  masterKeyHex: master.toString('hex'),
  kdf: { name: 'HKDF', hash: 'SHA-256', salt: '', saltNote: 'zero-length — no bytes at all, not 32 zero bytes', info: 'taskboard/data', length: 32 },
  dataKeyHex: dataKeyOf(master).toString('hex'),
  cipher: { name: 'AES-256-GCM', ivBytes: 12, tagBytes: 16, additionalData: 'none' },
  ivBase64url: b64url(iv),
  ivHex: iv.toString('hex'),
  plaintext,
  plaintextUtf8Hex: Buffer.from(plaintext, 'utf8').toString('hex'),
  sealed: sealWith(master, iv, plaintext),
  format: 'v1.<iv base64url>.<ciphertext||tag base64url> — base64url without padding, three parts joined by "."',
};

console.log('the pinned vector');
{
  check('the sealed form has three dot-separated parts', vector.sealed.split('.').length === 3, vector.sealed);
  check('and starts with the version', vector.sealed.startsWith('v1.'));
  check('the ciphertext part is plaintext + 16 bytes',
    fromB64url(vector.sealed.split('.')[2]).length === Buffer.byteLength(plaintext, 'utf8') + 16);
  check('nothing readable is in it', !vector.sealed.includes('example') && !vector.sealed.includes('url'));
}

console.log('the browser opens what the PC-side arithmetic sealed');
{
  const { dataKey } = await subKeysFrom(new Uint8Array(master));
  const opened = await decryptText(dataKey, vector.sealed);
  check('the text comes back exactly', opened === plaintext, JSON.stringify(opened));
  check('and parses to the job', JSON.stringify(JSON.parse(opened)) === plaintext);
}

console.log('and the PC-side arithmetic opens what the browser sealed');
{
  const { dataKey } = await subKeysFrom(new Uint8Array(master));
  const sealedByBrowser = await encryptText(dataKey, plaintext);
  check('the browser\'s IV is random, so its output differs', sealedByBrowser !== vector.sealed);
  check('but opens to the same text', openWith(master, sealedByBrowser) === plaintext);
  check('a different key opens neither',
    (() => { try { openWith(Buffer.alloc(32, 7), sealedByBrowser); return false; } catch (_) { return true; } })());
}

console.log('the encodings round-trip between the two');
{
  check('base64url of the key agrees', toB64(new Uint8Array(master)) === vector.masterKeyBase64url);
  check('and back', Buffer.compare(Buffer.from(fromB64(vector.masterKeyBase64url)), master) === 0);
}

console.log('the file the C# side is given');
if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(vector, null, 2) + '\n');
  console.log(`  wrote ${path.relative(process.cwd(), FILE)}`);
} else {
  let onDisk = null;
  try { onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) {}
  check('exists', Boolean(onDisk), `run with --write to make ${FILE}`);
  if (onDisk) {
    for (const key of ['masterKeyBase64url', 'dataKeyHex', 'ivBase64url', 'plaintext', 'sealed']) {
      check(`${key} matches what this run computed`, onDisk[key] === vector[key],
        `${JSON.stringify(onDisk[key])} vs ${JSON.stringify(vector[key])}`);
    }
  }
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
