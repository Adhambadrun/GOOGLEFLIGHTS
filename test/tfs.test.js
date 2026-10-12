// Byte-parity tests against real captured tokens.
//
// These are the regression lock for the whole project. A `tfs` token is
// bytes-on-the-wire: if the encoder drifts, Google does not reject the token —
// it quietly answers a slightly different question. So these compare bytes,
// not decoded meaning.
//
// The goldens come from the reference implementation (punitarani/fli) and are
// reproduced byte-for-byte in test/goldens.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TFS_GOLDENS } from './goldens.js';
import { buildTfs, decodeTfs, encodeSegment, passengerCodes, SEAT, TRIP } from '../lib/tfs.js';
import { toBase64Url, fromBase64Url, encodeVarintField } from '../lib/protobuf.js';

const OUT = '2030-09-15';
const RET = '2030-09-19';
const MULTI = '2030-10-15';

const seg = (from, to, date, extra = {}) => ({ from, to, date, ...extra });
const jfkLax = (extra = {}) => [seg(['JFK'], ['LAX'], OUT, extra)];

// Every golden, and the request that produces it. Mirrors the reference
// suite's case list so coverage lines up one-for-one.
const CASES = {
  one_way_jfk_lax: () => buildTfs({ segments: jfkLax() }),
  round_trip_jfk_lax: () =>
    buildTfs({ segments: [seg(['JFK'], ['LAX'], OUT), seg(['LAX'], ['JFK'], RET)], trip: TRIP.ROUND_TRIP }),

  round_trip_selected_outbound: () =>
    buildTfs({
      segments: [
        seg(['JFK'], ['LHR'], OUT, {
          legs: [{ origin: 'JFK', date: OUT, dest: 'LHR', airline: 'BA', flightNumber: '178' }],
        }),
        seg(['LHR'], ['JFK'], RET),
      ],
      trip: TRIP.ROUND_TRIP,
    }),
  round_trip_selected_connecting_outbound: () =>
    buildTfs({
      segments: [
        seg(['JFK'], ['LHR'], OUT, {
          legs: [
            { origin: 'JFK', date: OUT, dest: 'ORD', airline: 'AA', flightNumber: '100' },
            { origin: 'ORD', date: OUT, dest: 'LHR', airline: 'AA', flightNumber: '200' },
          ],
        }),
        seg(['LHR'], ['JFK'], RET),
      ],
      trip: TRIP.ROUND_TRIP,
    }),

  multi_airport: () =>
    buildTfs({ segments: [seg(['BOM', 'DEL', 'AMD'], ['ORD', 'DTW'], MULTI)] }),

  cabin_economy: () => buildTfs({ segments: jfkLax() }),
  cabin_premium_economy: () => buildTfs({ segments: jfkLax(), seat: 'premium-economy' }),
  cabin_business: () => buildTfs({ segments: jfkLax(), seat: 'business' }),
  cabin_first: () => buildTfs({ segments: jfkLax(), seat: 'first' }),

  stops_any: () => buildTfs({ segments: jfkLax() }),
  stops_non_stop: () => buildTfs({ segments: jfkLax({ maxStops: 0 }) }),
  stops_one_stop_or_fewer: () => buildTfs({ segments: jfkLax({ maxStops: 1 }) }),
  stops_two_or_fewer_stops: () => buildTfs({ segments: jfkLax({ maxStops: 2 }) }),

  pax_single_adult: () => buildTfs({ segments: jfkLax() }),
  pax_two_adults: () => buildTfs({ segments: jfkLax(), passengers: { adults: 2 } }),
  pax_adult_child: () => buildTfs({ segments: jfkLax(), passengers: { adults: 1, children: 1 } }),
  pax_adult_lap_infant: () => buildTfs({ segments: jfkLax(), passengers: { adults: 1, infantsOnLap: 1 } }),
  pax_adult_seat_infant: () => buildTfs({ segments: jfkLax(), passengers: { adults: 1, infantsInSeat: 1 } }),
  pax_family_mix: () =>
    buildTfs({
      segments: jfkLax(),
      passengers: { adults: 2, children: 1, infantsInSeat: 1, infantsOnLap: 1 },
    }),
  pax_full_house: () =>
    buildTfs({
      segments: jfkLax(),
      passengers: { adults: 4, children: 2, infantsInSeat: 2, infantsOnLap: 1 },
    }),
  pax_two_adults_two_lap_infants: () =>
    buildTfs({ segments: jfkLax(), passengers: { adults: 2, infantsOnLap: 2 } }),

  alliance_include_oneworld: () => buildTfs({ segments: jfkLax({ carriers: ['ONEWORLD'] }) }),
  alliance_include_skyteam: () => buildTfs({ segments: jfkLax({ carriers: ['SKYTEAM'] }) }),
  alliance_include_star_alliance: () => buildTfs({ segments: jfkLax({ carriers: ['STAR_ALLIANCE'] }) }),
  alliance_exclude_oneworld: () => buildTfs({ segments: jfkLax({ carriersExclude: ['ONEWORLD'] }) }),
  alliance_exclude_skyteam: () => buildTfs({ segments: jfkLax({ carriersExclude: ['SKYTEAM'] }) }),
  alliance_exclude_star_alliance: () => buildTfs({ segments: jfkLax({ carriersExclude: ['STAR_ALLIANCE'] }) }),
  alliance_include_two_exclude_one: () =>
    buildTfs({
      segments: jfkLax({ carriers: ['ONEWORLD', 'STAR_ALLIANCE'], carriersExclude: ['SKYTEAM'] }),
    }),

  layover_airport_and_min: () => buildTfs({ segments: jfkLax({ layoverAirports: ['ORD'], minLayover: 120 }) }),
  layover_max_only: () => buildTfs({ segments: jfkLax({ maxLayover: 300 }) }),
  layover_full: () =>
    buildTfs({ segments: jfkLax({ layoverAirports: ['ORD', 'DFW'], minLayover: 90, maxLayover: 600 }) }),

  kitchen_sink_round_trip: () =>
    buildTfs({
      segments: [
        seg(['JFK', 'EWR'], ['LHR', 'LGW'], OUT, {
          maxStops: 1,
          carriers: ['ONEWORLD'],
          layoverAirports: ['DUB'],
          minLayover: 60,
          maxLayover: 240,
        }),
        seg(['LHR', 'LGW'], ['JFK', 'EWR'], RET, {
          maxStops: 1,
          carriers: ['ONEWORLD'],
          layoverAirports: ['DUB'],
          minLayover: 60,
          maxLayover: 240,
        }),
      ],
      trip: TRIP.ROUND_TRIP,
      seat: SEAT.BUSINESS,
      passengers: { adults: 2, children: 1, infantsOnLap: 1 },
    }),

  sweep_one_way_date_override: () => buildTfs({ segments: [seg(['JFK'], ['LAX'], '2030-11-02')] }),
  sweep_round_trip_date_override: () =>
    buildTfs({
      segments: [seg(['JFK'], ['LAX'], '2030-11-02'), seg(['LAX'], ['JFK'], '2030-11-09')],
      trip: TRIP.ROUND_TRIP,
    }),
};

