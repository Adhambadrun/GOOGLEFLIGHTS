// Tiny helpers shared by the /api handlers so they read the same way the
// Vercel functions do, and so tests can call the pure logic directly.

export function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body, (_, value) => (typeof value === 'bigint' ? value.toString() : value)));
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('body is not valid JSON');
  }
}

export function methodGuard(req, res, method = 'POST') {
  if (req.method === method) return true;
  sendJson(res, 405, { error: `${method} only` });
  return false;
}

/** Wrap a handler so thrown errors become a clean 500 instead of a crash. */
export function safe(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  };
}
