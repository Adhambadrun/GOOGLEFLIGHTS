// The unified itinerary: one input, four outputs.
//
// This module is the join between two repositories that answered two halves of
// the same question:
//
//   GOOGLEFLIGHTS         how to *search* a trip where each leg has its own cabin
//                         (tfs tokens, the per-leg / board strategies, the matcher)
//   SpicyLinkGenerator    how to *hand that trip to a carrier* (AA metasearch,
//                         BA's blocked handoff, a 66-carrier directory, Matrix JSON)
//
// Neither half is complete alone. Google Flights can express "business then
// economy" but cannot book it; a carrier link can book but has one cabin
// selector for the whole trip and, for most carriers, no verifiable prefill at
// all. So `buildUnifiedItinerary` takes ONE itinerary description and returns
// all four things you can do with it, each labelled with what it honours and
// what it cannot express.
//
//   1. perLeg        one one-way Google Flights search per leg, each in its own
//                    cabin. The only output that pins a distinct cabin per leg.
//   2. board         one multi-city Google Flights search, opened in the highest
//                    requested cabin. Bundled pricing, no per-leg request.
//   3. airlineLinks  the carrier's own surface: AA metasearch, BA's empty search
//                    form, unverified prefills for DL/UA, homepages elsewhere.
//   4. matrixJson    a Matrix-style itinerary document carrying the per-leg
//                    cabin in the real field and the cabin vector in `ext`.
//
// RULE THIS FILE FOLLOWS: an output that cannot be built honestly is reported
// as unavailable with the reason and the list of what is missing. Nothing is
// fabricated — no invented booking class, no guessed UTC offset, no plausible
// price, no airline host derived from itinerary text. A missing field is a gap
// in the input; a made-up field is a lie in the output.

import { cabinName, normalizeCabin, SEAT } from './tfs.js';
import { planMixedCabin } from './mixed-cabin.js';
import { airlineOption, itineraryAirlines, resolveAirlineLink, itinerarySearchCabin, segmentCabin, gfSearchGroup } from './airline-links.js';
import { buildMatrixItinerary, parseMatrixItinerary } from './matrix.js';

export const UNIFIED_SCHEMA = 'unified/v1';

const SURFACE_TO_SEAT = { COACH: SEAT.ECONOMY, 'PREMIUM-COACH': SEAT.PREMIUM_ECONOMY, BUSINESS: SEAT.BUSINESS, FIRST: SEAT.FIRST };

