import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const LOCK_KEY = 'haat:postgres:schema-migrations';
const MIGRATION_NAME = /^\d{3}_[a-z0-9_-]+\.sql$/i;

// Run ordered SQL migrations using one dedicated pg client. The advisory lock prevents
// two API instances from applying the same migration concurrently.
export async function runPostgresMigrations(pool, directory) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible Pool is required');
  if (!directory) throw new TypeError('A migration directory is required');
  const dir = resolve(directory);
  const files = (await readdir(dir)).filter(name => MIGRATION_NAME.test(name)).sort();
  const client = await pool.connect();
  const appliedNow = [];
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const existing = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(existing.rows.map(row => row.name));

    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = await readFile(join(dir, name), 'utf8');
      if (!sql.trim()) throw new Error('Migration file is empty: ' + name);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
        await client.query('COMMIT');
        applied.add(name);
        appliedNow.push(name);
      } catch (error) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { error.rollbackError = rollbackError; }
        error.migration = name;
        throw error;
      }
    }
    return { applied: appliedNow, current: [...applied].sort() };
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]); }
      catch { /* Preserve the migration failure; the connection close releases session locks. */ }
    }
    client.release();
  }
}
