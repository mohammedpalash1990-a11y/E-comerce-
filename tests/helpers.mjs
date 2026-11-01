import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function startApi(port, env = {}) {
  const child = spawn(process.execPath, ['apps/api/src/server.mjs'], { env: { ...process.env, PORT: String(port), SQLITE_FILE: ':memory:', RATE_LIMIT_AUTH_MAX: '1000', ...env }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await delay(100); }
  const request = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, headers: r.headers, data: await r.json().catch(() => null) };
  };
  const login = async (identifier, password, extra = {}) => { const r = await request('/api/v1/auth/login', { method: 'POST', body: { identifier, password, ...extra } }); return r; };
  return { child, base, request, login, stop: () => child.kill() };
}
export const delivery = (area = 'Dhaka') => ({ name: 'Test Buyer', phone: '01711111111', address: 'House 1, Road 1', area });
