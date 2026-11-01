import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const LOCK_KEY = 'haat:postgres:schema-migrations';
const MIGRATION_NAME = /^\d{3}_[a-z0-9_-]+\.sql$/i;

export function migrationChecksum(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

// Run ordered SQL migrations using one dedicated pg client. The advisory lock prevents
// two API instances from applying the same migration concurrently. Checksums detect
// edits to already-applied migration files before the application starts.
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
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum TEXT
    )`);
    // Older HAAT schema_migrations tables predate checksums. Keep this additive and
    // nullable: old rows remain explicitly unverified; all new rows are protected.
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
    const existing = await client.query('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(existing.rows.map(row => [row.name, row.checksum || null]));

    for (const name of files) {
      const sql = await readFile(join(dir, name), 'utf8');
      if (!sql.trim()) throw new Error('Migration file is empty: ' + name);
      const checksum = migrationChecksum(sql);
      if (applied.has(name)) {
        const recorded = applied.get(name);
        if (recorded && recorded !== checksum) {
          throw new Error('Migration checksum mismatch for ' + name + '; restore the applied migration or create a new forward migration');
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(name, applied_at, checksum) VALUES($1, $2, $3)',
          [name, new Date().toISOString(), checksum]
        );
        await client.query('COMMIT');
        applied.set(name, checksum);
        appliedNow.push(name);
      } catch (error) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { error.rollbackError = rollbackError; }
        error.migration = name;
        throw error;
      }
    }
    return {
      applied: appliedNow,
      current: [...applied.keys()].sort(),
      unverifiedLegacy: [...applied.entries()].filter(([, checksum]) => !checksum).map(([name]) => name).sort()
    };
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]); }
      catch { /* Preserve the migration failure; closing the connection releases session locks. */ }
    }
    client.release();
  }
}
