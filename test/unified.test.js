// The unified itinerary: one input, four outputs.
//
// These tests are the join between GOOGLEFLIGHTS and SpicyLinkGenerator. They
// check three things, in this order of importance:
//
//   1. FIDELITY. The ported carrier logic still produces the links upstream
//      produced. The AA metasearch URL is pinned by the same sha256 golden
//      upstream pins, so a behavioural drift in lib/aa-handoff.js or
//      lib/airline-links.js fails here rather than shipping a different link.
//   2. HONESTY. An output that cannot be built is reported unavailable with the
//      reason and the missing fields. No invented booking class, no guessed UTC
//      offset, no synthesised price, no fabricated carrier.
//   3. AGREEMENT. /api/links and /api/plan build their Google tokens through the
//      same planner, so the two endpoints cannot drift apart.
//
// All offline. Nothing here touches the network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { buildUnifiedItinerary, normalizePassengers } from '../lib/unified.js';
import { BA_SEARCH_FORM_URL, buildBAProcessOfferUrl } from '../lib/airline-links.js';
import { parseMatrixItinerary } from '../lib/matrix.js';
import { decodeTfs, SEAT, TRIP } from '../lib/tfs.js';
import { planMixedCabin } from '../lib/mixed-cabin.js';
import handler, { buildLinks } from '../api/links.js';

// GOOGLEFLIGHTS vocabulary: airports, dates, per-leg cabins. Nothing else.
const GF_LEGS = [
  { from: 'JFK', to: 'LHR', date: '2026-12-01', cabin: 'business' },
  { from: 'LHR', to: 'CAI', date: '2026-12-08', cabin: 'economy' },
];

// SpicyLinkGenerator vocabulary: carrier, flight number, booking class, times.
const SPICY_SEGMENTS = [
  { origin: 'JFK', dest: 'LHR', ymd: '2026-12-01', carrier: 'AA', num: '100', cls: 'J', depH: 19, depM: 0, arrH: 7, arrM: 0, plus: true },
  { origin: 'LHR', dest: 'JFK', ymd: '2026-12-08', carrier: 'AA', num: '101', cls: 'Y', depH: 11, depM: 30, arrH: 14, arrM: 35, plus: false },
];

const baLeg = (origin, dest, ymd, carrier = 'BA', cls = 'J') => ({ origin, dest, ymd, carrier, num: '323', cls, depH: 7, depM: 5, arrH: 7, arrM: 35 });

describe('unified itinerary: input', () => {
  test('accepts the GOOGLEFLIGHTS leg shape and reports the requested cabin vector', () => {
    const out = buildUnifiedItinerary({ legs: GF_LEGS });
    assert.equal(out.schema, 'unified/v1');
    assert.equal(out.inputShape, 'legs');
    assert.deepEqual(out.cabinVector, ['business', 'economy']);
    assert.equal(out.mixedCabin, true, 'two different cabins means the trip mixes');
    assert.equal(out.legs[0].cabinSource, 'requested');
    assert.equal(out.highestCabin, 'business');
  });

  test('accepts the SpicyLinkGenerator segment shape and reads a cabin out of the booking class', () => {
    const out = buildUnifiedItinerary({ segments: SPICY_SEGMENTS });
    assert.equal(out.inputShape, 'segments');
    // J is a business booking class on AA, Y is economy — no cabin was asked for.
    assert.deepEqual(out.cabinVector, ['business', 'economy']);
    assert.equal(out.legs[0].cabinSource, 'booking-class');
    assert.equal(out.mixedCabin, true);
    // A requested cabin still beats the RBD letter: per-leg cabin control is the point.
    const requested = buildUnifiedItinerary({ segments: [{ ...SPICY_SEGMENTS[0], cls: 'Y', cabin: 'business' }] });
    assert.equal(requested.legs[0].cabinName, 'business');
    assert.equal(requested.legs[0].cabinSource, 'requested');
  });
});

