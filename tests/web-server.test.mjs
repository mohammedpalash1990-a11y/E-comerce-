import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const apiPort = 42000 + (process.pid % 1000);
const webPort = 43000 + (process.pid % 1000);
const apiBase = `http://127.0.0.1:${apiPort}`;
const webBase = `http://127.0.0.1:${webPort}`;

async function waitFor(url, child) {
  let lastError;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return response;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Server did not become ready: ${lastError?.message || url}`);
}

test('web server: serves all four marketplace portals and proxies API requests', async t => {
  const api = spawn(process.execPath, ['apps/api/src/server.mjs'], {
    env: { ...process.env, PORT: String(apiPort), SQLITE_FILE: ':memory:', RATE_LIMIT_AUTH_MAX: '1000' },
    stdio: 'ignore'
  });
  const web = spawn(process.execPath, ['apps/web/server.mjs'], {
    env: { ...process.env, WEB_PORT: String(webPort), PORT: String(apiPort), API_HOST: '127.0.0.1' },
    stdio: 'ignore'
  });
  t.after(() => { web.kill(); api.kill(); });

  await waitFor(apiBase + '/health', api);
  await waitFor(webBase + '/', web);

  for (const [path, marker] of [
    ['/', 'HAAT'],
    ['/account.html', 'আপনার HAAT অ্যাকাউন্ট'],
    ['/seller.html', 'Seller Workspace'],
    ['/admin.html', 'Admin Console']
  ]) {
    const response = await fetch(webBase + path);
    assert.equal(response.status, 200, `${path} should load`);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    assert.ok((await response.text()).includes(marker), `${path} should contain its expected portal marker`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }

  const proxied = await fetch(webBase + '/api/v1/products');
  assert.equal(proxied.status, 200, 'same-origin API proxy should reach the API');
  assert.match(proxied.headers.get('content-type') || '', /application\/json/);
  const payload = await proxied.json();
  assert.ok(payload && typeof payload === 'object', 'API proxy should return JSON');

  const missing = await fetch(webBase + '/does-not-exist.html');
  assert.equal(missing.status, 404);
});

test('web server: rejects encoded path traversal attempts', async t => {
  const port = webPort + 1;
  const web = spawn(process.execPath, ['apps/web/server.mjs'], {
    env: { ...process.env, WEB_PORT: String(port), PORT: String(apiPort + 1), API_HOST: '127.0.0.1' },
    stdio: 'ignore'
  });
  t.after(() => web.kill());
  await waitFor(`http://127.0.0.1:${port}/`, web);
  const response = await fetch(`http://127.0.0.1:${port}/..%2F..%2Fpackage.json`);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});
