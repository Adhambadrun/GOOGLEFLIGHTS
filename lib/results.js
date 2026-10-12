// Decode Google Flights result rows.
//
// A saved search page carries its results inline, in an `AF_initDataCallback`
// blob keyed `ds:1`. The blob's JSON has the SAME shape the (now
// signature-gated) shopping RPC used to return, so parsing it offline is both
// possible and stable: save the page from a browser, parse it here, no request
// to Google at all.
//
// Row / leg indices below are the ones used by the reference decoders and
// verified against captured fixtures. They are positional, not named, so every
// read is guarded — a field that moves should degrade one field, not throw
// away the itinerary.
//
//   payload[2][0] and payload[3][0]  -> arrays of flight rows
//
//   row[0]   detail block                 row[8]   booking token (protobuf)
//   row[1]   price block                  row[10]  MIXED CABIN flag   <-- key
//   row[0][0]  primary airline code       row[0][2] legs
//   row[0][1]  airline names              row[0][9] duration (minutes)
//   row[0][12] self-transfer flag         row[0][13] layover info
//
//   leg[3]  origin IATA      leg[4]  origin name     leg[5]  dest name
//   leg[6]  dest IATA        leg[8]  dep time [h,m]  leg[10] arr time [h,m]
//   leg[11] duration         leg[16] CABIN (1..4)    leg[17] aircraft   <-- key
//   leg[19] overnight        leg[20] dep date [y,m,d]
//   leg[21] arr date [y,m,d] leg[22] [airline, flight number, operating]
//   leg[31] CO2 grams

import { SEAT, SEAT_NAMES } from './tfs.js';
import { WIRE, decodeFields, fromBase64Url, bytesToAscii } from './protobuf.js';

// AF_initDataCallback({key: 'ds:1', hash: '..', data:[...], sideChannel: {}});
const BLOB_RE = /AF_initDataCallback\((\{.*?\})\);/gs;
const KEY_RE = /key:\s*'([^']+)'/;
const DATA_RE = /data:(.*?), sideChannel/s;

/**
 * Pull the `ds:1` payload out of a saved search page.
 *
 * @param {string} html
 * @returns {any|null} The decoded payload, or null when the page carried none
 *   (a consent page, a block page, or — for multi-city — a page whose rows
 *   Google only loads client-side).
 */
export function extractPayload(html) {
  for (const match of html.matchAll(BLOB_RE)) {
    const blob = match[1];
    const key = KEY_RE.exec(blob);
    if (!key || key[1] !== 'ds:1') continue;
    const data = DATA_RE.exec(blob);
    if (!data) continue;
    try {
      return JSON.parse(data[1]);
    } catch {
      return null;
    }
  }
  return null;
}

/** Return the raw flight rows from a `ds:1` payload. */
export function flightRows(payload) {
  if (!Array.isArray(payload)) return [];
  const rows = [];
  for (const index of [2, 3]) {
    const bucket = payload[index];
    if (Array.isArray(bucket) && Array.isArray(bucket[0])) rows.push(...bucket[0]);
  }
  return rows;
}