describe('unified itinerary: the two Google Flights outputs', () => {
  test('per-leg pins a different cabin to each leg — the only exact request', () => {
    const { perLeg } = buildUnifiedItinerary({ legs: GF_LEGS }).strategies;
    assert.equal(perLeg.available, true);
    assert.equal(perLeg.honours, "Each leg's own cabin");
    assert.equal(perLeg.cannotFeature, 'Bundled pricing');
    assert.equal(perLeg.searches.length, 2);
    const [first, second] = perLeg.searches.map((s) => decodeTfs(s.tfs));
    assert.equal(first.seat, SEAT.BUSINESS);
    assert.equal(second.seat, SEAT.ECONOMY);
    assert.equal(first.trip, TRIP.ONE_WAY, 'each leg is its own one-way search');
    assert.deepEqual(first.segments[0].from, ['JFK']);
    assert.deepEqual(second.segments[0].to, ['CAI']);
  });

  test('board is one multi-city token in the highest cabin, and cannot drift from /api/plan', () => {
    const out = buildUnifiedItinerary({ legs: GF_LEGS });
    const { board } = out.strategies;
    assert.equal(board.honours, 'Highest cabin only');
    assert.equal(board.cannotFeature, 'Per-leg detail');
    const decoded = decodeTfs(board.tfs);
    assert.equal(decoded.trip, TRIP.MULTI_CITY);
    assert.equal(decoded.seat, SEAT.BUSINESS, 'business > economy, so the board opens in business');
    assert.equal(decoded.segments.length, 2);
    assert.equal(board.openInCabin, 'business');

    // Both endpoints build tokens through planMixedCabin, so the bytes must agree.
    const plan = planMixedCabin({ legs: GF_LEGS });
    assert.equal(board.tfs, plan.strategies.board.tfs);
    assert.deepEqual(
      out.strategies.perLeg.searches.map((s) => s.tfs),
      plan.strategies['per-leg'].searches.map((s) => s.tfs)
    );
    // The sweep is the board once per distinct cabin, lowest first.
    assert.deepEqual(board.sweep.map((s) => s.cabin), ['economy', 'business']);
  });
});

