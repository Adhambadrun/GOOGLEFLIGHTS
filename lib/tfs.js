// The `tfs` parameter codec.
//
// `tfs` is the whole Google Flights search, serialised as one protobuf message
// and url-safe-base64'd. Give Google a valid token and it renders the results
// page directly — no form interaction, no RPC. Everything in this file is
// offline: it builds and reads bytes, it never talks to Google.
//
// Field map (reverse-engineered; see PROTOCOL.md for provenance and for the
// parts that are still inferred):
//
//   top level (what this file calls `Info`)
//     1  = 28 (constant)          9  = cabin class (Seat)
//     2  = 2  (constant)          14 = 1  (constant)
//     3  = segment, repeated      16 = max-uint64 pin (booking deep links only)
//     8  = passenger, repeated    19 = trip type (Trip)
//
//   segment (inside field 3)
//     2  = departure date "YYYY-MM-DD"
//     4  = pinned physical leg, repeated
//     5  = stop ceiling (ZERO-BASED: 0 = non-stop; omit for "any")
//     6  = carrier include, repeated (IATA code or alliance name)
//     7  = carrier exclude, repeated
//     13 = origin airport, repeated        (Airport: 1 = 1 constant, 2 = IATA)
//     14 = destination airport, repeated
//     15 = layover airport include, repeated
//     17 = min layover minutes
//     18 = max layover minutes
//
//   pinned leg (inside field 3.4)
//     1 = origin IATA   2 = date   3 = destination IATA
//     5 = airline IATA  6 = flight number

import {
  WIRE,
  concat,
  decodeFields,
  encodeBytesField,
  encodeStringField,
  encodeVarintField,
  fromBase64Url,
  looksLikeAsciiString,
  bytesToAscii,
  toBase64Url,
  toHex,
} from './protobuf.js';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Cabin class, as Google numbers it in tfs field 9 and per-leg field 16. */
export const SEAT = Object.freeze({
  ECONOMY: 1,
  PREMIUM_ECONOMY: 2,
  BUSINESS: 3,
  FIRST: 4,
});

export const SEAT_NAMES = Object.freeze(['unknown', 'economy', 'premium-economy', 'business', 'first']);

/** Trip type, tfs field 19. */
export const TRIP = Object.freeze({
  ROUND_TRIP: 1,
  ONE_WAY: 2,
  MULTI_CITY: 3,
});

export const TRIP_NAMES = Object.freeze(['unknown', 'round-trip', 'one-way', 'multi-city']);

/**
 * Passenger kind, tfs field 8 — one entry per traveller.
 *
 * The two infant codes are the ones worth getting right, and they are
 * contradictorily documented in the community: `fast-flights`' published proto
 * has 3 = INFANT_IN_SEAT and 4 = INFANT_ON_LAP, while live pricing in `fli`
 * shows [adult, 3] costing ~10% more (a lap infant) and [adult, 4] ~100% more
 * (an infant in its own seat). We follow the live-pricing evidence.
 */
export const PASSENGER = Object.freeze({
  ADULT: 1,
  CHILD: 2,
  INFANT_ON_LAP: 3,
  INFANT_IN_SEAT: 4,
});

export const PASSENGER_NAMES = Object.freeze(['unknown', 'adult', 'child', 'infant-on-lap', 'infant-in-seat']);

/** Google's own per-booking ceiling on travellers. */
export const MAX_TRAVELLERS = 9;

// Values Google writes into the top-level message on every capture we have.
// They are not understood — they are just always there — and Google tolerates
// their absence, which is why `flavor: 'minimal'` exists.
//
// They are not adjacent: 1 and 2 open the message, 14 is written after the
// seat (field 9) and before the trip (field 19). Getting that order wrong
// still produces a token Google accepts, so it shows up first as a
// byte-mismatch against real captures rather than as a broken link — which is
// exactly why the golden tests compare bytes.
const CONSTANTS_HEAD = [
  { field: 1, value: 28 },
  { field: 2, value: 2 },
];
const CONSTANTS_TAIL = [{ field: 14, value: 1 }];

