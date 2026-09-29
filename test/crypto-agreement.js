// Two implementations of the same sealing: one in the browser
// (`public/crypto.js`) and one on the PC (`tools/claude-notify/notify.js`). They
// have to agree exactly — a hash that differs by one byte matches nothing, and
// the square simply never moves, with no error anywhere to say why.
//
// So they are run side by side here on the same inputs.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subKeysFrom, blindIndex, encryptText, decryptText, toB64, fromB64 } from '../public/crypto.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const hook = require_(path.join(HERE, '..', '..', '..', 'tools', 'claude-notify', 'notify.js'));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const master = new Uint8Array(32);
for (let i = 0; i < 32; i += 1) master[i] = (i * 37 + 11) % 256;
const masterB64 = toB64(master);
const masterBuf = hook.fromB64url(masterB64);

const { dataKey, indexKey } = await subKeysFrom(master);

const NAMES = [
  'ProjectOne',
  'AnotherThing',
  'マルチタスク管理ツール',
  "Texas Hold'em EV calculator tool",
  'Texas Hold’em EV calculator tool',
  '  ＰｒｏｊｅｃｔOne ',
  'mixed CASE name',
  '🍜 emoji session',
];

console.log('the same name gives the same hash on both sides');
for (const name of NAMES) {
  const fromBrowser = await blindIndex(indexKey, name);
  const fromHook = hook.blindIndex(masterBuf, name);
  check(`hash agrees: ${JSON.stringify(name.slice(0, 22))}`, fromBrowser === fromHook,
    `${fromBrowser} vs ${fromHook}`);
}

console.log('names that should meet, still meet — on both sides at once');
{
  const a = hook.blindIndex(masterBuf, '  ＰｒｏｊｅｃｔOne ');
  const b = await blindIndex(indexKey, 'projectone');
  check('folding matches across the two', a === b, `${a} vs ${b}`);

  const curly = hook.blindIndex(masterBuf, 'Texas Hold’em EV calculator tool');
  const straight = await blindIndex(indexKey, "Texas Hold'em EV calculator tool");
  check('apostrophes match across the two', curly === straight);
}

console.log('what one seals, the other opens');
for (const name of NAMES) {
  const sealedByHook = hook.sealText(masterBuf, name);
  const openedByBrowser = await decryptText(dataKey, sealedByHook);
  check(`the browser opens the hook's: ${JSON.stringify(name.slice(0, 22))}`,
    openedByBrowser === name, JSON.stringify(openedByBrowser));
}

console.log('and the sealed form gives nothing away');
{
  const sealed = hook.sealText(masterBuf, 'マルチタスク管理ツール');
  check('the ciphertext does not contain the name', !sealed.includes('マルチタスク'), sealed);
  check('it is not the same twice', sealed !== hook.sealText(masterBuf, 'マルチタスク管理ツール'));

  const hash = hook.blindIndex(masterBuf, 'マルチタスク管理ツール');
  check('the hash does not contain the name', !hash.includes('マルチタスク'), hash);

  const otherMaster = Buffer.alloc(32, 3);
  check('another key hashes it differently',
    hash !== hook.blindIndex(otherMaster, 'マルチタスク管理ツール'));
  check('another key cannot open it',
    (await decryptText((await subKeysFrom(new Uint8Array(32).fill(3))).dataKey, sealed)) === '');
}

console.log('both ways out of the hook seal the same way');
{
  // There are two: straight through, and after the ten-second hold. When
  // sealing was added only the first got it, and since every stop takes the
  // held path, the board went quiet for exactly the reports it exists to show.
  // The square kept still while the phone kept ringing 'no square matches'.
  const config = { key: masterB64 };
  const name = 'マルチタスク管理ツール';

  const held = hook.payloadFor(config, { title: name, body: '入力待ちです' });
  const direct = hook.payloadFor(config, { title: name, body: '作業中', event: 'start' });

  check('the held path seals', Boolean(held.matchHash && held.nameCipher), JSON.stringify(held));
  check('the direct path seals', Boolean(direct.matchHash && direct.nameCipher));
  check('both arrive under the same fingerprint', held.matchHash === direct.matchHash);
  check('only the start is marked as one', !held.event && direct.event === 'start');
  check('the browser opens what the held path sealed',
    (await decryptText(dataKey, held.nameCipher)) === name);
  check('nothing readable goes out either way',
    !JSON.stringify(held).includes('マルチタスク') && !JSON.stringify(direct).includes('マルチタスク'));

  // Without a key there is nothing to seal with, and the session name would go
  // out in the clear. It is not sent at all: a square that stops moving is a
  // problem someone notices, whereas a readable name arriving at a server that
  // was promised it could not read one is a problem nobody notices.
  const plain = hook.payloadFor({}, { title: name, body: '入力待ちです' });
  check('with no key nothing is built at all', plain === null, JSON.stringify(plain));

  // The one way to send words: asked for outright.
  const asked = hook.payloadFor({ allowPlaintext: true }, { title: name, body: '入力待ちです' });
  check('and only then, having asked for it', asked && asked.text === `*${name}* — 入力待ちです`,
    JSON.stringify(asked));
}

console.log('the key survives the trip through the config file');
{
  // The master key reaches the PC as text in notify.json, so the two encodings
  // have to be the same encoding.
  const roundTripped = hook.fromB64url(masterB64);
  check('base64url survives both directions',
    Buffer.compare(Buffer.from(fromB64(masterB64)), roundTripped) === 0);
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