describe('unified itinerary: airline links', () => {
  test('AA metasearch survives the port byte for byte — upstream golden checksum', () => {
    const out = buildUnifiedItinerary({
      segments: [{ origin: 'JFK', dest: 'LAX', ymd: '2026-11-12', carrier: 'AA', num: '123', cls: 'K', depH: 15, depM: 45 }],
    });
    const aa = out.strategies.airlineLinks.carriers[0];
    assert.equal(aa.kind, 'aa_handoff');
    assert.equal(new URL(aa.url).hostname, 'www.aa.com');
    // The checksum SpicyLinkGenerator's own suite pins for this exact itinerary.
    assert.equal(createHash('sha256').update(aa.url).digest('hex'), '76249debd11fd0238540fb99ebcb73754c2fa9a519a53f27a1acabca1cfbb268');
    assert.match(aa.note, /no live fare is verified/);
    assert.doesNotMatch(aa.url, /passport|firstName|lastName|payment|price=/i);
  });

  test('BA never emits the recorded-BLOCKED handoff, only its empty search form', () => {
    const out = buildUnifiedItinerary({ segments: [baLeg('CDG', 'LHR', '2026-10-30'), baLeg('LHR', 'CDG', '2026-11-06')] });
    const ba = out.strategies.airlineLinks.carriers[0];
    assert.equal(ba.carrier, 'BA');
    assert.equal(ba.kind, 'search_unverified');
    assert.equal(ba.url, BA_SEARCH_FORM_URL);
    assert.equal(ba.manualEntry, true, 'the form opens empty, so the note has to say what to type');
    // The requested cabin reaches the typed instructions even with no booking class.
    assert.match(ba.manualEntryHint, /business, 1 adult/);
    assert.match(ba.note, /calculating your price/);
    assert.match(ba.note, /opens EMPTY/);
    assert.match(ba.note, /No flight is selected and no fare is shown or claimed/);
    assert.doesNotMatch(ba.url, /processOffer|search-journey-id|[?&]cid=/i);

    // The legacy gate is retained: a 3-slice trip still refuses to build a handoff.
    const three = [baLeg('CDG', 'LHR', '2026-10-30'), baLeg('LHR', 'CDG', '2026-11-06'), baLeg('CDG', 'LHR', '2026-11-13')];
    assert.throws(
      () => buildBAProcessOfferUrl(three, { adults: 1, seniors: 0, youths: 0, children: 0, infantsInSeat: 0, infantsInLap: 0 }),
      /one-way and round-trip only/
    );
    const gated = buildUnifiedItinerary({ segments: three }).strategies.airlineLinks.carriers.find((c) => c.carrier === 'BA');
    assert.equal(gated.url, BA_SEARCH_FORM_URL, 'beyond two slices BA still gets the empty form, never a handoff');
    assert.match(gated.note, /needs 3 O&D slices/);
  });

  test('mixed carriers fall back to a directory homepage, never a fabricated joint cart', () => {
    const out = buildUnifiedItinerary({
      segments: [
        { origin: 'JFK', dest: 'LAX', ymd: '2026-11-12', carrier: 'AA', num: '123', cls: 'K', depH: 15, depM: 45 },
        { origin: 'LAX', dest: 'FRA', ymd: '2026-11-13', carrier: 'LH', num: '456', cls: 'K', depH: 9, depM: 30 },
      ],
    });
    const links = out.strategies.airlineLinks;
    assert.equal(links.honours, 'Known carrier surface');
    assert.equal(links.cannotFeature, 'Pre-filled fare');
    const lh = links.carriers.find((c) => c.carrier === 'LH');
    assert.equal(lh.kind, 'homepage');
    assert.equal(lh.url, 'https://www.lufthansa.com/');
    assert.match(lh.note, /Multiple marketing carriers/);
    // No carrier link anywhere in the payload may carry money or passenger identity.
    assert.doesNotMatch(JSON.stringify(links.carriers), /fareBasis|passport|firstName|lastName|session=|price=/i);
    // A single-carrier DL trip does get an experimental prefill — clearly labelled.
    const dl = buildUnifiedItinerary({ segments: [{ origin: 'JFK', dest: 'LAX', ymd: '2026-11-12', carrier: 'DL', num: '1', cls: 'K', depH: 8, depM: 0 }] });
    const delta = dl.strategies.airlineLinks.carriers[0];
    assert.equal(delta.kind, 'search_unverified');
    assert.match(delta.note, /NOT guaranteed/);
    assert.ok(delta.url.includes('delta.com'));
  });
});

