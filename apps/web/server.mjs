import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const port = Number(process.env.WEB_PORT || 3000);
const apiPort = Number(process.env.PORT || 4000);
const apiHost = process.env.API_HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https:; upgrade-insecure-requests"
};
function respond(res, status, headers, body) {
  res.writeHead(status, { ...headers, ...securityHeaders });
  res.end(body);
}
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { respond(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad request'); return; }
  if (url.pathname.startsWith('/api/')) {
    const upstream = http.request({ hostname: apiHost, port: apiPort, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, host: apiHost + ':' + apiPort } }, response => {
      res.writeHead(response.statusCode || 502, { ...response.headers, ...securityHeaders });
      response.pipe(res);
    });
    upstream.setTimeout(15000, () => upstream.destroy(new Error('API request timed out')));
    upstream.on('error', () => {
      if (!res.headersSent) respond(res, 502, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ error: 'API unavailable' }));
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    respond(res, 405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, 'Method not allowed');
    return;
  }
  try {
    const pathname = decodeURIComponent(url.pathname);
    const route = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = resolve(publicRoot, route);
    if (filePath !== publicRoot && !filePath.startsWith(publicRoot + sep)) {
      respond(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not found'); return;
    }
    readFile(filePath).then(file => {
      res.writeHead(200, { 'content-type': types[extname(filePath)] || 'application/octet-stream', ...securityHeaders });
      if (req.method === 'HEAD') res.end(); else res.end(file);
    }).catch(() => respond(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not found'));
  } catch { respond(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad request'); }
});
server.listen(port, '0.0.0.0', () => console.log('Web storefront listening on ' + port));
