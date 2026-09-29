import pg from 'pg';

// Timestamps come back as strings rather than JS Dates: everything downstream
// wants ISO text for JSON anyway, and the implicit local-timezone conversion
// pg does by default is a trap on a server whose clock is not the user's.
pg.types.setTypeParser(1184, (v) => v);
pg.types.setTypeParser(1114, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30_000,
});

export async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    try { await client.query('rollback'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}
