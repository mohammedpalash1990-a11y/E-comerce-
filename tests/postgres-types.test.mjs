import test from 'node:test';
import assert from 'node:assert/strict';
import { configurePostgresBigIntParser, parseSafePostgresBigInt } from '../apps/api/src/postgres-types.mjs';

test('parses PostgreSQL BIGINT strings exactly inside JavaScript safe range', () => {
  assert.equal(parseSafePostgresBigInt('0'), 0);
  assert.equal(parseSafePostgresBigInt('176000'), 176000);
  assert.equal(parseSafePostgresBigInt('-42'), -42);
  assert.equal(parseSafePostgresBigInt(Number.MAX_SAFE_INTEGER.toString()), Number.MAX_SAFE_INTEGER);
  assert.equal(parseSafePostgresBigInt(BigInt(Number.MIN_SAFE_INTEGER)), Number.MIN_SAFE_INTEGER);
});

test('rejects malformed and unsafe BIGINT values instead of silently rounding', () => {
  for (const value of ['1.5', '1e3', '', ' 2', 'abc', null, undefined]) {
    assert.throws(() => parseSafePostgresBigInt(value), TypeError);
  }
  assert.throws(() => parseSafePostgresBigInt('9007199254740992'), RangeError);
  assert.throws(() => parseSafePostgresBigInt('-9007199254740992'), RangeError);
  assert.throws(() => parseSafePostgresBigInt(1.2), RangeError);
});

test('configures the pg INT8 parser without mutating other OID parsers', () => {
  const calls = [];
  configurePostgresBigIntParser({ setTypeParser: (...args) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 20);
  assert.equal(calls[0][1]('1234'), 1234);
  assert.throws(() => configurePostgresBigIntParser({}), /types registry is required/);
});
