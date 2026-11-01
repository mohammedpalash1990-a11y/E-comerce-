// Convert PostgreSQL INT8 values to JavaScript numbers only when exact arithmetic is safe.
export function parseSafePostgresBigInt(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError('PostgreSQL BIGINT exceeds JavaScript safe integer range');
    return value;
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError('PostgreSQL BIGINT exceeds JavaScript safe integer range');
    }
    return Number(value);
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new TypeError('PostgreSQL BIGINT must be an integer string, number, or bigint');
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('PostgreSQL BIGINT exceeds JavaScript safe integer range');
  }
  return Number(parsed);
}

// Call before creating the Pool, e.g. configurePostgresBigIntParser(pg.types).
export function configurePostgresBigIntParser(types) {
  if (!types || typeof types.setTypeParser !== 'function') throw new TypeError('A pg types registry is required');
  types.setTypeParser(20, parseSafePostgresBigInt);
}
