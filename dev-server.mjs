// Local dev + preview server.
//
//   npm run dev        # or: node dev-server.mjs
//   → http://localhost:8080
//
// Serves index.html and the same /api/* handlers Vercel runs, so what you see
// locally is what deploys. Everything except /api/search is offline.

import http from 'http';
import { readFile } from 'fs/promises';
import { extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { LIVE_ENABLED } from './lib/live.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

try {
  process.loadEnvFile(join(__dirname, '.env'));
} catch {}

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const ROUTES = {
  '/api/build': './api/build.js',
  '/api/decode': './api/decode.js',
  '/api/plan': './api/plan.js',
  '/api/parse-results': './api/parse-results.js',
  '/api/search': './api/search.js',
  '/api/booking': './api/booking.js',
  '/api/health': './api/health.js',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  const handlerPath = ROUTES[path];
  if (handlerPath) {
    try {
      const mod = await import(handlerPath);
      return await mod.default(req, res);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: error.message }));
    }
  }

  // Static files. The preview is public, so never hand out anything that is
  // not part of the site: dotfiles (.env, .git), the source folders, tests.
  const rel = path === '/' ? '/index.html' : path;
  const BLOCKED = [
    /(^|\/)\./,
    /(^|\/)node_modules(\/|$)/i,
    /(^|\/)(api|lib|test|tools)(\/|$)/i,
    /(^|\/)(dev-server\.mjs|vercel\.json|package(-lock)?\.json)$/i,
    /\.(zip|tar|gz|log|bak|pem|key|md)$/i,
  ];
  const decoded = decodeURIComponent(rel);
  if (BLOCKED.some((re) => re.test(decoded))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  const file = resolve(__dirname, '.' + decoded);
  if (!file.startsWith(resolve(__dirname))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`GOOGLEFLIGHTS dev server → http://localhost:${PORT}`);
  console.log(`Offline endpoints: /api/build · /api/plan · /api/decode · /api/parse-results`);
  console.log(`Live fetch: ${LIVE_ENABLED() ? 'ENABLED (GF_LIVE=1) — keep the volume low' : 'disabled (set GF_LIVE=1)'}`);
});
