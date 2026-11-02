import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = /(?:^|\/)(?:core\.mjs|routes_seller\.mjs|routes_public\.mjs|sqlite[^/]*\.mjs)$/;

function collectGraph(entry) {
  const visited = new Set();
  const pending = [resolve(root, entry)];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from\s*['"]node:sqlite['"]|import\s*['"]node:sqlite['"]/,
      file + ' must not import node:sqlite');
    const imports = source.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm);
    for (const match of imports) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const dependency = resolve(dirname(file), specifier);
      const relative = dependency.slice(root.length + 1).replaceAll('\\', '/');
      assert.doesNotMatch(relative, forbidden, file + ' reaches forbidden SQLite module ' + relative);
      pending.push(dependency);
    }
  }
  return [...visited].map(file => file.slice(root.length + 1).replaceAll('\\', '/'));
}

test('PostgreSQL admin repository import graph is SQLite-independent', () => {
  const graph = collectGraph('apps/api/src/postgres-admin.mjs');
  assert.ok(graph.includes('apps/api/src/postgres-domain-helpers.mjs'));
  assert.ok(graph.includes('apps/api/src/postgres-gateways.mjs'));
});

test('PostgreSQL seller repository import graph is SQLite-independent', () => {
  const graph = collectGraph('apps/api/src/postgres-seller.mjs');
  assert.ok(graph.includes('apps/api/src/postgres-gateways.mjs'));
});
