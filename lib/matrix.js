// Matrix-style itinerary JSON: importing it, and exporting it.
//
// The IMPORT half is ported from Adhambadrun/SpicyLinkGenerator
// `booking-tools.js` (`parseMatrixInput`) unchanged, so an itinerary JSON that
// tool accepts is accepted here too. The only addition is that each parsed
// segment now also keeps its verbatim `departureIso` / `arrivalIso` strings —
// upstream kept the epoch and the wall-clock parts but dropped the offset, and
// the offset is exactly what the export half must not have to re-derive.
//
// The EXPORT half is new, and it deliberately does less than upstream's
// `buildCompleteJson`. That function invents a fare basis, fare construction,
// taxes and a total price for raw GDS text, which upstream's own
// IMPLEMENTATION_BRIEF flags as "not suitable for ticketing or live fare
// validation". This repository has no price data at all — it builds search
// links — so `buildMatrixItinerary` emits the ITINERARY (slices, segments,
// times, carriers, booking codes, per-leg cabins) and no money. An itinerary
// with no price is honest; a plausible-looking price is not.
//
// What "valid" means here, precisely: the document is accepted by this
// repository's Matrix importer (proved by a round-trip test). Acceptance by the
// real BookWithMatrix service is NOT proven — upstream's brief requires a
// documented fixture and an actual acceptance test for that claim, and neither
// exists. `buildMatrixItinerary` therefore reports `roundTrips`, never
// `bookWithMatrixVerified`.

import { airportLocalTimeMs } from './aa-handoff.js';
import { sliceIndex } from './airline-links.js';
import { SEAT, SEAT_NAMES } from './tfs.js';

const code = (value, length) => {
  const s = typeof value === 'string' ? value : value?.code;
  return typeof s === 'string' && new RegExp(`^[A-Z0-9]{${length}}$`).test(s.toUpperCase()) ? s.toUpperCase() : null;
};

const instant = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value)) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
};

/**
 * Parse an itinerary with slices[].segments[] (including this app's existing export).
 * Reject unknown shapes rather than dropping legs or inventing missing times/classes.
 * This does not assert BookWithMatrix compatibility for arbitrary third-party JSON.
 */
