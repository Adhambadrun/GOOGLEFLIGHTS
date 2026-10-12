// POST /api/build
//
// Build a `tfs` search token and its URLs. Pure: no network call.
//
// body: {
//   segments: [{ date, from, to, cabin? ignored here, maxStops?, carriers?, carriersExclude?,
//                layoverAirports?, minLayover?, maxLayover?, legs? }],
//   seat: 'business',            // one cabin for the WHOLE search
//   trip: 'one-way',             // one-way | round-trip | multi-city
//   passengers: { adults: 2, children: 1 },
//   flavor: 'google' | 'minimal',
//   hl, gl, curr
// }

import { buildTfs, decodeTfs, searchUrl, normalizeCabin } from '../lib/tfs.js';
import { sendJson, readJsonBody, methodGuard, safe } from '../lib/http.js';

export function buildSearch(body = {}) {
  const tfs = buildTfs({
    segments: body.segments,
    seat: body.seat,
    trip: body.trip,
    passengers: body.passengers,
    flavor: body.flavor,
  });
  const locale = { hl: body.hl ?? 'en', gl: body.gl ?? 'US', curr: body.curr };
  return {
    tfs,
    url: searchUrl(tfs, locale),
    decoded: decodeTfs(tfs),
    cabinRequested: normalizeCabin(body.seat),
  };
}

export default safe(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;
  const body = await readJsonBody(req);
  sendJson(res, 200, buildSearch(body));
});