describe('unified itinerary: the Matrix JSON output', () => {
  test('the Matrix document round-trips through the Matrix importer', () => {
    const matrix = buildUnifiedItinerary({ segments: SPICY_SEGMENTS }).strategies.matrixJson;
    assert.equal(matrix.available, true);
    assert.equal(matrix.roundTrips, true, 'the importer in this repository accepts what the exporter built');
    const parsed = parseMatrixItinerary(matrix.json).segments;
    assert.equal(parsed.length, 2);
    assert.deepEqual(
      parsed.map((s) => `${s.carrier}${s.num}:${s.origin}-${s.dest}:${s.ymd}`),
      ['AA100:JFK-LHR:2026-12-01', 'AA101:LHR-JFK:2026-12-08']
    );
    assert.equal(parsed[0].plus, true, 'the overnight leg survives the round trip');
    assert.equal(parsed[1].plus, false);
    assert.deepEqual([parsed[0].depH, parsed[0].depM], [19, 0]);
    assert.equal(parsed[0].cls, 'J');
    assert.equal(matrix.slices, 2);
  });

  test('per-leg cabin sits in the real Matrix field; the vector rides in ext', () => {
    const matrix = buildUnifiedItinerary({ segments: SPICY_SEGMENTS }).strategies.matrixJson;
    assert.equal(matrix.honours, 'Cabin vector + mixed flag');
    assert.equal(matrix.cannotFeature, 'Live pricing');
    const cabins = matrix.json.itinerary.slices.map((slice) => slice.segments[0].bookingInfos[0].cabin);
    assert.deepEqual(cabins, ['BUSINESS', 'COACH'], 'each leg keeps its OWN cabin — the thing no search token can do');
    assert.deepEqual(matrix.json.ext.cabinVector, ['business', 'economy']);
    assert.equal(matrix.json.ext.mixedCabin, true);
    assert.equal(matrix.json.itinerary.slices[0].segments[0].bookingInfos[0].bookingCode, 'J');
  });

  test('the Matrix document invents no price and emits no naive timestamp', () => {
    const matrix = buildUnifiedItinerary({ segments: SPICY_SEGMENTS }).strategies.matrixJson;
    const text = JSON.stringify(matrix.json);
    assert.doesNotMatch(text, /pricings|tickets|totalPrice|fareBasis|displayPrice|fareConstruction|taxTotals/i,
      'no money of any kind: this tool has no fare data and will not synthesise any');
    assert.match(matrix.caveats.join(' '), /no price, fare basis, tax or fare construction/i);
    const stamps = matrix.json.itinerary.slices.flatMap((s) => [s.departure, s.arrival, ...s.segments.flatMap((g) => [g.departure, g.arrival])]);
    for (const iso of stamps) assert.match(iso, /(Z|[+-]\d\d:\d\d)$/, `${iso} must carry an explicit UTC offset`);
    // Offsets are real, per airport, per date: JFK in December is −05:00, LHR is +00:00.
    assert.ok(stamps.some((iso) => iso.endsWith('-05:00')));
    assert.ok(stamps.some((iso) => iso.endsWith('+00:00')));
  });

  test('a timestamp is refused rather than guessed — DST, and airports with no zone', () => {
    const leg = (ymd, origin) => ({ origin, dest: 'LAX', ymd, carrier: 'AA', num: '123', cls: 'K', depH: 15, depM: 45, arrH: 18, arrM: 45 });
    const winter = buildUnifiedItinerary({ segments: [leg('2026-11-12', 'JFK')] }).strategies.matrixJson;
    const summer = buildUnifiedItinerary({ segments: [leg('2026-07-12', 'JFK')] }).strategies.matrixJson;
    // Same wall clock, different real offset: daylight saving, not a fixed −05:00.
    assert.ok(winter.json.itinerary.slices[0].departure.endsWith('-05:00'));
    assert.ok(summer.json.itinerary.slices[0].departure.endsWith('-04:00'));
    // SYD has no verified zone mapping here, so no offset is invented.
    const unknown = buildUnifiedItinerary({ segments: [leg('2026-11-12', 'SYD')] }).strategies.matrixJson;
    assert.equal(unknown.available, false);
    assert.ok(unknown.gaps.some((g) => g.route === 'SYD→LAX' && /timezone/.test(g.needs)));
    assert.match(unknown.reason, /will not invent/);
    // A DST gap is refused too, not resolved by picking one of the two hours.
    assert.equal(buildUnifiedItinerary({ segments: [{ ...leg('2026-03-08', 'JFK'), depH: 2, depM: 30 }] }).strategies.matrixJson.available, false);
  });
});

