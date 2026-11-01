import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, verifyPostgresConnection, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pool = await createPostgresPool();
try {
  const connection = await verifyPostgresConnection(pool);
  console.log('Connected to PostgreSQL database:', connection.database);
  const result = await runPostgresMigrations(pool, resolve(root, 'apps/api/migrations/postgres'));
  console.log('PostgreSQL migrations applied:', result.applied.length);
  for (const name of result.applied) console.log('  +', name);
  console.log('Total migrations recorded:', result.current.length);
} catch (error) {
  console.error('PostgreSQL migration failed:', error.migration ? error.migration + ': ' : '', error.message);
  process.exitCode = 1;
} finally {
  await closePostgresPool(pool);
}
