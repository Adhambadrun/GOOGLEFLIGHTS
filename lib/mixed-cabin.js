// Mixed-cabin, multi-leg search planning.
//
// THE PROBLEM THIS FILE EXISTS FOR
//
// `tfs` carries exactly ONE cabin for the whole search (top-level field 9).
// Google's own UI has exactly one cabin selector too. So there is no single
// token that says "leg 1 in business, leg 2 in economy" — nothing to
// reverse-engineer here, the field simply is not per-leg.
//
// What *is* per-leg is the RESULT: every leg Google returns carries its own
// cabin code (leg[16], same 1..4 numbering), and the row itself carries a
// `mixed_cabin` flag (row[10]). Google prices mixed-cabin itineraries and
// labels them in-row — they are frequently the cheapest hit in a premium
// search. So "search for mixed cabins" is a *matching* problem, not an
// encoding problem.
//
// THE THREE STRATEGIES
//
//   per-leg   One one-way token per leg, each with its own cabin. The only way
//             to REQUEST an exact cabin per leg. Priced as separate one-ways,
//             so it is usually the most expensive answer and yields separate
//             tickets — but it is exact, and it is the only option when no
//             bundled mixed-cabin fare exists.
//
//   board     One multi-city token for the whole trip, opened in the HIGHEST
//             cabin you asked for. Google prices the trip as a bundle and
//             surfaces mixed-cabin itineraries alongside. Cheapest route when
//             a matching itinerary exists.
//
//   matrix    The board once per distinct cabin in your vector, decoded and
//             unioned, then filtered with `matchCabinVector` from
//             lib/results.js. Widest coverage: Google decides which
//             itineraries to surface per search, so more searches find more.
//
// Multi-city has one important operational caveat: Google loads multi-city
// results client-side via the RPC that has been signature-gated since
// 2026-08, so the raw HTML of a multi-city page carries no result rows to
// parse (see PROTOCOL.md). The board link still works perfectly in a browser
// — it is only machine-parsing of the multi-city page that is unavailable.
// The per-leg strategy side-steps this entirely, because one-way pages DO
// inline their rows.

import { buildTfs, normalizeCabin, cabinName, SEAT, TRIP } from './tfs.js';
import { searchUrl } from './tfs.js';

const CABIN_RANK = { [SEAT.ECONOMY]: 0, [SEAT.PREMIUM_ECONOMY]: 1, [SEAT.BUSINESS]: 2, [SEAT.FIRST]: 3 };

/**
 * Plan a mixed-cabin multi-leg search.
 *
 * @param {object} spec
 * @param {Array<{from:string,to:string,date:string,cabin?:string|number}>} spec.legs
 *   One entry per travel direction, each with its OWN cabin. That per-leg
 *   cabin is the whole point.
 * @param {object} [spec.passengers]   Traveller mix.
 * @param {number} [spec.maxStops]     Applied to every leg (zero-based).
 * @param {string[]} [spec.carriers]   Applied to every leg.
 * @param {string} [spec.currency]     e.g. 'USD'.
 * @param {string} [spec.language]     e.g. 'en'.
 * @param {string} [spec.country]      e.g. 'US' (the `gl` parameter).
 * @param {Array<'per-leg'|'board'|'matrix'>} [spec.strategies] Which to build.
 */
