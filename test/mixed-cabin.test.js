// Result parsing and mixed-cabin matching.
//
// The fixture rows below are hand-built to the documented wire shape (see the
// index map in lib/results.js). They are the only place per-leg cabin
// matching gets exercised end-to-end, which is the point of the project.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPayload,
  flightRows,
  parseRow,
  parseResultsHtml,
  matchCabinVector,
  filterByCabinVector,
} from '../lib/results.js';

/** Build a leg array in Google's positional shape. */
function leg({ from, to, fromName, toName, cabin, airline = 'BA', number = '178', duration = 420 }) {
  const l = [];
  l[3] = from;
  l[4] = fromName ?? `${from} airport`;
  l[5] = toName ?? `${to} airport`;
  l[6] = to;
  l[8] = [20, 30];
  l[10] = [8, 30];
  l[11] = duration;
  l[16] = cabin;
  l[17] = 'Boeing 777';
  l[19] = false;
  l[20] = [2030, 9, 15];
  l[21] = [2030, 9, 16];
  l[22] = [airline, number, airline];
  l[31] = 180000;
  return l;
}

function row({ legs, price = 1107, mixed = false, airline = 'BA', token = 'tok' }) {
  const detail = [];
  detail[0] = airline;
  detail[1] = [`${airline} Airways`];
  detail[2] = legs;
  detail[9] = legs.reduce((n, l) => n + l[11], 0);
  detail[12] = false;
  const r = [];
  r[0] = detail;
  r[1] = [[null, price], PRICE_TOKEN];
  r[8] = token;
  r[10] = mixed;
  return r;
}

/** A real-shaped price token: protobuf field 3 -> field 3 -> 'USD'. */
const PRICE_TOKEN = 'GgUaA1VTRA';

// Rows live in payload[3][0] on a search page (and in [2][0] on some
// variants — the parser takes both). Google also emits other ds:* blobs
// before this one, so the extractor has to skip past them.
const page = (rows, bucket = 3) => {
  const buckets = [[], [], []];
  buckets[bucket] = [rows];
  return `AF_initDataCallback({key: 'ds:0', hash: '0', data:[[1]], sideChannel: {}});\n`
    + `AF_initDataCallback({key: 'ds:1', hash: '1', data:${JSON.stringify(buckets)}, sideChannel: {}});`;
};

describe('parsing a saved page', () => {
  test('extracts the ds:1 payload and its rows', () => {
    const html = page([row({ legs: [leg({ from: 'JFK', to: 'LHR', cabin: 3 })] })]);
    const payload = extractPayload(html);
    assert.ok(payload, 'payload found');
    assert.equal(flightRows(payload).length, 1);
  });

  test('reads per-leg cabin codes and the mixed-cabin flag', () => {
    const html = page([
      row({
        legs: [leg({ from: 'JFK', to: 'LHR', cabin: 3 }), leg({ from: 'LHR', to: 'CAI', cabin: 1 })],
        mixed: true,
        price: 1107,
      }),
    ]);
    const [itinerary] = parseResultsHtml(html).itineraries;
    assert.deepEqual(itinerary.cabinVector, [3, 1]);
    assert.deepEqual(itinerary.cabinVectorNames, ['business', 'economy']);
    assert.equal(itinerary.mixedCabin, true);
    assert.equal(itinerary.price, 1107);
    assert.equal(itinerary.stops, 1);
    assert.equal(itinerary.legs[0].airline, 'BA');
    assert.equal(itinerary.legs[0].flightNumber, '178');
    assert.equal(itinerary.legs[0].departure, '2030-09-15T20:30');
    assert.equal(itinerary.legs[1].arrival, '2030-09-16T08:30');
  });

  test('says so when a page carries no rows, rather than returning nothing', () => {
    // This is the multi-city case: Google loads those rows client-side.
    const out = parseResultsHtml('<html><body>no blob here</body></html>');
    assert.equal(out.found, false);
    assert.match(out.reason, /ds:1/);
  });
});

describe('matching a requested per-leg cabin vector', () => {
  const mixed = parseRow(
    row({
      legs: [leg({ from: 'JFK', to: 'LHR', cabin: 3 }), leg({ from: 'LHR', to: 'CAI', cabin: 1 })],
      mixed: true,
    })
  );
  const allBusiness = parseRow(
    row({
      legs: [leg({ from: 'JFK', to: 'LHR', cabin: 3 }), leg({ from: 'LHR', to: 'CAI', cabin: 3 })],
      price: 2400,
    })
  );
  const downgraded = parseRow(
    row({
      legs: [leg({ from: 'JFK', to: 'LHR', cabin: 1 }), leg({ from: 'LHR', to: 'CAI', cabin: 1 })],
      price: 900,
    })
  );

  test('exact hit on every leg', () => {
    const v = matchCabinVector(mixed, ['business', 'economy']);
    assert.equal(v.exact, true);
    assert.equal(v.match, true);
    assert.equal(v.score, 2);
    assert.deepEqual(
      v.perLeg.map((l) => l.status),
      ['exact', 'exact']
    );
  });

  test('an upgrade still counts as a match, but not an exact one', () => {
    const v = matchCabinVector(allBusiness, ['business', 'economy']);
    assert.equal(v.match, true);
    assert.equal(v.exact, false);
    assert.deepEqual(
      v.perLeg.map((l) => l.status),
      ['exact', 'upgraded']
    );
  });

  test('a downgrade never matches — that is the whole point', () => {
    assert.equal(matchCabinVector(downgraded, ['business', 'economy']).match, false);
  });

  test('a leg-count mismatch is refused rather than guessed at', () => {
    assert.equal(matchCabinVector(mixed, ['business']).match, false);
    assert.match(matchCabinVector(mixed, ['business']).reason, /leg count/);
  });

  test('ranks matches cheapest-first, exact before upgraded', () => {
    const ranked = filterByCabinVector([allBusiness, mixed, downgraded], ['business', 'economy']);
    assert.deepEqual(
      ranked.map((r) => r.itinerary.price),
      [1107, 2400]
    );
    assert.equal(ranked[0].verdict.exact, true);
  });

  test('allowUpgrades:false demands an exact cabin on every leg', () => {
    const strict = filterByCabinVector([allBusiness, mixed], ['business', 'economy'], {
      allowUpgrades: false,
    });
    assert.deepEqual(
      strict.map((r) => r.itinerary.price),
      [1107]
    );
  });
});
