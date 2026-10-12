// Booking deep links: URLs that open ONE exact itinerary.
//
//   https://www.google.com/travel/flights/booking?tfs=…
//
// The token pins each physical flight (tfs field 3.4), so the page opens with
// that itinerary loaded — vendor fares and the "Continue" handoff included.
// It is deterministic: airports + dates + flight numbers, no session id, no
// network round-trip. The same itinerary always yields the same URL, which
// makes it safe to generate offline, store, and email.
//
// Two details that matter and are easy to get wrong:
//
//   * Booking tokens carry the field-16 pin (max uint64) that search tokens do
//     not. Without it the deep link still opens, but not as a booking page.
//   * Field 19 is 2 for a single-segment booking and 1 for anything with more
//     segments — including multi-city. It is NOT the 1/2/3 trip enum the
//     search token uses.

import { buildTfs, bookingUrl, normalizeCabin } from './tfs.js';

/**
 * @param {object} spec
 * @param {Array<Array<{origin:string,date:string,dest:string,airline:string,flightNumber:string|number}>>} spec.segments
 *   One entry per travel direction; each is the ordered list of physical legs
 *   inside that direction (one for non-stop, several for a connection).
 * @param {string|number} [spec.seat]  Cabin for the booking page.
 * @param {object} [spec.passengers]   Traveller mix.
 * @param {string} [spec.currency] [spec.language] [spec.country]
 */
export function buildBookingLink(spec) {
  const segments = spec.segments ?? [];
  if (!segments.length) throw new RangeError('at least one segment is required');

  const encoded = segments.map((legs) => {
    if (!Array.isArray(legs) || !legs.length) throw new RangeError('each segment needs at least one leg');
    return {
      date: legs[0].date,
      from: legs[0].origin,
      to: legs[legs.length - 1].dest,
      legs: legs.map((leg) => ({
        origin: leg.origin,
        date: leg.date ?? legs[0].date,
        dest: leg.dest,
        airline: leg.airline,
        flightNumber: leg.flightNumber,
      })),
    };
  });

  const tfs = buildTfs({
    segments: encoded,
    // Booking tokens: 2 for one segment, 1 for two or more (multi-city included).
    trip: segments.length === 1 ? 2 : 1,
    seat: normalizeCabin(spec.seat),
    passengers: spec.passengers,
    pinMaxU64: true,
  });

  return {
    tfs,
    url: bookingUrl(tfs, { hl: spec.language ?? 'en', gl: spec.country ?? 'US', curr: spec.currency }),
  };
}

/**
 * Build a booking link straight out of a parsed result (see lib/results.js).
 * Accepts one itinerary or one per travel direction.
 */
export function bookingLinkFromItineraries(itineraries, options = {}) {
  const list = Array.isArray(itineraries) ? itineraries : [itineraries];
  const segments = list.map((itinerary) =>
    (itinerary.legs ?? []).map((leg) => ({
      origin: leg.from,
      date: (leg.departure ?? '').slice(0, 10),
      dest: leg.to,
      airline: leg.airline,
      flightNumber: leg.flightNumber,
    }))
  );
  return buildBookingLink({ ...options, segments });
}
