import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresPlaceholders, normalizePostgresResult } from '../apps/api/src/postgres-sql.mjs';

test('placeholder conversion numbers positional parameters and ignores SQL literals/comments', () => {
  const sql = "SELECT ?, '?' AS literal, \"?\" AS identifier -- ? ignored\nFROM items WHERE id=? /* ? ignored */ AND note=$tag$?$tag$";
  const result = postgresPlaceholders(sql);
  assert.equal(result.count, 2);
  assert.ok(result.text.startsWith("SELECT $1, '?' AS literal, \"?\" AS identifier -- ? ignored"));
  assert.ok(result.text.includes('WHERE id=$2 /* ? ignored */'));
  assert.ok(result.text.endsWith('note=$tag$?$tag$'));
});

test('placeholder conversion rejects unterminated SQL literals', () => {
  assert.throws(() => postgresPlaceholders("SELECT 'unfinished"), SyntaxError);
  assert.throws(() => postgresPlaceholders("SELECT 1 /* unfinished"), SyntaxError);
});

test('PostgreSQL result normalization maps rowCount and rows', () => {
  assert.deepEqual(normalizePostgresResult({ rowCount: 2, rows: [{ id: 'row-1' }] }), {
    changes: 2, rows: [{ id: 'row-1' }], lastInsertRowid: 'row-1'
  });
  assert.deepEqual(normalizePostgresResult({ rowCount: null, rows: [] }), {
    changes: 0, rows: [], lastInsertRowid: null
  });
});

test('placeholder conversion follows PostgreSQL standard strings and E-string escapes', () => {
  const standard = postgresPlaceholders("SELECT 'C:\\path\\file ?', ?");
  assert.equal(standard.count, 1);
  assert.ok(standard.text.endsWith(", $1"));
  const escaped = postgresPlaceholders("SELECT E'it\\'s ?' AS note, ?");
  assert.equal(escaped.count, 1);
  assert.ok(escaped.text.endsWith(', $1'));
});


test('placeholder conversion ignores nested PostgreSQL block comments', () => {
  const sql = 'SELECT ? /* outer ? /* nested ? */ still comment ? */ WHERE id=?';
  const result = postgresPlaceholders(sql);
  assert.equal(result.count, 2);
  assert.equal(result.text, 'SELECT $1 /* outer ? /* nested ? */ still comment ? */ WHERE id=$2');
});

test('placeholder conversion resumes after a nested block comment closes', () => {
  const result = postgresPlaceholders('SELECT /* a /* b */ c */ ?, ?');
  assert.equal(result.count, 2);
  assert.equal(result.text, 'SELECT /* a /* b */ c */ $1, $2');
});
