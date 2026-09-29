// The encryption core, on its own. A fault here is both catastrophic and quiet
// — data that cannot be read again looks exactly like data that was never
// written — so the properties are checked rather than assumed.
import {
  createKeys, unlockWithPassword, unlockWithRecovery, rewrapForPassword,
  subKeysFrom, encryptText, decryptText, blindIndex, toB64, fromB64,
} from '../public/crypto.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const same = (a, b) => toB64(a) === toB64(b);

const PASSWORD = 'a-long-enough-password';

console.log('making the keys');
const keys = await createKeys(PASSWORD);
check('a salt was made', typeof keys.kdfSalt === 'string' && keys.kdfSalt.length >= 20);
check('a recovery key was made', fromB64(keys.recoveryKey).length === 32);
check('the master key is 32 bytes', keys.masterRaw.length === 32);
check('the wrapped forms do not contain the key',
  !keys.wrappedByPassword.includes(toB64(keys.masterRaw))
  && !keys.wrappedByRecovery.includes(toB64(keys.masterRaw)));
check('the two wrappings differ', keys.wrappedByPassword !== keys.wrappedByRecovery);

console.log('getting back in');
{
  const viaPassword = await unlockWithPassword(PASSWORD, keys.kdfSalt, keys.wrappedByPassword);
  check('the password unwraps it', same(viaPassword, keys.masterRaw));

  const viaRecovery = await unlockWithRecovery(keys.recoveryKey, keys.wrappedByRecovery);
  check('the recovery key unwraps it', same(viaRecovery, keys.masterRaw));

  let refused = false;
  try { await unlockWithPassword('the-wrong-password', keys.kdfSalt, keys.wrappedByPassword); }
  catch (_) { refused = true; }
  check('a wrong password is refused rather than returning rubbish', refused);

  refused = false;
  try { await unlockWithRecovery(toB64(new Uint8Array(32)), keys.wrappedByRecovery); }
  catch (_) { refused = true; }
  check('a wrong recovery key is refused too', refused);
}

console.log('changing the password does not change the data key');
{
  const rewrapped = await rewrapForPassword(keys.masterRaw, 'a-different-password');
  const after = await unlockWithPassword('a-different-password', rewrapped.kdfSalt,
    rewrapped.wrappedByPassword);
  check('the same master key comes back', same(after, keys.masterRaw));

  let refused = false;
  try { await unlockWithPassword(PASSWORD, rewrapped.kdfSalt, rewrapped.wrappedByPassword); }
  catch (_) { refused = true; }
  check('the old password no longer opens it', refused);

  // The recovery key was wrapped around the master key, not the password, so it
  // still works after a password change.
  const viaRecovery = await unlockWithRecovery(keys.recoveryKey, keys.wrappedByRecovery);
  check('the recovery key still works after a password change', same(viaRecovery, keys.masterRaw));
}

console.log('text');
{
  const { dataKey } = await subKeysFrom(keys.masterRaw);
  const samples = ['ProjectOne の作業', '', 'ページ 1', '絵文字も 🍜 通る', 'a'.repeat(500)];
  for (const text of samples) {
    const sealed = await encryptText(dataKey, text);
    const back = await decryptText(dataKey, sealed);
    check(`round trip: ${JSON.stringify(text.slice(0, 18))}`, back === text, JSON.stringify(back.slice(0, 18)));
  }

  const sealed = await encryptText(dataKey, '秘密');
  check('the ciphertext does not contain the text', !sealed.includes('秘密'), sealed);
  check('the same text seals differently each time',
    (await encryptText(dataKey, '秘密')) !== sealed);

  const { dataKey: strangerKey } = await subKeysFrom(new Uint8Array(32).fill(7));
  check('someone else key reads nothing', (await decryptText(strangerKey, sealed)) === '');

  // A tampered blob must not come back as anything at all.
  const broken = sealed.slice(0, -4) + 'AAAA';
  check('a tampered ciphertext yields nothing', (await decryptText(dataKey, broken)) === '');
}

console.log('the keyed hash used for matching');
{
  const { indexKey } = await subKeysFrom(keys.masterRaw);
  const a = await blindIndex(indexKey, 'ProjectOne');
  check('the same name always gives the same hash', a === (await blindIndex(indexKey, 'ProjectOne')));
  check('the hash does not contain the name', !a.includes('ProjectOne'), a);
  check('a different name gives a different hash', a !== (await blindIndex(indexKey, 'AnotherThing')));

  // Same folding as before: mechanical differences still meet, real ones do not.
  check('spaces around it are folded', a === (await blindIndex(indexKey, '  ProjectOne ')));
  check('case is folded', a === (await blindIndex(indexKey, 'projectone')));
  check('full width is folded', a === (await blindIndex(indexKey, 'ＰｒｏｊｅｃｔOne')));
  check('a curly apostrophe meets a straight one',
    (await blindIndex(indexKey, 'Texas Hold’em')) === (await blindIndex(indexKey, "Texas Hold'em")));
  check('a space in the middle is still a different name',
    a !== (await blindIndex(indexKey, 'Project One')));

  const { indexKey: strangerIndex } = await subKeysFrom(new Uint8Array(32).fill(9));
  check('another account hashes the same name differently',
    a !== (await blindIndex(strangerIndex, 'ProjectOne')));

  check('an empty name has no hash', (await blindIndex(indexKey, '   ')) === '');
}

console.log('the two derived keys are not each other');
{
  const { dataKey, indexKey } = await subKeysFrom(keys.masterRaw);
  const dataRaw = await crypto.subtle.exportKey('raw', dataKey).catch(() => null);
  check('the data key cannot be exported', dataRaw === null);
  check('the index key cannot sign with the data key',
    (await blindIndex(indexKey, 'x')) !== (await encryptText(dataKey, 'x')));
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
