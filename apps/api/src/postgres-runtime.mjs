import { AsyncLocalStorage } from 'node:async_hooks';
import { postgresPlaceholders, normalizePostgresResult } from './postgres-sql.mjs';

// Async PostgreSQL adapter with transaction-scoped client routing.
// It accepts a pg-compatible Pool; importing this module does not require the pg package.
export function createPostgresDatabase(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A pg-compatible Pool with query() and connect() is required');
  }
  const scope = new AsyncLocalStorage();
  let savepointId = 0;

  async function execute(sql, params) {
    const converted = postgresPlaceholders(sql);
    if (converted.count !== params.length) {
      throw new TypeError(`SQL expects ${converted.count} parameters but received ${params.length}`);
    }
    const client = scope.getStore()?.client || pool;
    return client.query(converted.text, params);
  }

  function q(sql) {
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL must be a non-empty string');
    return Object.freeze({
      get: async (...params) => (await execute(sql, params)).rows[0],
      all: async (...params) => (await execute(sql, params)).rows,
      run: async (...params) => normalizePostgresResult(await execute(sql, params))
    });
  }

  async function tx(callback) {
    if (typeof callback !== 'function') throw new TypeError('Transaction callback must be a function');
    const parent = scope.getStore();
    if (parent) {
      const name = 'sp_' + (++savepointId);
      await parent.client.query('SAVEPOINT ' + name);
      try {
        const value = await callback();
        await parent.client.query('RELEASE SAVEPOINT ' + name);
        return value;
      } catch (error) {
        try {
          await parent.client.query('ROLLBACK TO SAVEPOINT ' + name);
          await parent.client.query('RELEASE SAVEPOINT ' + name);
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        throw error;
      }
    }

    const client = await pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      const value = await scope.run({ client }, callback);
      await client.query('COMMIT');
      began = false;
      return value;
    } catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { error.rollbackError = rollbackError; }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ q, tx });
}

export function isPostgresUniqueViolation(error) {
  return error?.code === '23505';
}
