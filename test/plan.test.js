// The mixed-cabin planner, booking deep links, and the API entry points.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planMixedCabin } from '../lib/mixed-cabin.js';
import { buildBookingLink, bookingLinkFromItineraries } from '../lib/booking-link.js';
import { decodeTfs, SEAT, TRIP } from '../lib/tfs.js';
import { decodeFields, diffMessages, fromBase64Url } from '../lib/protobuf.js';
import { TFS_GOLDENS } from './goldens.js';
import { buildSearch } from '../api/build.js';
import { parseResults } from '../api/parse-results.js';
import { decodeToken } from '../api/decode.js';

const TRIP_LEGS = [
  { from: 'JFK', to: 'LHR', date: '2026-12-01', cabin: 'business' },
  { from: 'LHR', to: 'CAI', date: '2026-12-08', cabin: 'economy' },
];

describe('mixed-cabin planner', () => {
  const plan = planMixedCabin({ legs: TRIP_LEGS });

  test('reports the cabin vector it was asked for', () => {
    assert.deepEqual(plan.cabinVector, ['business', 'economy']);
    assert.deepEqual(plan.cabinVector, ['business', 'economy']);
    assert.equal(plan.isMixed, true);
  });

  test('per-leg gives every leg its own cabin — the only exact request', () => {
    const searches = plan.strategies['per-leg'].searches;
    assert.equal(searches.length, 2);
    assert.equal(decodeTfs(searches[0].tfs).seat, SEAT.BUSINESS);
    assert.equal(decodeTfs(searches[1].tfs).seat, SEAT.ECONOMY);
    assert.equal(decodeTfs(searches[0].tfs).trip, TRIP.ONE_WAY);
    assert.deepEqual(decodeTfs(searches[0].tfs).segments[0].from, ['JFK']);
  });

  test('board is one multi-city token in the HIGHEST requested cabin', () => {
    const board = plan.strategies.board;
    const d = decodeTfs(board.tfs);
    assert.equal(d.trip, TRIP.MULTI_CITY);
    assert.equal(d.seat, SEAT.BUSINESS, 'business > economy, so the board opens in business');
    assert.equal(d.segments.length, 2);
    assert.equal(board.openInCabin, 'business');
  });

  test('matrix sweeps once per distinct cabin, lowest first', () => {
    const searches = plan.strategies.matrix.searches;
    assert.deepEqual(
      searches.map((s) => s.cabin),
      ['economy', 'business']
    );
    for (const s of searches) assert.equal(decodeTfs(s.tfs).trip, TRIP.MULTI_CITY);
  });

  test('warns that per-leg and bundled pricing differ', () => {
    assert.ok(
      plan.warnings.some((w) => /bundled|one-way/i.test(w)),
      'a mixed trip must say out loud that the two prices are not comparable'
    );
  });

  test('a single-cabin trip collapses and says so', () => {
    const flat = planMixedCabin({
      legs: [
        { from: 'JFK', to: 'LHR', date: '2026-12-01', cabin: 'business' },
        { from: 'LHR', to: 'CAI', date: '2026-12-08', cabin: 'business' },
      ],
    });
    assert.equal(flat.isMixed, false);
    assert.equal(flat.strategies.matrix.searches.length, 1);
  });

  test('one leg warns there is nothing to mix', () => {
    const solo = planMixedCabin({ legs: [{ from: 'JFK', to: 'LHR', date: '2026-12-01', cabin: 'business' }] });
    assert.ok(solo.warnings.some((w) => /nothing to mix/i.test(w)));
  });

  test('every emitted URL is a real Google Flights search link', () => {
    for (const strategy of Object.values(plan.strategies)) {
      const urls = [strategy.url, ...(strategy.searches ?? []).map((s) => s.url)].filter(Boolean);
      for (const url of urls) assert.match(url, /^https:\/\/www\.google\.com\/travel\/flights\/search\?tfs=/);
    }
  });
});

