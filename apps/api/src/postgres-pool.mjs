// PostgreSQL connection factory. The pg driver is loaded only when this adapter is used,
// so SQLite-only development and unit tests do not need to load the driver.
export function postgresPoolOptions(env = process.env) {
  const connectionString = String(env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL operations');
  let parsed;
  try { parsed = new URL(connectionString); }
  catch { throw new TypeError('DATABASE_URL must be a valid PostgreSQL connection URL'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new TypeError('DATABASE_URL must use postgres:// or postgresql://');
  const integer = (name, fallback, min, max) => {
    const raw = env[name]; const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(name + ' must be an integer between ' + min + ' and ' + max);
    return value;
  };
  const sslMode = String(env.PGSSL_MODE || 'require').toLowerCase();
  if (!['require', 'disable'].includes(sslMode)) throw new TypeError('PGSSL_MODE must be require or disable');
  const ssl = sslMode === 'disable' ? false : { rejectUnauthorized: String(env.PGSSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false' };
  return { connectionString, max: integer('PG_POOL_MAX', 10, 1, 100), idleTimeoutMillis: integer('PG_IDLE_TIMEOUT_MS', 30000, 1000, 600000), connectionTimeoutMillis: integer('PG_CONNECTION_TIMEOUT_MS', 10000, 1000, 120000), keepAlive: true, application_name: env.PG_APPLICATION_NAME || 'bangladesh-marketplace-api', ssl };
}
export async function createPostgresPool({ env = process.env, loadPg = () => import('pg'), onIdleError = error => console.error('[postgres pool] idle client error:', error?.message || error) } = {}) {
  const options = postgresPoolOptions(env); const driver = await loadPg(); const Pool = driver.Pool || driver.default?.Pool;
  if (typeof Pool !== 'function') throw new TypeError('The pg package did not provide Pool');
  const pool = new Pool(options); if (typeof pool.on === 'function') pool.on('error', onIdleError); return pool;
}
export async function verifyPostgresConnection(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required');
  const result = await pool.query('SELECT current_database() AS database, version() AS version'); const row = result.rows?.[0];
  if (!row?.database || !row?.version) throw new Error('PostgreSQL connection check returned an unexpected result');
  return { database: row.database, version: row.version };
}
export async function closePostgresPool(pool) { if (pool && typeof pool.end === 'function') await pool.end(); }