const MAX_UINT64 = (1n << 64n) - 1n;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IATA_RE = /^[A-Za-z0-9]{2,3}$/;

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

const CABIN_ALIASES = new Map([
  ['economy', SEAT.ECONOMY], ['econ', SEAT.ECONOMY], ['y', SEAT.ECONOMY], ['1', SEAT.ECONOMY],
  ['premium', SEAT.PREMIUM_ECONOMY], ['premium-economy', SEAT.PREMIUM_ECONOMY],
  ['premium_economy', SEAT.PREMIUM_ECONOMY], ['premiumeconomy', SEAT.PREMIUM_ECONOMY],
  ['pe', SEAT.PREMIUM_ECONOMY], ['premium economy', SEAT.PREMIUM_ECONOMY], ['w', SEAT.PREMIUM_ECONOMY],
  ['2', SEAT.PREMIUM_ECONOMY],
  ['business', SEAT.BUSINESS], ['biz', SEAT.BUSINESS], ['j', SEAT.BUSINESS], ['c', SEAT.BUSINESS],
  ['3', SEAT.BUSINESS],
  ['first', SEAT.FIRST], ['first-class', SEAT.FIRST], ['first_class', SEAT.FIRST],
  ['f', SEAT.FIRST], ['4', SEAT.FIRST],
]);

/** Accept 'business', 'BUSINESS', 'Business', 3 — and throw on anything else. */
export function normalizeCabin(value) {
  if (value === undefined || value === null || value === '') return SEAT.ECONOMY;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 4) {
      throw new RangeError(`cabin must be 1-4, got ${value}`);
    }
    return value;
  }
  const key = String(value).trim().toLowerCase();
  if (CABIN_ALIASES.has(key)) return CABIN_ALIASES.get(key);
  throw new RangeError(
    `unknown cabin ${JSON.stringify(value)} — use economy, premium-economy, business or first`
  );
}

export function cabinName(code) {
  return SEAT_NAMES[code] ?? `unknown(${code})`;
}

/**
 * Turn a passenger mix into the repeated field-8 codes.
 * Accepts {adults, children, infantsOnLap / infants_on_lap, infantsInSeat / infants_in_seat}.
 */
export function passengerCodes(mix = {}) {
  const counts = [
    [PASSENGER.ADULT, num(mix.adults ?? mix.adult, 'adults')],
    [PASSENGER.CHILD, num(mix.children ?? mix.child, 'children')],
    [PASSENGER.INFANT_ON_LAP, num(mix.infantsOnLap ?? mix.infants_on_lap, 'infantsOnLap')],
    [PASSENGER.INFANT_IN_SEAT, num(mix.infantsInSeat ?? mix.infants_in_seat, 'infantsInSeat')],
  ];
  const total = counts.reduce((n, [, c]) => n + c, 0);
  if (total > MAX_TRAVELLERS) {
    throw new RangeError(`${total} travellers exceeds Google's ${MAX_TRAVELLERS}-traveller limit`);
  }
  const codes = [];
  for (const [code, count] of counts) {
    for (let i = 0; i < count; i++) codes.push(code);
  }
  // Google's booking page needs at least one traveller.
  return codes.length ? codes : [PASSENGER.ADULT];
}

