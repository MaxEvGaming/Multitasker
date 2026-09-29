import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from './db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', 'sql');

export async function migrate() {
  await pool.query(`
    create table if not exists migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);

  const applied = new Set(
    (await pool.query('select name from migrations')).rows.map((r) => r.name)
  );

  const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into migrations(name) values ($1)', [file]);
      await client.query('commit');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

// Run directly (`npm run migrate`) rather than imported by the server.
const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry && import.meta.url === entry) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
}