describe('encoder is byte-identical to captured tokens', () => {
  for (const [name, build] of Object.entries(CASES)) {
    test(name, () => {
      const expected = TFS_GOLDENS[name];
      assert.ok(expected, `no golden named ${name}`);
      assert.equal(build(), expected);
    });
  }

  test('every golden has a case', () => {
    assert.deepEqual(
      Object.keys(TFS_GOLDENS).sort(),
      Object.keys(CASES).sort(),
      'a golden without a case is an untested regression lock — add one'
    );
  });
});

describe('encoder traps', () => {
  test('"any number of stops" OMITS field 5 — writing 0 means non-stop', () => {
    assert.equal(buildTfs({ segments: jfkLax() }), TFS_GOLDENS.stops_any);
    assert.notEqual(buildTfs({ segments: jfkLax() }), TFS_GOLDENS.stops_non_stop);
    assert.equal(buildTfs({ segments: jfkLax({ maxStops: 0 }) }), TFS_GOLDENS.stops_non_stop);
  });

  test('field 19 is the trip type, at the tail of the token', () => {
    assert.deepEqual(
      Array.from(fromBase64Url(TFS_GOLDENS.one_way_jfk_lax).slice(-3)),
      [0x98, 0x01, 0x02]
    );
    assert.deepEqual(
      Array.from(fromBase64Url(TFS_GOLDENS.round_trip_jfk_lax).slice(-3)),
      [0x98, 0x01, 0x01]
    );
  });

  test('passenger wire codes: 1 adult, 2 child, 3 lap infant, 4 seated infant', () => {
    // These two are the ones that get swapped in the wild, and swapping them
    // produces a plausible, non-erroring search that quotes the wrong fare.
    assert.deepEqual(passengerCodes({ adults: 1, infantsOnLap: 1 }), [1, 3]);
    assert.deepEqual(passengerCodes({ adults: 1, infantsInSeat: 1 }), [1, 4]);
  });

  test('an empty passenger mix still sends one adult', () => {
    assert.deepEqual(passengerCodes({}), [1]);
    assert.equal(buildTfs({ segments: jfkLax(), passengers: {} }), TFS_GOLDENS.pax_single_adult);
  });

  test('more than nine travellers is refused rather than silently truncated', () => {
    assert.throws(() => passengerCodes({ adults: 10 }), RangeError);
  });

  test('every airport in a multi-airport segment reaches the wire', () => {
    const raw = fromBase64Url(TFS_GOLDENS.multi_airport);
    const text = Buffer.from(raw).toString('latin1');
    for (const code of ['BOM', 'DEL', 'AMD', 'ORD', 'DTW']) assert.ok(text.includes(code), code);
  });
});

