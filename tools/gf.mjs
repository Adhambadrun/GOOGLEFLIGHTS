#!/usr/bin/env node
// GOOGLEFLIGHTS command line.
//
//   node tools/gf.mjs build  --from JFK --to LHR --date 2026-12-01 --cabin business
//   node tools/gf.mjs build  --segments legs.json
//   node tools/gf.mjs decode CBwQAhoeEgoyMDMwLTA5LTE1agcI...
//   node tools/gf.mjs diff   <tokenA> <tokenB>        # the field-discovery probe
//   node tools/gf.mjs plan   --legs trip.json
//   node tools/gf.mjs links  --legs trip.json [--carrier BA]   # all four outputs
//   node tools/gf.mjs parse  saved-page.html [--cabin business,economy]
//
// Everything except `plan`'s URL output is offline.

import { readFileSync } from 'fs';
import { buildTfs, decodeTfs, searchUrl, bookingUrl } from '../lib/tfs.js';
import { planMixedCabin } from '../lib/mixed-cabin.js';
import { buildUnifiedItinerary } from '../lib/unified.js';
import { parseResultsHtml, filterByCabinVector } from '../lib/results.js';
import { diffMessages, fromBase64Url } from '../lib/protobuf.js';

const [command, ...rest] = process.argv.slice(2);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [key, inline] = token.slice(2).split('=');
    const next = argv[i + 1];
    if (inline !== undefined) out[key] = inline;
    else if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

const args = parseArgs(rest);
const positional = rest.filter((t) => !t.startsWith('--') && !rest[rest.indexOf(t) - 1]?.startsWith('--'));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

switch (command) {
  case 'build': {
    const segments = args.segments
      ? readJson(args.segments)
      : [{ from: args.from, to: args.to, date: args.date }];
    const tfs = buildTfs({
      segments,
      seat: args.cabin ?? 'economy',
      trip: args.trip,
      passengers: args.pax ? readJson(args.pax) : undefined,
      flavor: args.flavor,
    });
    const locale = { hl: args.hl, gl: args.gl, curr: args.curr };
    console.log(JSON.stringify({ tfs, search: searchUrl(tfs, locale), booking: bookingUrl(tfs, locale) }, null, 2));
    break;
  }

  case 'decode': {
    const decoded = decodeTfs(positional[0]);
    console.log(
      JSON.stringify(
        {
          token: decoded.token,
          trip: decoded.tripName,
          seat: decoded.seatName,
          passengers: decoded.passengers.map((p) => p.name),
          pinned: decoded.pinned,
          constants: decoded.constants,
          segments: decoded.segments,
          unknownFields: decoded.unknown,
        },
        null,
        2
      )
    );
    break;
  }

  case 'diff': {
    // Field-level diff of two tokens. This is how you find out what a control
    // in the UI does: capture one token per setting, diff them, and whichever
    // field moves is the field that setting writes.
    const [a, b] = positional.map((t) => fromBase64Url(t));
    console.log(JSON.stringify(diffMessages(a, b), null, 2));
    break;
  }

  case 'plan': {
    const plan = planMixedCabin(args.legs ? readJson(args.legs) : { legs: readJson(positional[0]) });
    console.log(JSON.stringify(plan, null, 2));
    break;
  }

  case 'links': {
    // The unified itinerary: per-leg links, the board link, carrier links and a
    // Matrix-shaped JSON document, all from one input file. Same offline rule as
    // everything else here — building links never contacts anybody.
    const spec = args.legs ? readJson(args.legs) : args.segments ? readJson(args.segments) : { legs: readJson(positional[0]) };
    if (args.carrier) spec.carrier = args.carrier;
    const out = buildUnifiedItinerary(spec);
    console.log(JSON.stringify(out, null, 2));
    break;
  }

  case 'parse': {
    const html = readFileSync(positional[0], 'utf8');
    const result = parseResultsHtml(html);
    const out = { ...result };
    if (args.cabin) {
      const vector = String(args.cabin).split(',');
      out.matches = filterByCabinVector(result.itineraries, vector).map(({ itinerary, verdict }) => ({
        price: itinerary.price,
        currency: itinerary.currency,
        airline: itinerary.airlineName ?? itinerary.airline,
        mixedCabin: itinerary.mixedCabin,
        exact: verdict.exact,
        perLeg: verdict.perLeg.map((l) => `${l.route} ${l.gotName ?? '?'}${l.status === 'exact' ? '' : ` (${l.status})`}`),
      }));
    }
    console.log(JSON.stringify(out, null, 2));
    break;
  }

  default:
    console.error(`Unknown command ${command ?? '(none)'}
Usage:
  gf build  --from JFK --to LHR --date 2026-12-01 [--cabin business] [--trip one-way]
  gf decode <tfs>
  gf diff   <tfsA> <tfsB>
  gf plan   --legs trip.json
  gf links  --legs trip.json [--carrier BA]     # all four outputs for one itinerary
  gf links  --segments gds-trip.json
  gf parse  saved-page.html [--cabin business,economy]`);
    process.exit(1);
}
