// POST /api/plan — the mixed-cabin, multi-leg planner.
//
// body: {
//   legs: [{ from: 'JFK', to: 'LHR', date: '2026-12-01', cabin: 'business' },
//          { from: 'LHR', to: 'CAI', date: '2026-12-08', cabin: 'economy' }],
//   passengers: { adults: 1 },
//   maxStops?, carriers?, currency?, language?, country?,
//   strategies: ['per-leg','board','matrix']
// }
//
// Returns one token set per strategy. See lib/mixed-cabin.js for why there is
// more than one answer to "search this trip in these cabins".

import { planMixedCabin } from '../lib/mixed-cabin.js';
import { sendJson, readJsonBody, methodGuard, safe } from '../lib/http.js';

export default safe(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;
  const body = await readJsonBody(req);
  try {
    sendJson(res, 200, planMixedCabin(body));
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});
