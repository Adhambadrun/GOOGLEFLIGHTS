// POST /api/search — live fetch. DISABLED unless GF_LIVE=1.
//
// See lib/live.js for what this does and does not do. Short version: one
// plain, rate-limited GET of the public results page, no RPC, no evasion.
// Automated querying of Google is against their Terms of Service — keep this
// to low-volume personal research.

import { fetchSearchPage, createRateLimiter, LIVE_ENABLED } from '../lib/live.js';
import { buildTfs } from '../lib/tfs.js';
import { sendJson, readJsonBody, methodGuard, safe } from '../lib/http.js';

// Shared across warm invocations: at most one request in flight, spaced out.
const schedule = createRateLimiter(Number(process.env.GF_MIN_INTERVAL_MS ?? 3000));

export default safe(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;
  if (!LIVE_ENABLED()) {
    return sendJson(res, 403, {
      error: 'live search is disabled. Set GF_LIVE=1 to enable it (low-volume research only).',
      offline: ['/api/build', '/api/plan', '/api/decode', '/api/parse-results'],
    });
  }
  const body = await readJsonBody(req);
  let tfs = body.tfs;
  if (!tfs) {
    try {
      tfs = buildTfs(body);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  const result = await schedule(() =>
    fetchSearchPage(tfs, { hl: body.hl, gl: body.gl, curr: body.curr })
  );
  sendJson(res, result.ok ? 200 : 502, result);
});
