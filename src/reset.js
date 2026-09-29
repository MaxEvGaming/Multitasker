// Mints a way back in for someone who cannot sign in.
//
//   node src/reset.js someone@example.com
//
// There is no mail server behind this site, so the link is handed over out of
// band — which is also why nobody can request one for an address that is not
// theirs. It is good for 24 hours and works once.
//
// What the link can and cannot do is worth being plain about: it lets them set
// a new password, and that is all. On an encrypted account the contents stay
// shut until their recovery key is put in as well, because the wrapping around
// the master key was made from the old password and nothing here can undo that.
// The page asks for both together for exactly this reason.
import { createResetToken } from './account.js';
import { pool } from './db.js';

const email = process.argv[2];
const site = process.env.SITE_URL || 'https://board.example.com';

if (!email) {
  console.error('usage: node src/reset.js <email>');
  process.exit(2);
}

const token = await createResetToken(email);
if (!token) {
  console.error(`no account here for ${email}`);
  await pool.end();
  process.exit(1);
}

console.log(`${site}/reset?token=${token}`);
console.log('Good for 24 hours, and once. Hand it over directly, not by email.');
await pool.end();
