import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = /(?:^|\/)(?:core|routes_public|routes_seller|server)\.mjs$|(?:^|\/)sqlite[^/]*\.mjs$/;

function collectImportGraph(entry) {
  const visited = new Set();
  const pending = [resolve(root, entry)];

  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    assert.ok(file.startsWith(root + '/'), 'Import escaped repository root: ' + file);
    assert.ok(existsSync(file), 'Imported module does not exist: ' + file);
    visited.add(file);

    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s*|import\s*\(\s*)['"]node:sqlite['"]|import\s*['"]node:sqlite['"]/,
      file + ' must not import node:sqlite'
    );

    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g);
    for (const match of imports) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const dependency = resolve(dirname(file), specifier);
      const relativePath = relative(root, dependency).replaceAll('\\\\', '/');
      assert.doesNotMatch(relativePath, forbidden, file + ' reaches forbidden SQLite runtime module ' + relativePath);
      pending.push(dependency);
    }
  }

  return [...visited].map(file => relative(root, file).replaceAll('\\\\', '/'));
}

test('PostgreSQL API server transitive import graph is SQLite-independent', () => {
  const graph = collectImportGraph('apps/api/src/postgres-server.mjs');
  assert.ok(graph.includes('apps/api/src/postgres-runtime.mjs'));
  assert.ok(graph.includes('apps/api/src/postgres-auth.mjs'));
  assert.ok(graph.includes('apps/api/src/postgres-commerce-routes.mjs'));
  assert.ok(graph.length > 10, 'Expected to inspect the complete PostgreSQL server dependency graph');
});