function num(value, name) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function assertDate(value, label) {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '');
  if (!DATE_RE.test(text) || Number.isNaN(Date.parse(text))) {
    throw new RangeError(`${label} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  }
  return text;
}

function assertAirport(value, label) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!IATA_RE.test(code)) {
    throw new RangeError(`${label} must be a 2-3 character IATA code, got ${JSON.stringify(value)}`);
  }
  return code;
}

const asList = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encode one travel direction (a field-3 segment, tag included).
 *
 * @param {object} seg
 * @param {string} seg.date         Departure date, YYYY-MM-DD.
 * @param {string|string[]} seg.from  Origin IATA code(s) (multi-airport searches).
 * @param {string|string[]} seg.to    Destination IATA code(s).
 * @param {Array<{origin:string,date:string,dest:string,airline:string,flightNumber:string|number}>} [seg.legs]
 *   Physical flights to pin. Supplying them narrows a search to itineraries
 *   containing them — this is how a round trip asks for returns against a
 *   chosen outbound, and how booking deep links address one exact itinerary.
 * @param {number} [seg.maxStops]  Stop ceiling, ZERO-BASED: 0 = non-stop,
 *   1 = one stop or fewer. Leave undefined for "any" — passing 0 for "any"
 *   would silently pin the search to non-stop.
 */
export function encodeSegment(seg) {
  if (!seg || typeof seg !== 'object') throw new TypeError('segment must be an object');
  const date = assertDate(seg.date, 'segment.date');
  const from = asList(seg.from).map((c) => assertAirport(c, 'segment.from'));
  const to = asList(seg.to).map((c) => assertAirport(c, 'segment.to'));
  if (!from.length || !to.length) throw new RangeError('segment needs at least one origin and destination');

  let body = encodeStringField(2, date);

  if (seg.maxStops !== undefined && seg.maxStops !== null) {
    body = concat(body, encodeVarintField(5, seg.maxStops));
  }
  for (const code of asList(seg.carriers)) body = concat(body, encodeStringField(6, code));
  for (const code of asList(seg.carriersExclude)) body = concat(body, encodeStringField(7, code));

  for (const leg of asList(seg.legs)) {
    body = concat(
      body,
      encodeBytesField(
        4,
        concat(
          encodeStringField(1, assertAirport(leg.origin, 'leg.origin')),
          encodeStringField(2, assertDate(leg.date, 'leg.date')),
          encodeStringField(3, assertAirport(leg.dest, 'leg.dest')),
          encodeStringField(5, String(leg.airline).toUpperCase()),
          encodeStringField(6, String(leg.flightNumber))
        )
      )
    );
  }

  for (const code of from) body = concat(body, encodeBytesField(13, airportBody(code)));
  for (const code of to) body = concat(body, encodeBytesField(14, airportBody(code)));
  for (const code of asList(seg.layoverAirports)) body = concat(body, encodeStringField(15, code));
  if (seg.minLayover !== undefined && seg.minLayover !== null) {
    body = concat(body, encodeVarintField(17, seg.minLayover));
  }
  if (seg.maxLayover !== undefined && seg.maxLayover !== null) {
    body = concat(body, encodeVarintField(18, seg.maxLayover));
  }
  return encodeBytesField(3, body);
}

const airportBody = (code) => concat(encodeVarintField(1, 1), encodeStringField(2, code));

/**
 * Wrap encoded segments in the top-level envelope.
 *
 * @param {object} spec
 * @param {Array}  spec.segments      Output of {@link encodeSegment} (or plain objects).
 * @param {number|string} [spec.seat] Cabin — applies to the WHOLE search,
 *   which is precisely why mixed-cabin needs more than one token
 *   (see lib/mixed-cabin.js).
 * @param {number|string} [spec.trip] Round-trip / one-way / multi-city.
 * @param {object} [spec.passengers]  Traveller mix.
 * @param {'google'|'minimal'} [spec.flavor] `google` emits the three constant
 *   fields every real capture carries; `minimal` omits them (Google accepts
 *   both; `google` is the safer default because it is what Google itself sends).
 * @param {boolean} [spec.pinMaxU64]  Emit the field-16 pin that booking deep
 *   links carry. The search page does not need it.
 */
export function encodeInfo(spec) {
  const segments = asList(spec.segments);
  if (!segments.length) throw new RangeError('at least one segment is required');

  let out = new Uint8Array(0);
  if ((spec.flavor ?? 'google') === 'google') {
    for (const { field, value } of CONSTANTS_HEAD) out = concat(out, encodeVarintField(field, value));
  }

  for (const seg of segments) {
    out = concat(out, seg instanceof Uint8Array ? seg : encodeSegment(seg));
  }

  for (const code of passengerCodes(spec.passengers)) out = concat(out, encodeVarintField(8, code));
  out = concat(out, encodeVarintField(9, normalizeCabin(spec.seat)));

  if ((spec.flavor ?? 'google') === 'google') {
    for (const { field, value } of CONSTANTS_TAIL) out = concat(out, encodeVarintField(field, value));
  }

  if (spec.pinMaxU64) {
    // A length-delimited field 16 wrapping one varint holding 2^64-1. This is
    // what marks a token as a booking deep link rather than a search.
    const pin = concat(Uint8Array.from([(1 << 3) | WIRE.VARINT]), encodeVarintBig(MAX_UINT64));
    out = concat(out, encodeBytesField(16, pin));
  }

  const trip = normalizeTrip(spec.trip, segments.length);
  out = concat(out, encodeVarintField(19, trip));
  return out;
}

function encodeVarintBig(value) {
  const out = [];
  let v = value;
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v & 0x7fn));
  return Uint8Array.from(out);
}

function normalizeTrip(trip, segmentCount) {
  if (trip === undefined || trip === null || trip === '') {
    return segmentCount > 1 ? TRIP.MULTI_CITY : TRIP.ONE_WAY;
  }
  if (typeof trip === 'number') {
    if (![1, 2, 3].includes(trip)) throw new RangeError(`trip must be 1-3, got ${trip}`);
    return trip;
  }
  const key = String(trip).trim().toLowerCase().replace(/[\s_]/g, '-');
  const map = { 'round-trip': 1, roundtrip: 1, rt: 1, 'one-way': 2, oneway: 2, ow: 2, 'multi-city': 3, multicity: 3, mc: 3 };
  if (!(key in map)) throw new RangeError(`unknown trip ${JSON.stringify(trip)}`);
  return map[key];
}

/** Build a complete `tfs` value (url-safe base64, no padding). */
export function buildTfs(spec) {
  return toBase64Url(encodeInfo(spec));
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode any `tfs` token into a readable structure.
 *
 * Unknown fields are preserved in `unknown` rather than dropped, so a token
 * Google emitted with a field this schema has never seen still round-trips to
 * the same bytes.
 */
export function decodeTfs(token) {
  const bytes = token instanceof Uint8Array ? token : fromBase64Url(String(token).trim());
  const fields = decodeFields(bytes);
  const grouped = new Map();
  for (const f of fields) {
    if (!grouped.has(f.fieldNumber)) grouped.set(f.fieldNumber, []);
    grouped.get(f.fieldNumber).push(f);
  }

  const seat = firstVarint(grouped, 9);
  const trip = firstVarint(grouped, 19);

  return {
    bytes,
    token: toBase64Url(bytes),
    trip,
    tripName: TRIP_NAMES[trip] ?? `unknown(${trip})`,
    seat,
    seatName: seat !== undefined ? cabinName(seat) : undefined,
    passengers: (grouped.get(8) ?? []).map((f) => ({
      code: Number(f.value),
      name: PASSENGER_NAMES[Number(f.value)] ?? `unknown(${f.value})`,
    })),
    segments: (grouped.get(3) ?? []).map((f) => decodeSegment(f.value)),
    pinned: grouped.has(16),
    constants: Object.fromEntries(
      [1, 2, 14]
        .filter((n) => grouped.has(n))
        .map((n) => [`f${n}`, Number((grouped.get(n) ?? [])[0].value)])
    ),
    unknown: unknownMap(fields, [1, 2, 3, 8, 9, 14, 16, 19]),
    fields,
  };
}

/**
 * Collect fields this schema does not know, keyed by field number.
 *
 * Value is a single entry when the field appears once, an array when it
 * repeats. These are surfaced, not dropped: a token carrying something new
 * should still round-trip, and the unknown map is how you find out what
 * Google added (see tools/CAPTURE.md on the `diff` probe).
 */
function unknownMap(fields, known) {
  const out = {};
  for (const f of fields) {
    if (known.includes(f.fieldNumber)) continue;
    const value = f.wireType === WIRE.LENGTH_DELIMITED ? preview(f.value) : Number(f.value);
    const key = `f${f.fieldNumber}`;
    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

function decodeSegment(buf) {
  const grouped = new Map();
  for (const f of decodeFields(buf)) {
    if (!grouped.has(f.fieldNumber)) grouped.set(f.fieldNumber, []);
    grouped.get(f.fieldNumber).push(f);
  }
  // Airports are REPEATED: a multi-airport search ("JFK, EWR → LHR, LGW")
  // emits one field-13 per origin and one field-14 per destination. Reading
  // only the first would silently drop the rest of the search.
  const airports = (n) =>
    (grouped.get(n) ?? [])
      .map((entry) => {
        const inner = new Map();
        for (const f of decodeFields(entry.value)) inner.set(f.fieldNumber, f);
        return inner.has(2) ? bytesToAscii(inner.get(2).value) : undefined;
      })
      .filter(Boolean);
  const strings = (n) =>
    (grouped.get(n) ?? []).map((f) => (looksLikeAsciiString(f.value) ? bytesToAscii(f.value) : toHex(f.value)));

  const stops = firstVarint(grouped, 5);
  const dateField = (grouped.get(2) ?? [])[0];

  return {
    date: dateField ? bytesToAscii(dateField.value) : undefined,
    from: airports(13),
    to: airports(14),
    // Stops is zero-based in the token; report it as the human ceiling.
    maxStops: stops === undefined ? undefined : stops,
    stopsLabel: stops === undefined ? 'any' : stops === 0 ? 'non-stop' : `${stops} stop(s) or fewer`,
    carriers: strings(6),
    carriersExclude: strings(7),
    layoverAirports: strings(15),
    minLayover: firstVarint(grouped, 17),
    maxLayover: firstVarint(grouped, 18),
    legs: (grouped.get(4) ?? []).map((f) => {
      const inner = new Map();
      for (const g of decodeFields(f.value)) inner.set(g.fieldNumber, g);
      const str = (n) => (inner.has(n) ? bytesToAscii(inner.get(n).value) : undefined);
      return { origin: str(1), date: str(2), dest: str(3), airline: str(5), flightNumber: str(6) };
    }),
    unknown: unknownMap(decodeFields(buf), [2, 4, 5, 6, 7, 13, 14, 15, 17, 18]),
  };
}

/**
 * Turn a decoded passenger list back into a `{adults, children, …}` mix, so a
 * decoded token can be re-encoded without losing travellers.
 *
 * @param {Array<{code:number,name:string}>} passengers
 */
export function passengerMix(passengers = []) {
  const map = {
    adult: 'adults',
    child: 'children',
    'infant-on-lap': 'infantsOnLap',
    'infant-in-seat': 'infantsInSeat',
  };
  const mix = {};
  for (const p of passengers) {
    const key = map[p.name] ?? map[String(p.code)];
    if (key) mix[key] = (mix[key] ?? 0) + 1;
  }
  return mix;
}

function firstVarint(grouped, field) {
  const entry = (grouped.get(field) ?? [])[0];
  return entry ? Number(entry.value) : undefined;
}

function preview(bytes) {
  return looksLikeAsciiString(bytes) ? bytesToAscii(bytes) : `hex:${toHex(bytes.slice(0, 16))}`;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const BASE = 'https://www.google.com/travel/flights';

/**
 * The results page for a search token. This is the one URL that works for
 * every trip type, including multi-city.
 */
export function searchUrl(tfs, { hl = 'en', gl = 'US', curr } = {}) {
  const params = new URLSearchParams({ tfs, hl, gl });
  if (curr) params.set('curr', curr);
  return `${BASE}/search?${params}`;
}

/**
 * The booking page for one exact itinerary (pinned legs). Google shows the
 * vendor list and the "Continue" handoff here.
 */
export function bookingUrl(tfs, { hl = 'en', gl = 'US', curr } = {}) {
  const params = new URLSearchParams({ tfs, hl, gl });
  if (curr) params.set('curr', curr);
  return `${BASE}/booking?${params}`;
}
