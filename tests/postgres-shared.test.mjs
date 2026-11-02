import test from 'node:test';
import assert from 'node:assert/strict';
import {
  config,
  HttpError,
  bad,
  id,
  sha256,
  hashPassword,
  verifyPassword,
  safeEq,
  normPhone,
  validPhone,
  validEmail,
  checkPassword,
  text
} from '../apps/api/src/postgres-shared.mjs';
import { readFile } from 'node:fs/promises';

test('PostgreSQL shared helpers load without importing the SQLite core', async () => {
  const [shared, auth] = await Promise.all([
    readFile(new URL('../apps/api/src/postgres-shared.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../apps/api/src/postgres-auth.mjs', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(shared, /from ['"]\.\/core\.mjs['"]/);
  assert.doesNotMatch(auth, /from ['"]\.\/core\.mjs['"]/);
  assert.match(auth, /from ['"]\.\/postgres-shared\.mjs['"]/);
});

test('shared identifiers, hashes and password verification retain expected behavior', () => {
  assert.match(id(), /^[0-9a-f-]{36}$/i);
  assert.match(sha256('marketplace'), /^[a-f0-9]{64}$/);
  const passwordHash = hashPassword('SecurePass123');
  assert.equal(verifyPassword('SecurePass123', passwordHash), true);
  assert.equal(verifyPassword('WrongPass123', passwordHash), false);
  assert.equal(verifyPassword('WrongPass123', null), false);
  assert.equal(safeEq('same', 'same'), true);
  assert.equal(safeEq('same', 'other'), false);
});

test('Bangladesh phone, email and text validators preserve input rules', () => {
  assert.equal(normPhone('+880 1712-345678'), '01712345678');
  assert.equal(validPhone('01712345678'), true);
  assert.equal(validPhone('01112345678'), false);
  assert.equal(validEmail('person@example.com'), true);
  assert.equal(validEmail('not-an-email'), false);
  assert.equal(text('  Hello  ', 10, 'Name'), 'Hello');
  assert.equal(text('', 10, 'Optional', { required: false }), '');
  assert.throws(() => text('', 10, 'Name'), error => error instanceof HttpError && error.status === 400);
  assert.throws(() => text('too long', 3, 'Name'), /অনেক লম্বা/);
});

test('password policy and error helpers preserve API validation contract', () => {
  assert.doesNotThrow(() => checkPassword('SecurePass123'));
  assert.throws(() => checkPassword('short'), /পাসওয়ার্ড/);
  assert.throws(() => checkPassword('letters-only'), /পাসওয়ার্ড/);
  assert.equal(bad('invalid').status, 400);
  assert.equal(config.sessionDays > 0, true);
});
