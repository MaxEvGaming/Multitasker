// Mints a way in for one more person.
//
//   node src/invite.js "for Kenji"        one code, no expiry
//   node src/invite.js "for Kenji" 7      one code, good for seven days
//   node src/invite.js --list             what is outstanding
//
// The note is for whoever runs the site, not for the person using the code —
// so that a list of unused invitations means something a month later.
import { q, one, pool } from './db.js';
import { newToken } from './auth.js';

const site = process.env.SITE_URL || 'https://board.example.com';

if (process.argv[2] === '--list') {
  const rows = await q(
    `select code, note, created_at, expires_at, used_at from invites
      order by used_at nulls first, created_at desc limit 50`);
  if (rows.length === 0) console.log('no invitations have been made');
  for (const row of rows) {
    const state = row.used_at
      ? `used ${row.used_at.toISOString().slice(0, 10)}`
      : (row.expires_at && row.expires_at < new Date() ? 'expired' : 'unused');
    console.log(`${row.code}  ${state.padEnd(15)} ${row.note || ''}`);
  }
  await pool.end();
  process.exit(0);
}

const note = process.argv[2] || null;
const days = Number(process.argv[3]);

const code = newToken(18);
await one(
  `insert into invites(code, note, expires_at)
   values ($1, $2, case when $3::int is null then null else now() + make_interval(days => $3::int) end)
   returning code`,
  [code, note, Number.isFinite(days) && days > 0 ? days : null]
);

console.log(`${site}/?invite=${code}`);
console.log(days > 0 ? `Good for ${days} days, and once.` : 'Good until used.');
console.log('Hand it over directly. Anyone holding it can make an account here.');
await pool.end();
