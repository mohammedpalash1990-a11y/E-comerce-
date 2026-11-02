import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const webPort = 4319, apiPort = 4320;
const api = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'x-api-test': 'ok' });
  res.end(JSON.stringify({ path: req.url, method: req.method }));
});
let web;
test.before(async () => {
  await new Promise(resolve => api.listen(apiPort, '127.0.0.1', resolve));
  web = spawn(process.execPath, ['apps/web/server.mjs'], { env: { ...process.env, WEB_PORT: String(webPort), PORT: String(apiPort), API_HOST: '127.0.0.1' }, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const response = await fetch('http://127.0.0.1:' + webPort + '/'); if (response.ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'web server should start');
});
test.after(async () => { web?.kill(); await new Promise(resolve => api.close(resolve)); });

test('static responses include browser security headers', async () => {
  const response = await fetch('http://127.0.0.1:' + webPort + '/');
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type').includes('text/html'));
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.ok(response.headers.get('content-security-policy').includes("object-src 'none'"));
});
test('static server rejects traversal and unsupported methods', async () => {
  const traversal = await fetch('http://127.0.0.1:' + webPort + '/..%2f..%2fetc%2fpasswd');
  assert.ok([400, 404].includes(traversal.status));
  const method = await fetch('http://127.0.0.1:' + webPort + '/index.html', { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET, HEAD');
});
test('API proxy preserves upstream response and adds security headers', async () => {
  const response = await fetch('http://127.0.0.1:' + webPort + '/api/probe?x=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-api-test'), 'ok');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.deepEqual(await response.json(), { path: '/api/probe?x=1', method: 'GET' });
});
