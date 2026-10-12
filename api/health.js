// GET /api/health — deployment smoke test, same convention as the reference repo.

import { LIVE_ENABLED } from '../lib/live.js';
import { sendJson, safe } from '../lib/http.js';

export default safe(async (req, res) => {
  sendJson(res, 200, {
    ok: true,
    app: 'GOOGLEFLIGHTS',
    api: 'v1',
    liveEnabled: LIVE_ENABLED(),
    live: LIVE_ENABLED()
      ? 'enabled — one rate-limited GET per request, no RPC, no evasion'
      : 'disabled — set GF_LIVE=1 to turn on /api/search',
    endpoints: {
      'POST /api/build': 'build a tfs search token + URLs (offline)',
      'POST /api/plan': 'mixed-cabin multi-leg plan (offline)',
      'POST /api/decode': 'decode any tfs token (offline)',
      'POST /api/parse-results': 'decode itineraries out of a saved page (offline)',
      'POST /api/booking': 'deep link to one exact itinerary (offline)',
      'POST /api/search': 'fetch a results page live (GF_LIVE=1 only)',
    },
  });
});