describe('decoder', () => {
  test('round-trips every golden back to identical bytes', () => {
    for (const [name, token] of Object.entries(TFS_GOLDENS)) {
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
        passengers: toMix(decoded.passengers),
        pinMaxU64: decoded.pinned,
      });
      assert.equal(rebuilt, token, `${name} did not round-trip`);
    }
  });

  test('reads the kitchen-sink token back as it was built', () => {
    const d = decodeTfs(TFS_GOLDENS.kitchen_sink_round_trip);
    assert.equal(d.tripName, 'round-trip');
    assert.equal(d.seatName, 'business');
    assert.deepEqual(
      d.passengers.map((p) => p.name),
      ['adult', 'adult', 'child', 'infant-on-lap']
    );
    assert.equal(d.pinned, false);
    assert.equal(d.segments.length, 2);
    assert.deepEqual(d.segments[0].from, ['JFK', 'EWR']);
    assert.deepEqual(d.segments[0].to, ['LHR', 'LGW']);
    assert.equal(d.segments[0].maxStops, 1);
    assert.deepEqual(d.segments[0].carriers, ['ONEWORLD']);
    assert.deepEqual(d.segments[0].layoverAirports, ['DUB']);
    assert.equal(d.segments[0].minLayover, 60);
    assert.equal(d.segments[0].maxLayover, 240);
    assert.equal(d.constants.f1, 28);
    assert.equal(d.constants.f2, 2);
    assert.equal(d.constants.f14, 1);
  });

  test('reads a pinned leg back out', () => {
    const d = decodeTfs(TFS_GOLDENS.round_trip_selected_outbound);
    assert.deepEqual(d.segments[0].legs, [
      { origin: 'JFK', date: OUT, dest: 'LHR', airline: 'BA', flightNumber: '178' },
    ]);
  });

  test('an unknown field is surfaced, not dropped', () => {
    // Simulate Google adding a field: splice one into a known-good token and
    // check the rest of the search still reads back correctly.
    const bytes = fromBase64Url(TFS_GOLDENS.one_way_jfk_lax);
    const extra = encodeVarintField(99, 7);
    const spliced = Uint8Array.from([...bytes.slice(0, 2), ...extra, ...bytes.slice(2)]);
    const d = decodeTfs(toBase64Url(spliced));
    assert.equal(d.unknown.f99, 7);
    assert.equal(d.seat, SEAT.ECONOMY);
    assert.equal(d.tripName, 'one-way');
    assert.deepEqual(d.segments[0].from, ['JFK']);
  });

  test('a malformed token raises instead of returning half a search', () => {
    assert.throws(() => decodeTfs('not-base64!!!'), Error);
  });
});

function toMix(passengers) {
  const map = {
    adult: 'adults',
    child: 'children',
    'infant-on-lap': 'infantsOnLap',
    'infant-in-seat': 'infantsInSeat',
  };
  return passengers.reduce((acc, p) => {
    acc[map[p.name]] = (acc[map[p.name]] ?? 0) + 1;
    return acc;
  }, {});
}
