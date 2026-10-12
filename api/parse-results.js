// POST /api/parse-results
//
// Parse a SAVED Google Flights page. Offline: you paste the HTML you saved
// from your browser (see tools/CAPTURE.md), this reads the `ds:1` blob out of
// it and decodes the itineraries — including the per-leg cabin codes and
// Google's own mixed-cabin flag.
//
// body: { html: '…', cabinVector?: ['business','economy'], allowUpgrades?: true }
//
// When `cabinVector` is supplied every itinerary is scored against it and the
// matching ones are ranked cheapest-first.

import { parseResultsHtml, filterByCabinVector, matchCabinVector } from '../lib/results.js';
import { sendJson, readJsonBody, methodGuard, safe } from '../lib/http.js';

export function parseResults(body = {}) {
  const result = parseResultsHtml(body.html ?? '');
  const vector = body.cabinVector;
  const out = { ...result };
  if (vector && result.itineraries?.length) {
    const ranked = filterByCabinVector(result.itineraries, vector, {
      allowUpgrades: body.allowUpgrades !== false,
    });
    out.cabinVector = vector;
    out.matches = ranked.map(({ itinerary, verdict }) => ({
      price: itinerary.price,
      currency: itinerary.currency,
      airline: itinerary.airlineName ?? itinerary.airline,
      durationMinutes: itinerary.durationMinutes,
      stops: itinerary.stops,
      mixedCabin: itinerary.mixedCabin,
      perLeg: verdict.perLeg,
      exact: verdict.exact,
    }));
    out.scored = result.itineraries.map((itinerary) => matchCabinVector(itinerary, vector));
  }
  return out;
}

export default safe(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;
  const body = await readJsonBody(req);
  if (!body.html) return sendJson(res, 400, { error: 'missing html' });
  sendJson(res, 200, parseResults(body));
});
