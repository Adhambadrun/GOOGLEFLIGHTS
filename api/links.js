// POST /api/links — the unified itinerary: every output for one trip, at once.
//
// This is the join between GOOGLEFLIGHTS and SpicyLinkGenerator. Give it an
// itinerary in ANY of the three shapes the two repositories already speak and
// it returns all four things you can do with it:
//
//   strategies.perLeg        one-way Google Flights link per leg, own cabin each
//   strategies.board         one multi-city Google Flights link, highest cabin
//   strategies.airlineLinks  AA metasearch / BA's empty form / homepages
//   strategies.matrixJson    a Matrix-shaped itinerary document
//
// body (pick ONE of legs / segments / itinerary):
//   { legs:     [{ from:'JFK', to:'LHR', date:'2026-12-01', cabin:'business' }] }
//   { segments: [{ origin:'JFK', dest:'LHR', ymd:'2026-12-01', carrier:'AA',
//                  num:'100', cls:'J', depH:19, depM:0, arrH:7, arrM:0, plus:true }] }
//   { itinerary: { slices: [{ segments: [ …Matrix JSON… ] }] } }
//
//   passengers?: { adults:2 } or { adults:1, seniors:1, youths:0, children:0,
//                  infantsInSeat:0, infantsInLap:0 }
//   carrier?: 'BA'          resolve ONE airline link instead of all of them
//   maxStops?, carriers?, currency?, language?, country?
//
// Pure and offline: building this payload makes zero network requests. Anything
// that cannot be built honestly comes back as `available:false` with the reason
// and the exact list of missing fields — never a fabricated link.

import { buildUnifiedItinerary } from '../lib/unified.js';
import { sendJson, readJsonBody, methodGuard, safe } from '../lib/http.js';

/** The pure half, exported so tests can call it without a socket. */
export function buildLinks(body = {}) {
  return buildUnifiedItinerary(body);
}

export default safe(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;
  const body = await readJsonBody(req);
  try {
    sendJson(res, 200, buildLinks(body));
  } catch (error) {
    // A malformed itinerary is the caller's problem, not a server fault.
    sendJson(res, 400, { error: error.message });
  }
});
