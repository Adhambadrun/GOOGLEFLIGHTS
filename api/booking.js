// POST /api/booking — a deep link to ONE exact itinerary.
//
// body: {
//   segments: [[{ origin, date, dest, airline, flightNumber }, …], …],
//   seat?: 'business',
//   passengers?: { adults: 2 },
//   hl?, gl?, curr?
// }
//
// Deterministic: same flights in, same URL out, every time. No session, no
// network call. See lib/booking-link.js for the two encoding details that
// separate a booking token from a search token.

import { buildBookingLink } from '../lib/booking-link.js';
import { sendJson, readJsonBody, methodGuard, safe } from '../lib/http.js';

export default safe(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;
  const body = await readJsonBody(req);
  try {
    sendJson(
      res,
      200,
      buildBookingLink({
        segments: body.segments,
        seat: body.seat,
        passengers: body.passengers,
        currency: body.curr ?? body.currency,
        language: body.hl ?? body.language,
        country: body.gl ?? body.country,
      })
    );
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});