const HAS_OFFSET = /(Z|[+-]\d\d:\d\d)$/;
const pick = (obj, keys) => {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Passengers
// ---------------------------------------------------------------------------

/**
 * Normalise a passenger mix written in EITHER repository's vocabulary.
 *
 * GOOGLEFLIGHTS says `{adults, children, infantsOnLap, infantsInSeat}`;
 * SpicyLinkGenerator says `{adults, seniors, youths, children, infantsInSeat,
 * infantsInLap}` and requires all six keys to be integers before it will build
 * an AA link. Both shapes are accepted, and both are returned, so each consumer
 * gets the object it validates against.
 *
 * `tfs` field 8 has only four passenger codes — adult, child, infant-on-lap,
 * infant-in-seat. There is no senior and no youth. So seniors and youths are
 * folded into `google.adults`, which is exactly what SpicyLinkGenerator's own
 * `counts()` does for its carrier links. The fold is reported, not hidden.
 */
export function normalizePassengers(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const int = (value, name) => {
    if (value === undefined || value === null || value === '') return 0;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
    return value;
  };
  const adults = int(pick(p, ['adults', 'adult']), 'adults');
  const seniors = int(pick(p, ['seniors', 'senior']), 'seniors');
  const youths = int(pick(p, ['youths', 'youth']), 'youths');
  const children = int(pick(p, ['children', 'child']), 'children');
  const infantsInSeat = int(pick(p, ['infantsInSeat', 'infants_in_seat']), 'infantsInSeat');
  const infantsOnLap = int(pick(p, ['infantsOnLap', 'infants_on_lap', 'infantsInLap', 'infants_in_lap']), 'infantsOnLap');

  const specified = adults + seniors + youths + children + infantsInSeat + infantsOnLap;
  // Google's booking and search pages need at least one traveller, so an empty
  // mix means one adult rather than zero passengers.
  const baseAdults = specified === 0 ? 1 : adults;

  return {
    /** SpicyLinkGenerator's six-key shape — what the AA handoff validates. */
    spicy: { adults: baseAdults, seniors, youths, children, infantsInSeat, infantsInLap: infantsOnLap },
    /** GOOGLEFLIGHTS' shape, with seniors/youths folded into adults (tfs has no code for them). */
    google: { adults: baseAdults + seniors + youths, children, infantsInSeat, infantsOnLap },
    foldedSeniorOrYouth: seniors + youths,
    total: baseAdults + seniors + youths + children + infantsInSeat + infantsOnLap,
  };
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

/**
 * Turn one leg, written in either repository's vocabulary, into the canonical
 * shape every output below is built from.
 */
function normalizeLeg(input, index, warnings) {
  if (!input || typeof input !== 'object') throw new TypeError(`leg ${index} must be an object`);

  const from = String(pick(input, ['from', 'origin', 'departureAirport']) ?? '').trim().toUpperCase();
  const to = String(pick(input, ['to', 'dest', 'destination', 'arrivalAirport']) ?? '').trim().toUpperCase();

  // A timestamp with an explicit offset is kept verbatim: it is the only form
  // the Matrix importer accepts, and re-deriving its offset would need a
  // timezone this repository may not have.
  const departureIsoRaw = pick(input, ['departure', 'departureTime']);
  const arrivalIsoRaw = pick(input, ['arrival', 'arrivalTime']);
  const departureIso = typeof departureIsoRaw === 'string' && HAS_OFFSET.test(departureIsoRaw) ? departureIsoRaw : undefined;
  const arrivalIso = typeof arrivalIsoRaw === 'string' && HAS_OFFSET.test(arrivalIsoRaw) ? arrivalIsoRaw : undefined;

  const explicitDate = pick(input, ['date', 'ymd', 'departureDate']);
  const date = explicitDate !== undefined ? String(explicitDate) : (departureIso ? departureIso.slice(0, 10) : undefined);
  if (explicitDate !== undefined && departureIso && departureIso.slice(0, 10) !== String(explicitDate)) {
    warnings.push(
      `Leg ${index} (${from}→${to}): the date ${explicitDate} and the timestamp ${departureIso} disagree. The Google tokens use the date; the airline and Matrix outputs use the timestamp.`
    );
  }

  const carrierRaw = pick(input, ['carrier', 'marketingCarrier', 'airline']);
  const carrier = typeof carrierRaw === 'string' && /^[A-Z0-9]{2}$/i.test(carrierRaw.trim()) ? carrierRaw.trim().toUpperCase() : undefined;
  const operatingRaw = pick(input, ['operatingCarrier', 'op']);
  const operatingCarrier = typeof operatingRaw === 'string' && /^[A-Z0-9]{2}$/i.test(operatingRaw.trim()) ? operatingRaw.trim().toUpperCase() : undefined;

  const numberRaw = pick(input, ['flightNumber', 'num']) ?? input.flight?.number;
  const flightNumber = numberRaw !== undefined && /^\d{1,4}$/.test(String(numberRaw).trim()) ? String(numberRaw).trim() : undefined;

  const classRaw = pick(input, ['bookingClass', 'cls', 'rbd', 'bookingCode']) ?? input.bookingInfos?.[0]?.bookingCode;
  const bookingClass = typeof classRaw === 'string' && /^[A-Za-z]$/.test(classRaw.trim()) ? classRaw.trim().toUpperCase() : undefined;

  // Cabin precedence: an explicit per-leg cabin beats the RBD letter, because
  // per-leg cabin control is the reason this tool exists. The RBD is used only
  // when no cabin was asked for.
  const cabinRaw = pick(input, ['cabin', 'seat', 'cabinName']);
  let cabin;
  let cabinSource;
  if (cabinRaw !== undefined) {
    cabin = normalizeCabin(cabinRaw);
    cabinSource = 'requested';
  } else if (bookingClass) {
    cabin = SURFACE_TO_SEAT[segmentCabin(carrier, bookingClass)] ?? SEAT.ECONOMY;
    cabinSource = 'booking-class';
  } else {
    cabin = SEAT.ECONOMY;
    cabinSource = 'default';
  }

  const hourMinute = (iso, hKey, mKey) => {
    if (iso) return { hour: Number(iso.slice(11, 13)), minute: Number(iso.slice(14, 16)) };
    const hour = pick(input, [hKey]);
    const minute = pick(input, [mKey]);
    if (hour === undefined) return {};
    return { hour: Number(hour), minute: minute === undefined ? 0 : Number(minute) };
  };
  const dep = hourMinute(departureIso, 'depH', 'depM');
  const arr = hourMinute(arrivalIso, 'arrH', 'arrM');

  const explicitPlus = pick(input, ['arrivesNextDay', 'plus']);
  const arrivalDate = arrivalIso ? arrivalIso.slice(0, 10) : undefined;
  const arrivesNextDay =
    explicitPlus !== undefined ? Boolean(explicitPlus) : Boolean(arrivalDate && date && arrivalDate !== date);

  return {
    index,
    from,
    to,
    date,
    cabin,
    cabinName: cabinName(cabin),
    cabinSource,
    carrier,
    operatingCarrier,
    flightNumber,
    bookingClass,
    married: Boolean(input.married),
    depH: dep.hour,
    depM: dep.minute,
    arrH: arr.hour,
    arrM: arr.minute,
    arrivesNextDay,
    departureIso,
    arrivalIso,
    depEpochMs: departureIso ? Date.parse(departureIso) : undefined,
  };
}

/**
 * Accept an itinerary in any of three shapes:
 *
 *   `{ legs: [{from, to, date, cabin}] }`                 GOOGLEFLIGHTS
 *   `{ segments: [{origin, dest, ymd, carrier, num, cls}] }`  SpicyLinkGenerator / GDS
 *   `{ itinerary: { slices: [{segments: […]}] } }`        Matrix-style JSON
 */
export function normalizeItinerary(spec = {}) {
  const warnings = [];
  const source = Array.isArray(spec.legs)
    ? 'legs'
    : Array.isArray(spec.segments)
      ? 'segments'
      : spec.itinerary?.slices || spec.slices || spec.matrix
        ? 'matrix'
        : null;
  if (!source) {
    throw new RangeError(
      'an itinerary is required: pass legs[] (from/to/date/cabin), segments[] (origin/dest/ymd/carrier/num/cls) or a Matrix-style itinerary document'
    );
  }

  let legs;
  if (source === 'matrix') {
    // The importer is strict on purpose: it rejects naive timestamps, missing
    // booking classes and legs that arrive before they depart.
    const parsed = parseMatrixItinerary(spec.matrix ?? spec);
    legs = parsed.segments.map((s, i) =>
      normalizeLeg(
        {
          origin: s.origin, dest: s.dest, ymd: s.ymd, carrier: s.carrier, operatingCarrier: s.op,
          num: s.num, cls: s.cls, depH: s.depH, depM: s.depM, arrH: s.arrH, arrM: s.arrM,
          plus: s.plus, married: s.married, departure: s.departureIso, arrival: s.arrivalIso,
        },
        i,
        warnings
      )
    );
  } else {
    legs = (source === 'legs' ? spec.legs : spec.segments).map((leg, i) => normalizeLeg(leg, i, warnings));
  }
  if (!legs.length) throw new RangeError('at least one leg is required');

  return { legs, source, warnings };
}

/** The SpicyLinkGenerator segment shape, for the carrier-link and BA slice logic. */
export function toAirlineSegment(leg) {
  const seg = {
    origin: leg.from,
    dest: leg.to,
    ymd: leg.date,
    carrier: leg.carrier,
    num: leg.flightNumber,
    cls: leg.bookingClass,
    op: leg.operatingCarrier ?? leg.carrier,
    married: leg.married,
    depH: leg.depH,
    depM: leg.depM ?? 0,
    arrH: leg.arrH,
    arrM: leg.arrM ?? 0,
    plus: Boolean(leg.arrivesNextDay),
    // Carried so the requested per-leg cabin wins over the RBD letter.
    cabinName: leg.cabinName,
  };
  if (Number.isSafeInteger(leg.depEpochMs)) seg.depEpochMs = leg.depEpochMs;
  return seg;
}

// ---------------------------------------------------------------------------
// The unified output
// ---------------------------------------------------------------------------

/**
 * @param {object} spec
 * @param {Array}  [spec.legs]      GOOGLEFLIGHTS legs: `{from, to, date, cabin}`.
 * @param {Array}  [spec.segments]  SpicyLinkGenerator segments / GDS rows.
 * @param {object} [spec.itinerary] A Matrix-style document to import instead.
 * @param {object} [spec.passengers] Either vocabulary.
 * @param {string} [spec.carrier]   The carrier to resolve ONE airline link for.
 * @param {number} [spec.maxStops]  Applied to every Google leg (zero-based).
 * @param {string[]} [spec.carriers] Carrier filter applied to every Google leg.
 * @param {string} [spec.currency] [spec.language] [spec.country]
 */
export function buildUnifiedItinerary(spec = {}) {
  const { legs, source, warnings } = normalizeItinerary(spec);
  const passengers = normalizePassengers(spec.passengers);
  if (passengers.foldedSeniorOrYouth > 0) {
    warnings.push(
      `${passengers.foldedSeniorOrYouth} senior/youth traveller(s) were folded into adults for the Google Flights tokens: tfs field 8 has only adult, child, infant-on-lap and infant-in-seat. The airline links keep them separate.`
    );
  }

  const cabinVector = legs.map((l) => l.cabinName);
  const mixedCabin = new Set(legs.map((l) => l.cabin)).size > 1;
  const locale = { hl: spec.language ?? 'en', gl: spec.country ?? 'US', curr: spec.currency };

  // Google's own planner builds the tokens, so /api/links and /api/plan cannot
  // drift apart: the same legs produce byte-identical tfs from either endpoint.
  const plan = planMixedCabin({
    legs: legs.map((l) => ({ from: l.from, to: l.to, date: l.date, cabin: l.cabin })),
    passengers: passengers.google,
    maxStops: spec.maxStops,
    carriers: spec.carriers,
    currency: spec.currency,
    language: spec.language,
    country: spec.country,
    strategies: ['per-leg', 'board', 'matrix'],
  });
  warnings.push(...plan.warnings);

  const strategies = {
    perLeg: perLegStrategy(plan, legs),
    board: boardStrategy(plan, legs),
    airlineLinks: airlineLinkStrategy(legs, passengers, spec.carrier, warnings),
    matrixJson: matrixStrategy(legs, cabinVector, mixedCabin, passengers),
  };

  return {
    schema: UNIFIED_SCHEMA,
    inputShape: source,
    legs: legs.map((l) => ({
      index: l.index, from: l.from, to: l.to, date: l.date,
      cabin: l.cabin, cabinName: l.cabinName, cabinSource: l.cabinSource,
      carrier: l.carrier ?? null, flightNumber: l.flightNumber ?? null,
      bookingClass: l.bookingClass ?? null,
    })),
    cabinVector,
    mixedCabin,
    highestCabin: plan.strategies.board?.openInCabin ?? cabinVector[0],
    passengers,
    strategies,
    warnings,
    verification: {
      googleTokens: 'Byte-exact against 34 captured tfs goldens (test/goldens.js). NOT confirmed against live google.com from this sandbox.',
      airlineLinks: 'AA metasearch and BA search-form URLs are built offline. No carrier site was reached from this sandbox; every airline URL is unverified until opened in a browser.',
      baHandoff: 'BLOCKED and never emitted — BA processOffer hung forever in recorded real-browser runs (2026-10-12). See lib/airline-links.js.',
      matrixJson: 'Shape is accepted by this repository\'s Matrix importer (round-trip tested). Acceptance by the real BookWithMatrix service is NOT proven, and no price is included.',
      network: 'Building this payload makes zero network requests.',
    },
  };
}

function perLegStrategy(plan, legs) {
  const built = plan.strategies['per-leg'];
  return {
    available: true,
    label: 'Per-leg one-way Google Flights links',
    why: 'One one-way search per leg, each carrying its own seat field. This is the only request that pins a distinct cabin to each leg.',
    honours: "Each leg's own cabin",
    cannotFeature: 'Bundled pricing',
    searches: built.searches.map((s, i) => ({ ...s, carrier: legs[i].carrier ?? null, flightNumber: legs[i].flightNumber ?? null })),
    caveats: [
      ...built.caveats,
      'Open each link separately and price the legs independently — the sum is usually more than the bundled board fare, and sometimes less. There is no rule; you have to look.',
    ],
  };
}

function boardStrategy(plan, legs) {
  const built = plan.strategies.board;
  const sweep = plan.strategies.matrix?.searches ?? [];
  return {
    available: true,
    label: 'Multi-city board Google Flights link',
    why: 'One bundled search for the whole trip. Google prices the trip as a package and labels mixed-cabin itineraries in-row.',
    honours: 'Highest cabin only',
    cannotFeature: 'Per-leg detail',
    openInCabin: built.openInCabin,
    tfs: built.tfs,
    url: built.url,
    // The board sweep: the same multi-city search once per distinct cabin, so
    // results can be unioned and matched leg by leg with matchCabinVector().
    sweep: sweep.map((s) => ({ cabin: s.cabin, tfs: s.tfs, url: s.url })),
    matchWith: 'matchCabinVector(itinerary, cabinVector) from lib/results.js',
    legsIncluded: legs.length,
    caveats: built.caveats,
  };
}

function airlineLinkStrategy(legs, passengers, selectedCarrier, warnings) {
  const segments = legs.map(toAirlineSegment);
  const carriers = itineraryAirlines(segments);
  const base = {
    label: 'Airline-specific links',
    why: "Each marketing carrier's own website, handed the whole itinerary where that is possible and described in words where it is not.",
    honours: 'Known carrier surface',
    cannotFeature: 'Pre-filled fare',
    searchCabin: itinerarySearchCabin(segments),
    // The two repositories pick the single cabin differently, and both rules
    // are reported rather than one being silently rewritten.
    cabinPolicy: {
      board: 'HIGHEST requested cabin (GOOGLEFLIGHTS) — never downgrades a leg you asked to fly premium.',
      airlineSurface: 'MOST COMMON cabin, ties to the higher one (SpicyLinkGenerator) — the class the majority of legs were sold in.',
      note: 'These disagree whenever the itinerary mixes cabins unevenly (e.g. business + economy + economy: highest says business, most-common says economy). Both values are in this payload; nothing picks for you.',
    },
    carriers: [],
    selected: null,
    gaps: [],
    caveats: [
      'A carrier link is a search handoff, never a cart, a held seat or a fare. No passenger name, passport or payment detail is ever placed in a URL.',
      'The 66-carrier directory lists candidate public homepages that were NOT live-checked from this sandbox; redirects and ownership change.',
      'Airline logos from the source repository were not ported, so logoUrl is always null here.',
    ],
  };

  if (!carriers.length) {
    base.available = false;
    base.reason =
      'No marketing carrier on any leg, so there is no airline to hand this itinerary to. Add `carrier` (and `flightNumber`, `bookingClass`, departure/arrival times) per leg to enable carrier links — this tool will not guess a carrier from a route.';
    base.gaps = legs.map((l) => ({ leg: l.index, route: `${l.from}→${l.to}`, needs: 'carrier' }));
    return base;
  }

  base.available = true;
  // resolveAirlineLink() returns the link but not which carrier it belongs to,
  // so the directory entry is merged in — callers need `carrier` to pick one.
  base.carriers = carriers.map((option) => ({
    carrier: option.carrier,
    name: option.name,
    level: option.level,
    ...resolveAirlineLink(segments, option.carrier, passengers.spicy),
  }));
  if (selectedCarrier) {
    const key = String(selectedCarrier).trim().toUpperCase();
    const option = airlineOption(key);
    base.selected =
      base.carriers.find((c) => c.carrier === key) ??
      { carrier: option.carrier, name: option.name, level: option.level, ...resolveAirlineLink(segments, key, passengers.spicy) };
  } else if (base.carriers.length === 1) {
    base.selected = base.carriers[0];
  }

  // Report what each carrier link could not carry, so a homepage fallback is
  // never mistaken for a working prefill.
  for (const leg of legs) {
    const needs = [];
    if (!leg.carrier) needs.push('carrier');
    if (!leg.flightNumber) needs.push('flightNumber');
    if (!leg.bookingClass) needs.push('bookingClass');
    if (leg.depH === undefined) needs.push('departure time');
    if (needs.length) base.gaps.push({ leg: leg.index, route: `${leg.from}→${leg.to}`, needs });
  }
  if (base.gaps.length) {
    warnings.push(
      `${base.gaps.length} leg(s) are missing carrier/flight/booking-class/time detail, so some carrier links degrade to a homepage or to an unverified prefill. Nothing was invented to fill the gap.`
    );
  }

  const gfAlternative = gfSearchGroup(segments);
  if (gfAlternative) base.thirdPartySearch = { cabin: gfAlternative.cabin, slices: gfAlternative.slices };

  const ba = base.carriers.find((c) => c.carrier === 'BA');
  if (ba) {
    base.caveats.push(
      'BA gets an EMPTY search form with the itinerary spelled out in the note: its offer-search handoff is recorded BLOCKED (it hangs forever on "calculating your price") and its form ignores every prefill parameter probed.'
    );
  }
  return base;
}

function matrixStrategy(legs, cabinVector, mixedCabin, passengers) {
  const built = buildMatrixItinerary(legs, {
    cabinVector,
    mixedCabin,
    // Same headcount upstream reports: every traveller, lap infants included.
    passengerCount: passengers.total,
  });
  const base = {
    label: 'BookWithMatrix-shaped itinerary JSON',
    why: 'A Matrix-style itinerary document: the per-leg cabin sits in the real bookingInfos[].cabin field, and the cabin vector plus the mixed flag ride along in ext.',
    honours: 'Cabin vector + mixed flag',
    cannotFeature: 'Live pricing',
    caveats: [
      'Itinerary only — no price, fare basis, tax or fare construction. This tool has no fare data and will not synthesise any.',
      'Airport and city names are omitted (IATA codes only); this repository has no airport name database.',
      'Timestamps carry real, DST-correct UTC offsets for the airports in the verified zone map (ZONES in lib/aa-handoff.js), and refuse to be built for any other airport rather than guess an offset.',
      'Airports must be 3-letter IATA codes. tfs accepts 2-character city codes (NYC, LON) and Matrix has no city-code field, so such a leg still gets its Google links and no Matrix document.',
      '"roundTrips" means the document is accepted by parseMatrixItinerary() here. It is NOT evidence that the real BookWithMatrix service accepts it.',
    ],
  };
  if (!built.ok) return { ...base, available: false, reason: built.reason, gaps: built.gaps ?? [] };
  return { ...base, available: true, json: built.json, slices: built.slices, roundTrips: built.roundTrips };
}