const at = (node, index) => (Array.isArray(node) ? node[index] : undefined);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function datetime(dateArr, timeArr) {
  if (!Array.isArray(dateArr) || !Array.isArray(timeArr)) return null;
  const [y, m, d] = dateArr;
  const [h, min] = timeArr;
  if (![y, m, d].every(isNum)) return null;
  const hh = isNum(h) ? h : 0;
  const mm = isNum(min) ? min : 0;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(
    hh
  ).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function decodeLeg(raw) {
  const airlineInfo = at(raw, 22) ?? [];
  return {
    airline: at(airlineInfo, 0) ?? null,
    flightNumber: at(airlineInfo, 1) != null ? String(at(airlineInfo, 1)) : null,
    operatingAirline: at(airlineInfo, 2) ?? null,
    from: at(raw, 3) ?? null,
    fromName: at(raw, 4) ?? null,
    to: at(raw, 6) ?? null,
    toName: at(raw, 5) ?? null,
    departure: datetime(at(raw, 20), at(raw, 8)),
    arrival: datetime(at(raw, 21), at(raw, 10)),
    durationMinutes: isNum(at(raw, 11)) ? at(raw, 11) : null,
    aircraft: at(raw, 17) ?? null,
    // leg[16] is the per-leg cabin — the field that makes mixed-cabin
    // matching possible at all.
    cabin: isNum(at(raw, 16)) ? at(raw, 16) : null,
    cabinName: isNum(at(raw, 16)) ? SEAT_NAMES[at(raw, 16)] ?? null : null,
    overnight: at(raw, 19) === true,
    co2Grams: isNum(at(raw, 31)) ? at(raw, 31) : null,
  };
}

/**
 * Read the ISO currency out of a price token.
 *
 * The token is a protobuf message: field 3 → nested field 3 → the currency
 * string. It is the same for every row in a response, which is why Google
 * sends it once and refers to it by token.
 */
export function currencyFromPriceToken(token) {
  if (typeof token !== 'string' || !token) return null;
  let bytes;
  try {
    bytes = fromBase64Url(token);
  } catch {
    return null;
  }
  for (const outer of decodeFields(bytes)) {
    if (outer.fieldNumber !== 3 || outer.wireType !== WIRE.LENGTH_DELIMITED) continue;
    for (const inner of decodeFields(outer.value)) {
      if (inner.fieldNumber === 3 && inner.wireType === WIRE.LENGTH_DELIMITED) {
        return bytesToAscii(inner.value).toUpperCase();
      }
    }
  }
  return null;
}

function decodePrice(block) {
  if (!Array.isArray(block)) return { price: null, currency: null, priced: false };
  // Shape: [[…, price], currency_token]
  const head = block[0];
  let price = null;
  if (Array.isArray(head) && head.length) {
    const raw = head[head.length - 1];
    if (isNum(raw)) price = raw;
  }
  // An empty head ([]) is Google saying "no shopping-list price for this row".
  // Routine on premium round-trips, especially with several travellers: the
  // board shows "from $X" and the real fare only appears once you open the
  // itinerary. Price stays null rather than being guessed.
  return { price, currency: currencyFromPriceToken(block[1]), priced: Array.isArray(head) && head.length > 0 };
}

/** Decode one row into an itinerary. Returns null for unparseable rows. */
export function parseRow(row) {
  const detail = at(row, 0);
  if (!Array.isArray(detail)) return null;
  const rawLegs = at(detail, 2) ?? [];
  const legs = (Array.isArray(rawLegs) ? rawLegs : []).map(decodeLeg);
  if (!legs.length) return null;
  const { price, currency } = decodePrice(at(row, 1));
  const names = at(detail, 1);

  return {
    legs,
    price,
    currency,
    airline: at(detail, 0) ?? null,
    airlineName: Array.isArray(names) && typeof names[0] === 'string' ? names[0] : null,
    durationMinutes: isNum(at(detail, 9)) ? at(detail, 9) : null,
    stops: Math.max(legs.length - 1, 0),
    selfTransfer: at(detail, 12) === true,
    // row[10] — Google's own "this itinerary mixes cabins" marker.
    mixedCabin: at(row, 10) === true,
    bookingToken: typeof at(row, 8) === 'string' ? at(row, 8) : null,
    cabinVector: legs.map((l) => l.cabin),
    cabinVectorNames: legs.map((l) => l.cabinName),
  };
}

/** Parse every row in a saved page's HTML. */
export function parseResultsHtml(html) {
  const payload = extractPayload(html);
  if (!payload) {
    return { found: false, reason: 'no ds:1 payload in this page', itineraries: [] };
  }
  const rows = flightRows(payload);
  const itineraries = rows.map(parseRow).filter(Boolean);
  return {
    found: true,
    rowCount: rows.length,
    parsedCount: itineraries.length,
    itineraries,
  };
}

/**
 * Score an itinerary against a requested per-leg cabin vector.
 *
 * @param {object} itinerary  Output of {@link parseRow}.
 * @param {Array<string|number>} vector  Requested cabin per leg, e.g. ['business','economy'].
 * @returns {{match:boolean, exact:boolean, score:number, perLeg:Array}}
 *   `exact` — every leg sits in exactly the requested cabin.
 *   `match`  — every leg sits at or ABOVE its requested cabin (an upgrade is
 *              accepted; a downgrade is not).
 *   `score`  — number of legs that are an exact hit, for ranking.
 */
export function matchCabinVector(itinerary, vector) {
  const wanted = vector.map((v) => (typeof v === 'number' ? v : SEAT[`${String(v).toUpperCase().replace(/-/g, '_')}`] ?? null));
  const legs = itinerary.legs ?? [];
  if (wanted.length !== legs.length) {
    return { match: false, exact: false, score: 0, perLeg: [], reason: 'leg count differs' };
  }
  let exact = true;
  let ok = true;
  let score = 0;
  const perLeg = legs.map((leg, i) => {
    const want = wanted[i];
    const got = leg.cabin;
    const status =
      want == null || got == null ? 'unknown' : got === want ? 'exact' : got > want ? 'upgraded' : 'downgraded';
    if (status === 'exact') score++;
    if (status !== 'exact') exact = false;
    if (status === 'downgraded' || status === 'unknown') ok = false;
    return {
      leg: i,
      route: `${leg.from}→${leg.to}`,
      flight: `${leg.airline ?? ''}${leg.flightNumber ?? ''}`.trim(),
      wanted: want,
      wantedName: want ? SEAT_NAMES[want] : null,
      got,
      gotName: leg.cabinName,
      status,
    };
  });
  return { match: ok && perLeg.length > 0, exact, score, perLeg };
}

/**
 * Filter and rank parsed itineraries by a requested per-leg cabin vector.
 *
 * @param {Array} itineraries
 * @param {Array} vector
 * @param {{allowUpgrades?:boolean, requireMixed?:boolean}} [options]
 */
export function filterByCabinVector(itineraries, vector, { allowUpgrades = true, requireMixed = false } = {}) {
  return itineraries
    .map((it) => ({ itinerary: it, verdict: matchCabinVector(it, vector) }))
    .filter(({ verdict }) => (allowUpgrades ? verdict.match : verdict.exact))
    .filter(({ itinerary }) => !requireMixed || itinerary.mixedCabin)
    .sort((a, b) => {
      const priceA = a.itinerary.price ?? Infinity;
      const priceB = b.itinerary.price ?? Infinity;
      if (priceA !== priceB) return priceA - priceB;
      return b.verdict.score - a.verdict.score;
    });
}