describe('booking deep links', () => {
  const itinerary = {
    legs: [
      {
        from: 'JFK',
        to: 'LHR',
        departure: '2026-12-01T20:30',
        airline: 'BA',
        flightNumber: '178',
      },
    ],
  };

  test('one segment is one-way (field 19 = 2) and carries the booking pin', () => {
    const { tfs } = buildBookingLink({ segments: [[{ origin: 'JFK', date: '2026-12-01', dest: 'LHR', airline: 'BA', flightNumber: '178' }]] });
    const d = decodeTfs(tfs);
    assert.equal(d.trip, 2);
    assert.equal(d.pinned, true, 'booking tokens carry the field-16 pin search tokens do not');
    assert.deepEqual(d.segments[0].legs, [
      { origin: 'JFK', date: '2026-12-01', dest: 'LHR', airline: 'BA', flightNumber: '178' },
    ]);
  });

  test('two or more segments encode field 19 = 1, multi-city included', () => {
    const legs = (from, dest) => ({ origin: from, date: '2026-12-01', dest, airline: 'BA', flightNumber: '178' });
    for (const count of [2, 3]) {
      const segments = [[legs('JFK', 'LHR')], [legs('LHR', 'CAI')]];
      if (count === 3) segments.push([legs('CAI', 'JFK')]);
      assert.equal(decodeTfs(buildBookingLink({ segments }).tfs).trip, 1);
    }
  });

  test('a connecting itinerary pins BOTH physical legs', () => {
    const { tfs } = buildBookingLink({
      segments: [
        [
          { origin: 'JFK', date: '2026-12-01', dest: 'ORD', airline: 'AA', flightNumber: '100' },
          { origin: 'ORD', date: '2026-12-01', dest: 'LHR', airline: 'AA', flightNumber: '200' },
        ],
      ],
    });
    const d = decodeTfs(tfs);
    assert.equal(d.segments[0].legs.length, 2);
    assert.deepEqual(d.segments[0].from, ['JFK']);
    assert.deepEqual(d.segments[0].to, ['LHR'], 'the segment spans origin to final destination');
  });

  test('the same itinerary always yields the same URL', () => {
    const a = buildBookingLink({ segments: [[{ origin: 'JFK', date: '2026-12-01', dest: 'LHR', airline: 'BA', flightNumber: '178' }]] });
    const b = buildBookingLink({ segments: [[{ origin: 'JFK', date: '2026-12-01', dest: 'LHR', airline: 'BA', flightNumber: '178' }]] });
    assert.equal(a.url, b.url);
    assert.match(a.url, /\/travel\/flights\/booking\?tfs=/);
  });

  test('builds straight from a parsed result', () => {
    const { tfs } = bookingLinkFromItineraries(itinerary);
    assert.equal(decodeTfs(tfs).segments[0].legs[0].airline, 'BA');
  });

  test('the booking pin is exactly 2^64-1', () => {
    const { tfs } = buildBookingLink({
      segments: [[{ origin: 'JFK', date: '2026-12-01', dest: 'LHR', airline: 'BA', flightNumber: '178' }]],
    });
    const pinField = decodeFields(fromBase64Url(tfs)).find((f) => f.fieldNumber === 16);
    assert.ok(pinField, 'field 16 present');
    assert.equal(pinField.wireType, 2, 'the pin is length-delimited');
    const inner = decodeFields(pinField.value);
    assert.equal(inner.length, 1);
    assert.equal(inner[0].fieldNumber, 1);
    assert.equal(inner[0].value, 18446744073709551615n);
  });

  test('an empty itinerary is refused, not silently emitted', () => {
    assert.throws(() => buildBookingLink({ segments: [] }), RangeError);
  });
});

describe('field-discovery diff probe', () => {
  test('finds the field that changed between two tokens', () => {
    // The probe's whole job: change one control, diff, see which field moved.
    const economy = fromBase64Url(TFS_GOLDENS.cabin_economy);
    const business = fromBase64Url(TFS_GOLDENS.cabin_business);
    const d = diffMessages(economy, business);
    assert.deepEqual(d.changed, ['f9/w0']);
    const f9 = d.fields.find((f) => f.field === 'f9/w0');
    assert.deepEqual(f9.a, [1]);
    assert.deepEqual(f9.b, [3]);
  });

  test('reports a value change even when the field count is identical', () => {
    // A naive count-only diff misses this, which is the common case.
    const oneWay = fromBase64Url(TFS_GOLDENS.one_way_jfk_lax);
    const roundTrip = fromBase64Url(TFS_GOLDENS.round_trip_jfk_lax);
    const d = diffMessages(oneWay, roundTrip);
    assert.ok(d.changed.includes('f19/w0'), 'field 19 flipped 2 -> 1');
    assert.ok(d.changed.includes('f3/w2'), 'a second segment appeared');
  });

  test('identical tokens report nothing changed', () => {
    const bytes = fromBase64Url(TFS_GOLDENS.kitchen_sink_round_trip);
    assert.deepEqual(diffMessages(bytes, bytes).changed, []);
  });
});

describe('api entry points', () => {
  test('/api/build returns a token, a URL and what it decoded to', () => {
    const out = buildSearch({
      segments: [{ from: 'JFK', to: 'LHR', date: '2026-12-01' }],
      seat: 'business',
      passengers: { adults: 2 },
    });
    assert.match(out.url, /tfs=/);
    assert.equal(out.decoded.seatName, 'business');
    assert.deepEqual(
      out.decoded.passengers.map((p) => p.name),
      ['adult', 'adult']
    );
  });

  test('/api/decode round-trips and flags any drift', () => {
    const built = buildSearch({ segments: [{ from: 'JFK', to: 'LHR', date: '2026-12-01' }] });
    const decoded = decodeToken(built.tfs);
    assert.equal(decoded.roundTrip.matches, true);
    assert.equal(decoded.trip, 'one-way');
  });

  test('/api/parse-results scores itineraries against a cabin vector', () => {
    // Minimal page: one mixed row (JFK→LHR business, LHR→CAI economy).
    const mkLeg = (from, to, cabin) => {
      const l = [];
      l[3] = from;
      l[6] = to;
      l[16] = cabin;
      l[22] = ['BA', '178', 'BA'];
      return l;
    };
    const r = [];
    r[0] = ['BA', ['British Airways'], [mkLeg('JFK', 'LHR', 3), mkLeg('LHR', 'CAI', 1)]];
    r[1] = [[null, 1107], 'GgUaA1VTRA'];
    r[10] = true;
    const html = `AF_initDataCallback({key: 'ds:1', hash: '1', data:[[],[],[],${JSON.stringify([
      [r],
    ])}], sideChannel: {}});`;

    const out = parseResults({ html, cabinVector: ['business', 'economy'] });
    assert.equal(out.found, true);
    assert.equal(out.matches.length, 1);
    assert.equal(out.matches[0].price, 1107);
    assert.equal(out.matches[0].currency, 'USD');
    assert.equal(out.matches[0].mixedCabin, true);
    assert.equal(out.matches[0].exact, true);

    const wrong = parseResults({ html, cabinVector: ['economy', 'business'] });
    assert.equal(wrong.matches.length, 0, 'a downgraded leg must not match');
  });
});
