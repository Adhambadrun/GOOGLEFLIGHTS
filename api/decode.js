// POST /api/decode  (also accepts GET ?tfs=…)
//
// Decode any `tfs` token back into a readable structure. Unknown fields are
// surfaced rather than dropped, and the token is re-encoded alongside the
// original: if `roundTrip.matches` is false, this schema is missing something
// the token carries, and you should look at `unknown` before trusting it.

import { decodeTfs, buildTfs, passengerMix } from '../lib/tfs.js';
import { describeMessage, toHex } from '../lib/protobuf.js';
import { sendJson, readJsonBody, safe } from '../lib/http.js';

export function decodeToken(token) {
  const decoded = decodeTfs(token);

  const rebuilt = buildTfs({
    segments: decoded.segments.map((s) => ({
      date: s.date,
      from: s.from,
      to: s.to,
      maxStops: s.maxStops,
      carriers: s.carriers,
      carriersExclude: s.carriersExclude,
      layoverAirports: s.layoverAirports,
      minLayover: s.minLayover,
      maxLayover: s.maxLayover,
      legs: s.legs,
    })),
    trip: decoded.trip,
    seat: decoded.seat,
    passengers: passengerMix(decoded.passengers),
    pinMaxU64: decoded.pinned,
  });

  return {
    token: decoded.token,
    byteLength: decoded.bytes.length,
    hex: toHex(decoded.bytes),
    trip: decoded.tripName,
    seat: decoded.seatName,
    passengers: decoded.passengers,
    pinned: decoded.pinned,
    constants: decoded.constants,
    segments: decoded.segments,
    unknown: decoded.unknown,
    tree: describeMessage(decoded.bytes),
    roundTrip: { token: rebuilt, matches: rebuilt === decoded.token },
  };
}

export default safe(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const token = req.method === 'GET' ? url.searchParams.get('tfs') : (await readJsonBody(req)).tfs;
  if (!token) {
    return sendJson(res, 400, { error: 'missing tfs (POST {tfs} or GET ?tfs=)' });
  }
  try {
    sendJson(res, 200, decodeToken(token));
  } catch (error) {
    sendJson(res, 400, { error: `could not decode tfs: ${error.message}` });
  }
});