describe('unified itinerary: honesty and wiring', () => {
  test('an itinerary with no carrier or flight detail degrades instead of fabricating links', () => {
    const out = buildUnifiedItinerary({ legs: GF_LEGS });
    const { airlineLinks, matrixJson, perLeg, board } = out.strategies;
    assert.equal(perLeg.available, true, 'the Google outputs need nothing but airports, dates and cabins');
    assert.equal(board.available, true);
    assert.equal(airlineLinks.available, false);
    assert.match(airlineLinks.reason, /No marketing carrier/);
    assert.match(airlineLinks.reason, /will not guess a carrier from a route/);
    assert.equal(matrixJson.available, false);
    assert.deepEqual([...new Set(matrixJson.gaps.map((g) => g.needs))].sort(),
      ['arrival time with a known airport timezone', 'bookingClass', 'carrier', 'departure time with a known airport timezone', 'flightNumber'].sort());
    // Nothing airline-shaped was invented anywhere in the payload.
    assert.doesNotMatch(JSON.stringify(out), /aa\.com|britishairways\.com|delta\.com|united\.com/);
    // A 2-character city code is fine for tfs but Matrix has no city-code field.
    // The gap must say that, not blame the timezone.
    const city = buildUnifiedItinerary({ legs: [{ from: 'NY', to: 'LO', date: '2026-12-01', cabin: 'business' }] });
    assert.equal(city.strategies.board.available, true, 'tfs accepts 2-3 character codes, so the Google link still builds');
    assert.equal(city.strategies.matrixJson.available, false);
    assert.ok(city.strategies.matrixJson.gaps.some((g) => /3-letter IATA/.test(g.needs)));
    // Every strategy still declares what it would and would not have honoured.
    for (const strategy of [perLeg, board, airlineLinks, matrixJson]) {
      assert.equal(typeof strategy.honours, 'string');
      assert.equal(typeof strategy.cannotFeature, 'string');
    }
  });

  test('both passenger vocabularies normalise alike, and seniors fold into adults for tfs only', () => {
    const gf = normalizePassengers({ adults: 2, infantsOnLap: 1 });
    const spicy = normalizePassengers({ adults: 2, seniors: 0, youths: 0, children: 0, infantsInSeat: 0, infantsInLap: 1 });
    assert.deepEqual(gf.spicy, spicy.spicy, 'the two vocabularies describe the same travellers');
    assert.deepEqual(gf.google, spicy.google);
    assert.deepEqual(gf.spicy, { adults: 2, seniors: 0, youths: 0, children: 0, infantsInSeat: 0, infantsInLap: 1 });

    // tfs field 8 has no senior or youth code, so they fold into adults for the
    // Google tokens only — the carrier links keep them separate.
    const folded = normalizePassengers({ seniors: 2 });
    assert.equal(folded.google.adults, 2);
    assert.equal(folded.spicy.adults, 0);
    assert.equal(folded.spicy.seniors, 2);
    assert.equal(folded.foldedSeniorOrYouth, 2);

    const out = buildUnifiedItinerary({
      segments: [{ origin: 'JFK', dest: 'LAX', ymd: '2026-11-12', carrier: 'AA', num: '123', cls: 'K', depH: 15, depM: 45 }],
      passengers: { adults: 2, infantsOnLap: 1 },
    });
    const aa = out.strategies.airlineLinks.carriers[0];
    assert.match(decodeURIComponent(aa.url), /A2S0C0I0Y0L1/, 'the AA envelope carries the same counts');
    assert.ok(out.warnings.some((w) => /folded into adults/i.test(w)) === false, 'no fold happened, so no fold warning');
    assert.equal(buildUnifiedItinerary({ legs: GF_LEGS, passengers: { seniors: 1, adults: 1 } }).warnings.some((w) => /folded into adults/i.test(w)), true);
  });

  test('POST /api/links serves the unified payload, 400s on a bad itinerary and 405s on GET', async () => {
    const call = (body, method = 'POST') =>
      new Promise((resolve) => {
        // A real IncomingMessage yields Buffers, so the mock does too.
        const req = Readable.from([Buffer.from(JSON.stringify(body))]);
        req.method = method;
        const res = {
          writeHead(status) { this.status = status; },
          end(payload) { resolve({ status: this.status, body: JSON.parse(payload) }); },
        };
        handler(req, res);
      });

    const ok = await call({ legs: GF_LEGS });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.schema, 'unified/v1');
    assert.deepEqual(Object.keys(ok.body.strategies).sort(), ['airlineLinks', 'board', 'matrixJson', 'perLeg']);
    assert.equal(ok.body.strategies.perLeg.searches.length, 2);

    const bad = await call({});
    assert.equal(bad.status, 400, 'a missing itinerary is the caller’s problem, not a server fault');
    assert.match(bad.body.error, /an itinerary is required/);

    assert.equal((await call({ legs: GF_LEGS }, 'GET')).status, 405);
    // The exported pure half is what the handler calls.
    assert.equal(buildLinks({ legs: GF_LEGS }).strategies.board.tfs, ok.body.strategies.board.tfs);
  });
});