export function parseMatrixInput(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected an itinerary JSON object.');
  const slices = data.itinerary?.slices ?? data.slices;
  if (!Array.isArray(slices) || !slices.length) throw new Error('Expected itinerary.slices with at least one slice.');
  const segments = [];
  for (const [sliceIndex_, slice] of slices.entries()) {
    if (!Array.isArray(slice?.segments) || !slice.segments.length) {
      throw new Error(`Slice ${sliceIndex_ + 1} has no segments; no legs were imported.`);
    }
    for (const [segmentIndex, seg] of slice.segments.entries()) {
      const where = `Slice ${sliceIndex_ + 1}, segment ${segmentIndex + 1}`;
      const carrier = code(seg?.carrier ?? seg?.marketingCarrier, 2);
      const op = code(seg?.operatingCarrier, 2) || carrier;
      const num = String(seg?.flight?.number ?? seg?.flightNumber ?? '').trim();
      const origin = code(seg?.origin ?? seg?.departureAirport ?? seg?.legs?.[0]?.origin, 3);
      const dest = code(seg?.destination ?? seg?.arrivalAirport ?? seg?.legs?.at(-1)?.destination, 3);
      const cls = seg?.bookingInfos?.[0]?.bookingCode ?? seg?.bookingCode ?? seg?.rbd;
      const dep = instant(seg?.departure ?? seg?.departureTime ?? seg?.legs?.[0]?.departure);
      const arr = instant(seg?.arrival ?? seg?.arrivalTime ?? seg?.legs?.at(-1)?.arrival);
      if (!carrier || !/^\d{1,4}$/.test(num) || !origin || !dest || !/^[A-Z]$/.test(cls) || !dep || !arr) {
        throw new Error(`${where} is missing a valid carrier, flight, airports, booking class or ISO departure/arrival time.`);
      }
      const depSource = seg.departure ?? seg.departureTime ?? seg.legs?.[0]?.departure;
      const arrSource = seg.arrival ?? seg.arrivalTime ?? seg.legs?.at(-1)?.arrival;
      // Avoid silently assuming the visitor's timezone for airport-local times.
      if (!/(Z|[+-]\d\d:\d\d)$/.test(depSource) || !/(Z|[+-]\d\d:\d\d)$/.test(arrSource)) {
        throw new Error(`${where} needs times with explicit UTC offsets.`);
      }
      if (arr <= dep) throw new Error(`${where} arrives before it departs.`);
      const date = depSource.slice(0, 10);
      const arrDate = arrSource.slice(0, 10);
      const deltaDays = Math.round((Date.parse(`${arrDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
      if (deltaDays > 1) throw new Error(`${where} arrives more than a day later; review the schedule manually.`);
      segments.push({
        carrier, num, origin, dest, cls, op, married: Boolean(seg.married),
        ymd: date, depEpochMs: dep.getTime(), depH: +depSource.slice(11, 13), depM: +depSource.slice(14, 16),
        arrH: +arrSource.slice(11, 13), arrM: +arrSource.slice(14, 16), plus: deltaDays === 1,
        // ADDED by this port: keep the offset-bearing strings, so an imported
        // itinerary can be re-exported without re-deriving a timezone.
        departureIso: depSource, arrivalIso: arrSource,
      });
    }
  }
  if (segments.length > 24) throw new Error('More than 24 segments: review this itinerary manually.');
  return { segments, original: data };
}

/** Friendlier name for the same importer. */
export const parseMatrixItinerary = parseMatrixInput;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** tfs cabin code → the cabin word Matrix uses in `bookingInfos[].cabin`. */
export function matrixCabinWord(cabinCode) {
  return { [SEAT.ECONOMY]: 'COACH', [SEAT.PREMIUM_ECONOMY]: 'PREMIUM_ECONOMY', [SEAT.BUSINESS]: 'BUSINESS', [SEAT.FIRST]: 'FIRST' }[
    cabinCode
  ] ?? null;
}

const pad = (n) => String(n).padStart(2, '0');

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * An ISO-8601 timestamp for a wall-clock time AT AN AIRPORT, carrying the real
 * UTC offset for that airport on that date — daylight saving included.
 *
 * Returns null rather than guessing when the airport has no verified zone
 * mapping, or when the local time is a DST gap or an ambiguous repeated hour.
 * A naive timestamp would be rejected by the importer, and a wrong offset would
 * be accepted and then quietly point at the wrong instant.
 */
export function isoAtAirport(airport, ymd, hour, minute) {
  if (!/^\d{4}-\d\d-\d\d$/.test(ymd || '')) return null;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  const epoch = airportLocalTimeMs(airport, ymd, hour, minute);
  if (epoch === null) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  return `${ymd}T${pad(hour)}:${pad(minute)}:00${formatOffset((wall - epoch) / 60000)}`;
}

const nextDay = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/**
 * What one leg is missing before it can appear in a Matrix itinerary document.
 * Empty array means the leg is complete.
 *
 * Code length is checked before times: `tfs` accepts 2-character city codes
 * (`NYC`, `LON`) but Matrix has no city-code field, so a 2-character code would
 * otherwise surface as a confusing "no timezone" gap.
 */
export function matrixLegGaps(leg) {
  const gaps = [];
  const threeLetter = (value, what) => {
    if (!value || !/^[A-Z0-9]{3}$/.test(value)) gaps.push(`${what} as a 3-letter IATA airport code (Matrix has no city-code field)`);
  };
  threeLetter(leg.from, 'origin');
  threeLetter(leg.to, 'destination');
  if (!leg.carrier) gaps.push('carrier');
  if (!leg.flightNumber) gaps.push('flightNumber');
  if (!leg.bookingClass) gaps.push('bookingClass');
  if (!leg.departureIso) gaps.push('departure time with a known airport timezone');
  if (!leg.arrivalIso) gaps.push('arrival time with a known airport timezone');
  return gaps;
}

/**
 * Build a Matrix-style itinerary document from unified legs.
 *
 * @param {Array<object>} legs  Canonical legs from lib/unified.js.
 * @param {object} [meta]       `{ cabinVector, mixedCabin, passengers }` — recorded in `ext`.
 * @returns {{ok:true, json:object, slices:number, roundTrips:boolean}|{ok:false, reason:string, gaps:Array}}
 */
export function buildMatrixItinerary(legs, meta = {}) {
  if (!Array.isArray(legs) || !legs.length) return { ok: false, reason: 'no legs', gaps: [] };

  // Resolve timestamps first: the verbatim ISO string from an imported Matrix
  // document wins, otherwise derive one from a wall-clock time in a KNOWN zone.
  const resolved = legs.map((leg) => {
    const departureIso = leg.departureIso ?? (leg.depH != null ? isoAtAirport(leg.from, leg.date, leg.depH, leg.depM ?? 0) : null);
    const arrivalDate = leg.arrivesNextDay ? nextDay(leg.date) : leg.arrivalDate ?? leg.date;
    const arrivalIso = leg.arrivalIso ?? (leg.arrH != null ? isoAtAirport(leg.to, arrivalDate, leg.arrH, leg.arrM ?? 0) : null);
    return { leg, departureIso, arrivalIso };
  });

  const gaps = resolved.flatMap(({ leg, departureIso, arrivalIso }, i) =>
    matrixLegGaps({ ...leg, departureIso, arrivalIso }).map((what) => ({ leg: i, route: `${leg.from}→${leg.to}`, needs: what }))
  );
  if (gaps.length) {
    return {
      ok: false,
      reason:
        'A Matrix itinerary document needs a marketing carrier, a flight number, a single-letter booking class and ' +
        'offset-bearing departure/arrival times for every leg. This tool will not invent any of them: a synthesised ' +
        'fare basis or a guessed UTC offset looks valid and is not.',
      gaps,
    };
  }

  // Collapse legs into O&D slices with the SAME rule lib/airline-links.js uses
  // for BA's typed instructions, so the two outputs can never disagree about
  // where one direction ends and the next begins.
  const idx = sliceIndex(legs.map((leg) => ({ origin: leg.from, dest: leg.to, ymd: leg.date, depH: leg.depH, depM: leg.depM, arrH: leg.arrH, arrM: leg.arrM, plus: leg.arrivesNextDay })));

  const slices = [];
  resolved.forEach(({ leg, departureIso, arrivalIso }, i) => {
    const segment = {
      carrier: { code: leg.carrier },
      operatingCarrier: { code: leg.operatingCarrier ?? leg.carrier },
      codeshare: Boolean(leg.operatingCarrier && leg.operatingCarrier !== leg.carrier),
      flight: { number: Number(leg.flightNumber) },
      origin: { code: leg.from },
      destination: { code: leg.to },
      departure: departureIso,
      arrival: arrivalIso,
      // Per-leg cabin lives in the real Matrix field. This is the one place a
      // mixed-cabin itinerary is expressed exactly, leg by leg.
      bookingInfos: [{ bookingCode: leg.bookingClass, cabin: matrixCabinWord(leg.cabin) }],
    };
    if (leg.married) segment.married = true;

    // idx[i] counts up from 0 and never skips, so a value at or beyond the
    // number of slices built so far starts a new one.
    if (idx[i] >= slices.length) {
      slices.push({
        origin: { code: leg.from }, destination: { code: leg.to },
        departure: departureIso, arrival: arrivalIso, segments: [segment], legIndexes: [i],
      });
    } else {
      const slice = slices[slices.length - 1];
      slice.destination = { code: leg.to };
      slice.arrival = arrivalIso;
      slice.segments.push(segment);
      slice.legIndexes.push(i);
    }
  });
  for (const slice of slices) {
    slice.stopCount = slice.segments.length - 1;
    // Derived from the timestamps actually emitted, using the GLOBAL leg index —
    // not from an input `plus` flag that could disagree with them.
    if (slice.legIndexes.some((n) => resolved[n].departureIso.slice(0, 10) !== resolved[n].arrivalIso.slice(0, 10))) {
      slice.ext = { warnings: 'OVERNIGHT' };
    }
    delete slice.legIndexes;
  }

  const ext = {
    generatedBy: 'GOOGLEFLIGHTS unified/v1',
    cabinVector: meta.cabinVector ?? legs.map((l) => SEAT_NAMES[l.cabin]),
    mixedCabin: meta.mixedCabin ?? new Set(legs.map((l) => l.cabin)).size > 1,
    // `ext` is the documented extension point (upstream uses it for totalPrice
    // and for OVERNIGHT warnings), so carrying the cabin vector here does not
    // change any field a Matrix importer reads.
    notes: [
      'Itinerary only. This document carries NO price, fare basis, tax, fare construction or total: this tool builds search links and has no fare data, and inventing a plausible price would be worse than omitting one.',
      'Airport and city NAMES are omitted (only IATA codes are given) because this repository has no airport name database and will not guess one.',
      "Every timestamp carries the real UTC offset for its airport on its date, from a verified IANA zone mapping — never a fixed offset and never the visitor's timezone.",
      'Acceptance by the real BookWithMatrix service is NOT verified. "roundTrips" means this document is accepted by parseMatrixItinerary() in this repository.',
    ],
  };
  if (Number.isInteger(meta.passengerCount)) ext.passengerCount = meta.passengerCount;

  const json = { itinerary: { slices }, ext };
  if (Number.isInteger(meta.passengerCount)) json.passengerCount = meta.passengerCount;

  // Prove the shape by feeding it back through the importer. A document this
  // repository's own importer rejects is never reported as available: emitting
  // it would be exactly the "shaped JSON alone is not proof" trap.
  try {
    const parsed = parseMatrixInput(json).segments;
    if (parsed.length !== legs.length) {
      return { ok: false, reason: `the built document lost legs on re-import (${parsed.length} of ${legs.length} survived)`, gaps: [] };
    }
    return { ok: true, json, slices: slices.length, roundTrips: true };
  } catch (error) {
    return { ok: false, reason: `the built document was rejected by this repository's own Matrix importer: ${error.message}`, gaps: [] };
  }
}