export function planMixedCabin(spec) {
  const legs = (spec.legs ?? []).map((leg, index) => {
    if (!leg || typeof leg !== 'object') throw new TypeError(`leg ${index} must be an object`);
    return {
      index,
      from: String(leg.from ?? '').trim().toUpperCase(),
      to: String(leg.to ?? '').trim().toUpperCase(),
      date: leg.date,
      cabin: normalizeCabin(leg.cabin),
    };
  });
  if (!legs.length) throw new RangeError('at least one leg is required');

  const locale = {
    hl: spec.language ?? 'en',
    gl: spec.country ?? 'US',
    curr: spec.currency,
  };
  const common = {
    passengers: spec.passengers,
    currency: spec.currency,
  };
  const shared = {};
  if (spec.maxStops !== undefined) shared.maxStops = spec.maxStops;
  if (spec.carriers) shared.carriers = spec.carriers;

  const wanted = spec.strategies ?? ['per-leg', 'board', 'matrix'];
  const cabinVector = legs.map((l) => cabinName(l.cabin));
  const isMixed = new Set(legs.map((l) => l.cabin)).size > 1;
  const highest = legs.reduce((a, b) => (CABIN_RANK[b.cabin] > CABIN_RANK[a.cabin] ? b : a));

  const out = {
    cabinVector,
    isMixed,
    legs: legs.map((l) => ({ ...l, cabinName: cabinName(l.cabin) })),
    strategies: {},
    warnings: [],
  };

  // --- A. per-leg: one one-way token per leg, each in its own cabin ---------
  if (wanted.includes('per-leg')) {
    out.strategies['per-leg'] = {
      label: 'Per-leg one-way (exact cabin control)',
      why: 'The only request that pins a different cabin to each leg: one one-way search per leg, each carrying its own seat field.',
      searches: legs.map((leg) => {
        const tfs = buildTfs({
          segments: [{ date: leg.date, from: leg.from, to: leg.to, ...shared }],
          trip: TRIP.ONE_WAY,
          seat: leg.cabin,
          passengers: common.passengers,
        });
        return {
          legIndex: leg.index,
          route: `${leg.from}→${leg.to}`,
          date: leg.date,
          cabin: cabinName(leg.cabin),
          tfs,
          url: searchUrl(tfs, locale),
        };
      }),
      caveats: [
        'Priced as independent one-way fares — on many routes that is materially more than a bundled multi-city price.',
        'Separate tickets: no through-checked bags and no protection if one leg is delayed.',
      ],
    };
  }

  // --- B. board: one multi-city token in the highest requested cabin --------
  if (wanted.includes('board')) {
    const tfs = buildTfs({
      segments: legs.map((leg) => ({ date: leg.date, from: leg.from, to: leg.to, ...shared })),
      trip: TRIP.MULTI_CITY,
      seat: highest.cabin,
      passengers: common.passengers,
    });
    out.strategies.board = {
      label: 'Multi-city board (bundled pricing)',
      why: 'One bundled search for the whole trip. Google prices the trip as a package and labels mixed-cabin itineraries in-row.',
      openInCabin: cabinName(highest.cabin),
      tfs,
      url: searchUrl(tfs, locale),
      caveats: [
        `tfs carries one cabin for the whole search, so this board opens in ${cabinName(highest.cabin)} — the highest cabin you asked for.`,
        'The multi-city page loads rows client-side, so its HTML carries nothing to parse. Open this one in a browser; use the per-leg strategy for machine-parsable results.',
      ],
    };
    if (isMixed) {
      out.warnings.push(
        `Mixed cabin requested (${cabinVector.join(' + ')}). The board opens in ${cabinName(
          highest.cabin
        )} — read each result's per-leg cabins and match them with matchCabinVector().`
      );
    }
  }

  // --- C. matrix: the board once per distinct cabin, then filter ------------
  if (wanted.includes('matrix')) {
    const tiers = [...new Set(legs.map((l) => l.cabin))].sort((a, b) => a - b);
    out.strategies.matrix = {
      label: 'Board sweep + per-leg cabin match',
      why: 'Run the board once per distinct cabin in your vector and union the results, then keep itineraries whose per-leg cabins match. Google surfaces different itineraries per search, so sweeping finds more.',
      searches: tiers.map((cabin) => {
        const tfs = buildTfs({
          segments: legs.map((leg) => ({ date: leg.date, from: leg.from, to: leg.to, ...shared })),
          trip: TRIP.MULTI_CITY,
          seat: cabin,
          passengers: common.passengers,
        });
        return { cabin: cabinName(cabin), tfs, url: searchUrl(tfs, locale) };
      }),
      matchWith: 'matchCabinVector(itinerary, cabinVector) from lib/results.js',
      caveats: ['Same client-side-loading caveat as the board — sweep results in a browser, or sweep per-leg pages instead.'],
    };
  }

  if (isMixed) {
    out.warnings.push(
      'Per-leg pricing and bundled multi-city pricing differ a lot on identical legs (a sampled JFK–LHR–CAI trip came back $1,107 bundled vs $1,484 as two one-ways). Build both and compare before booking.'
    );
  }
  if (legs.length === 1) {
    out.warnings.push('One leg only — there is nothing to mix. Every strategy collapses to the same single one-way search.');
  }

  return out;
}

/**
 * Order cabins by rank — used to report the "highest" cabin and to sort
 * candidate itineraries.
 */
export function cabinRank(code) {
  return CABIN_RANK[code] ?? -1;
}
