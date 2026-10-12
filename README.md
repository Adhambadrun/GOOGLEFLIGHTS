# GOOGLEFLIGHTS

Search Google Flights for **multi-leg itineraries where each leg has its own
cabin** — outbound in business, return in economy, or a different cabin on
every leg of a multi-city trip.

```
JFK → LHR   business
LHR → CAI   economy
```

Google's own UI has one cabin selector for the whole trip, so it cannot express
that. This tool builds the links that can — and, since it absorbed
[`Adhambadrun/SpicyLinkGenerator`](https://github.com/Adhambadrun/SpicyLinkGenerator),
also builds the links that hand the same trip to an airline.

One itinerary in, four outputs out: **per-leg** Google Flights searches, one
**board** search, **airline** links, and a **Matrix-shaped JSON** document. See
[The unified itinerary](#the-unified-itinerary--four-outputs).

Everything runs offline. Links are constructed locally from airports, dates and
flight numbers — no request is made to Google or to any airline unless you open
a link.

---

## The one thing worth knowing first

**A Google Flights search request carries exactly one cabin for the entire
trip.** There is no per-leg cabin field in the `tfs` token, and no amount of
encoding will create one. Google's UI has a single cabin picker for the same
reason.

**The response, however, is fully per-leg.** Every leg Google returns carries
its own cabin code, and each itinerary carries a flag saying whether it mixes
cabins. Google prices and labels these itineraries — and on a premium search
they are frequently the *cheapest* option on the board.

So mixed-cabin search is a **matching** problem, not an encoding problem. This
tool builds the requests, and gives you the matcher for the results.

Full protocol notes, with provenance and confidence levels: **[PROTOCOL.md](PROTOCOL.md)**.

---

## Quick start

```bash
npm install        # no dependencies — this is a no-op
npm run dev        # http://localhost:8080
npm test           # 90 tests, all offline
```

Open the page, edit the two example legs, hit **Plan mixed-cabin search**.

### Command line

```bash
# one search link
node tools/gf.mjs build --from JFK --to LHR --date 2026-12-01 --cabin business

# the mixed-cabin planner
node tools/gf.mjs plan --legs trip.json

# all four outputs for one itinerary (per-leg, board, airline, Matrix JSON)
node tools/gf.mjs links --legs trip.json
node tools/gf.mjs links --segments gds-trip.json --carrier BA

# what does this token actually ask for?
node tools/gf.mjs decode CBwQAhoeEgoyMDMwLTA5LTE1agcIARIDSkZLcgcIARIDTEFYQAFIAXABmAEC

# which field does a UI control write? (the discovery probe)
node tools/gf.mjs diff <token-before> <token-after>
```

`trip.json`:

```json
{
  "legs": [
    { "from": "JFK", "to": "LHR", "date": "2026-12-01", "cabin": "business" },
    { "from": "LHR", "to": "CAI", "date": "2026-12-08", "cabin": "economy" }
  ]
}
```

`gds-trip.json` — the richer shape that also unlocks the airline and Matrix
outputs, because it names the flights:

```json
{
  "segments": [
    { "origin": "JFK", "dest": "LHR", "ymd": "2026-12-01", "cabin": "business",
      "carrier": "AA", "num": "100", "cls": "J", "depH": 19, "depM": 0, "arrH": 7, "arrM": 0, "plus": true },
    { "origin": "LHR", "dest": "JFK", "ymd": "2026-12-08", "cabin": "economy",
      "carrier": "AA", "num": "101", "cls": "Y", "depH": 11, "depM": 30, "arrH": 14, "arrM": 35 }
  ]
}
```

---

## The three strategies

Every plan returns all three, because they answer different questions and
price differently.

### 1. Per-leg one-ways — *exact cabin control*

One one-way search per leg, each with its own cabin. This is the **only**
request that pins a distinct cabin to each leg.

- ✅ Exact, and the only strategy whose result pages can be parsed offline.
- ❌ Priced as independent one-ways, usually the most expensive route.
- ❌ Separate tickets: no through-checked bags, no protection on a delay.

### 2. Multi-city board — *bundled pricing*

One multi-city search for the whole trip, opened in the **highest** cabin you
asked for. Google prices the trip as a bundle and surfaces mixed-cabin
itineraries in-row.

- ✅ Bundled pricing, and the rows are labelled with their per-leg cabins.
- ❌ The page loads its rows client-side, so the saved HTML has nothing to
  parse. Open this one in a browser.
- ❌ You cannot ask it for "business then economy" — read the per-leg cabins
  off the results instead.

### 3. Board sweep — *widest coverage*

The board once per distinct cabin in your vector, results unioned, then
filtered with the matcher. Google surfaces different itineraries for different
searches, so sweeping finds more.

**Always build 1 and 2 and compare.** On a sampled JFK–LHR–CAI trip the bundled
multi-city fare was **$1,107** versus **$1,484** as two one-ways — same legs,
35% apart. There is no rule for which wins; you have to look.

---

## The unified itinerary — four outputs

`POST /api/links` (and `gf links`) is the join between this repository and
[`Adhambadrun/SpicyLinkGenerator`](https://github.com/Adhambadrun/SpicyLinkGenerator).
Google Flights can *express* a mixed-cabin trip but cannot book it; an airline
can book it but has one cabin selector and, for most carriers, no prefill anyone
has been able to verify. So one itinerary goes in and every option comes back,
each labelled with what it honours and what it cannot express.

| Output type | Honours | Cannot feature |
| --- | --- | --- |
| **Per-leg** | Each leg's own cabin | Bundled pricing |
| **Board** | Highest cabin only | Per-leg detail |
| **Airline links** | Known carrier surface | Pre-filled fare |
| **BookWithMatrix JSON** | Cabin vector + mixed flag | Live pricing |

Those strings are in the payload verbatim, as `honours` / `cannotFeature` on
each strategy — a consumer never has to remember the table.

```bash
curl -s -X POST localhost:8080/api/links -H 'content-type: application/json' \
  -d '{"legs":[{"from":"JFK","to":"LHR","date":"2026-12-01","cabin":"business"},
               {"from":"LHR","to":"CAI","date":"2026-12-08","cabin":"economy"}]}'
```

```js
import { buildUnifiedItinerary } from './lib/unified.js';

const out = buildUnifiedItinerary({ legs, passengers: { adults: 2 } });
out.cabinVector;                          // ['business','economy']
out.mixedCabin;                           // true
out.strategies.perLeg.searches[0].url;    // one-way, business
out.strategies.board.url;                 // multi-city, opened in business
out.strategies.airlineLinks.carriers;     // AA / BA / directory homepages
out.strategies.matrixJson.json;           // itinerary.slices[].segments[]
```

### Airline links, precisely

- **AA** — the historical `/goto/metasearch?ITEN=…` handoff, carrying every leg.
  Pinned by the same sha256 golden SpicyLinkGenerator pins, so the port cannot
  drift. Needs AA-marketed legs with a flight number, a booking class and an
  airport this repo has a timezone for.
- **BA** — **its own empty search form**, with the itinerary spelled out in the
  note so you can type it in. BA has no pre-filled link anyone could verify:
  real-browser runs on 2026-10-12 hung forever on *"Give us a moment, we're
  calculating your price"* (recorded **BLOCKED**), and BA's form ignores every
  prefill parameter probed. `assertNotBlockedBaHandoff()` still refuses to emit
  one, and the legacy builder still rejects anything past two O&D slices.
- **DL / UA** — experimental search prefills, clearly labelled *NOT guaranteed*.
- **Everyone else** — the carrier's homepage from a 66-entry directory that was
  never live-checked. Connections and multi-city trips never collapse into a
  wrong direct search: they fall back to the homepage instead.

No carrier link ever carries a fare, a session id, a passenger name, a passport
number or payment detail in the URL.

### When an output cannot be built, it says so

Nothing is fabricated to fill a hole. Ask for airline links on an itinerary that
names no carrier and you get `available: false` with the reason and a per-leg
list of what is missing — not a guessed airline:

```json
{ "available": false,
  "reason": "No marketing carrier on any leg, so there is no airline to hand this itinerary to…",
  "gaps": [{ "leg": 0, "route": "JFK→LHR", "needs": ["carrier", "flightNumber", "bookingClass"] }] }
```

The same rule covers timestamps: an airport outside the verified zone map gets
**no** Matrix document rather than a made-up UTC offset, and a daylight-saving
gap is refused rather than resolved by picking one of the two hours.

Two cabins rules legitimately disagree, and both are reported rather than one
being silently rewritten — `strategies.board.openInCabin` uses the **highest**
requested cabin (never downgrade a leg you asked to fly premium), while
`strategies.airlineLinks.searchCabin` uses the **most common** cabin, ties to the
higher one (SpicyLinkGenerator's rule for a carrier form with one class
selector). `cabinPolicy` explains the difference in the payload.

Full reasoning, every overlap, every gap and the fidelity evidence:
**[docs/COMBINE-AUDIT.md](docs/COMBINE-AUDIT.md)**.

---

## Matching results against a cabin vector

Save a one-way or round-trip results page from your browser (Right-click →
Save as → HTML Only), then paste it into the **Parse a saved page** tab, or:

```bash
node tools/gf.mjs parse saved-page.html --cabin business,economy
```

Each itinerary is scored leg by leg:

| Status | Meaning |
| --- | --- |
| `exact` | that leg is in exactly the requested cabin |
| `upgraded` | better than requested — accepted as a match |
| `downgraded` | worse than requested — **never** a match |

Then in code:

```js
import { parseResultsHtml, filterByCabinVector } from './lib/results.js';

const { itineraries } = parseResultsHtml(html);
const matches = filterByCabinVector(itineraries, ['business', 'economy']);
```

Cheapest first, exact matches ahead of upgrades.

---

## API

Handlers follow the Vercel `api/` convention, so `npm run dev` and a deploy run
the same code.

| Endpoint | Purpose | Network |
| --- | --- | --- |
| `POST /api/links` | **unified itinerary — all four outputs at once** | offline |
| `POST /api/plan` | mixed-cabin multi-leg plan | offline |
| `POST /api/build` | one `tfs` token + URLs | offline |
| `POST /api/booking` | deep link to one exact itinerary | offline |
| `POST /api/decode` | decode any `tfs` token | offline |
| `POST /api/parse-results` | itineraries out of a saved page | offline |
| `POST /api/search` | fetch a results page | **off unless `GF_LIVE=1`** |

`/api/links` accepts any of three input shapes — `legs[]` (this repo),
`segments[]` (SpicyLinkGenerator / GDS rows) or a Matrix-style `itinerary`
document — and returns 400 with a reason for a malformed itinerary.

```bash
curl -s localhost:8080/api/health

curl -s -X POST localhost:8080/api/plan -H 'content-type: application/json' \
  -d '{"legs":[{"from":"JFK","to":"LHR","date":"2026-12-01","cabin":"business"},
               {"from":"LHR","to":"CAI","date":"2026-12-08","cabin":"economy"}]}'
```

### Live search is off by default

`POST /api/search` is disabled until you set `GF_LIVE=1`. It does one plain,
rate-limited GET of the public results page — the same request your browser
makes when you open a `tfs` link.

It deliberately does **no** proxy rotation, **no** CAPTCHA solving, **no**
browser-fingerprint spoofing, and it never touches the `batchexecute` RPCs
(those are request-signed and not usable; see PROTOCOL.md §1).

Automated querying of Google is against their Terms of Service. Keep any live
use low-volume and personal. The offline endpoints are the main feature — links
and parsing both work with zero requests.

---

## Layout

```
index.html          UI
app.js              front-end (talks only to /api/*)
dev-server.mjs      local server, binds 0.0.0.0:8080
api/                handlers (health, build, plan, links, booking, decode, parse-results, search)
lib/
  protobuf.js       zero-dependency wire codec + describeMessage + diffMessages
  tfs.js            build/decode tfs tokens, search + booking URLs
  results.js        parse saved pages, match itineraries against a cabin vector
  mixed-cabin.js    the three-strategy planner
  booking-link.js   deterministic deep links to one exact itinerary
  unified.js        one itinerary in → four outputs out (the join)
  airline-links.js  AA handoff, BA's blocked-handoff guards, carrier prefills   [ported]
  airline-directory.js  66 candidate carrier homepages                          [ported]
  aa-handoff.js     the AA metasearch envelope + DST-correct airport clock       [ported]
  matrix.js         import and export Matrix-style itinerary JSON          [ported + new]
  live.js           opt-in, rate-limited page fetch
  http.js           tiny request/response helpers
tools/gf.mjs        CLI
tools/CAPTURE.md    how to capture your own tokens and pages
docs/COMBINE-AUDIT.md  overlaps, gaps, divergences and fidelity evidence
test/               90 tests, all offline
PROTOCOL.md         the reverse-engineering notes
```

Files marked `[ported]` come from
[`Adhambadrun/SpicyLinkGenerator`](https://github.com/Adhambadrun/SpicyLinkGenerator).
Every note string, guard and URL shape is preserved verbatim; the seven
deliberate divergences are listed in
[docs/COMBINE-AUDIT.md §5](docs/COMBINE-AUDIT.md).

---

## Tests

```bash
npm test           # 90 tests — 76 original + 14 for the unified itinerary
```

- **34 golden tokens** from real captures, compared **byte for byte** and
  round-tripped. A `tfs` token is bytes on the wire: if the encoder drifts,
  Google does not reject it, it quietly answers a slightly different question.
  So the tests compare bytes, not decoded meaning.
- Decoder tests for multi-airport segments, pinned legs, unknown fields, and
  the passenger-code traps.
- Result-parser and cabin-vector matching tests.
- Planner, booking-link and endpoint tests.
- **14 unified-itinerary tests** (`test/unified.test.js`): both input
  vocabularies, per-leg and board cabin pinning, the AA sha256 golden carried
  over from SpicyLinkGenerator, the BA blocked-handoff guard, Matrix JSON
  round-trip, DST-correct offsets, honest degradation, both passenger
  vocabularies, and the `/api/links` handler's 200 / 400 / 405 paths.
- `/api/links` and `/api/plan` build their tokens through the same planner, and
  a test asserts the bytes are equal — the two endpoints cannot drift apart.

Zero dependencies, zero network.

SpicyLinkGenerator's **own** test suites were also run against the ported
modules: 19 of 20 pass, and the one failure is the deliberate `logoUrl`
divergence (the airline logo assets were not ported). The command to reproduce
that check is in [docs/COMBINE-AUDIT.md §4](docs/COMBINE-AUDIT.md).

---

## Verification status

The encoder is byte-exact against 34 real captured tokens — the strongest
offline check available. It has **not** been confirmed against live Google from
the environment this was built in, which has no outbound access to
`google.com` — and no outbound access to any airline site either. Every link
this tool emits, Google or airline, is therefore **unverified until a human
opens it**.

### Validation checklist

Run this by hand once per route family before relying on generated links. Each
step exists because something in the chain could be quietly wrong while every
test still passes.

**Google Flights links**

- [ ] Open a **per-leg** link. Does the board show a one-way search for exactly
      that leg, in exactly that leg's cabin? (Check the cabin picker, not just
      the rows.)
- [ ] Open the **board** link. Are all legs present as separate rows of the
      multi-city form, with the right dates and airports?
- [ ] Is the board opened in the **highest** requested cabin, as
      `openInCabin` claims?
- [ ] On a premium search, do any result rows show **mixed cabins**? Read the
      per-leg cabin labels off the row and compare with `cabinVector`.
- [ ] Save a one-way results page and run `gf parse saved.html --cabin …`. Do
      the matched itineraries agree with what the page shows? (Multi-city pages
      load rows client-side and cannot be parsed — that is expected, not a bug.)
- [ ] Do the per-leg fares and the bundled board fare differ? By how much?
      Record it; there is no rule for which wins.

**Airline links**

- [ ] **AA**: does the metasearch link land on a flight-selection page showing
      *every* leg? On a mixed-carrier trip, are the non-AA legs pinned at all?
      (They may not be — the note says so.)
- [ ] **BA**: does the search form open, and does typing the itinerary from
      `manualEntryHint` produce results? The form opens **empty** by design.
      If a BA link ever arrives pre-filled, treat it as a regression —
      `assertNotBlockedBaHandoff()` should have thrown.
- [ ] **DL / UA**: does the prefill populate origin, destination and dates?
      Cabin and passenger counts are *not* guaranteed.
- [ ] **Homepage fallbacks**: is the carrier in the directory still the right
      one, and does the host still resolve? The 66 entries were never
      live-checked and ownership changes.
- [ ] Confirm no URL contains a fare, a session id, or any passenger identity
      detail. Tests assert this; eyeball it anyway.

**Matrix JSON**

- [ ] `roundTrips: true` only proves *this repository's* importer accepts the
      document. If you rely on the real BookWithMatrix service, import one
      document there and record what it accepted — that acceptance test does not
      exist yet, and shaped JSON alone is not proof.
- [ ] Check one timestamp against a real schedule: the offset must be the
      airport's *actual* offset on that date, daylight saving included.
- [ ] The document carries **no price**. If a consumer displays one, it did not
      come from here.

Anything that fails a box above is a finding worth an issue: it means a link
this tool builds does not do what the payload claims.

## Scope

Built for research into how Google Flights represents a search, and into what an
airline website can actually be handed. It constructs URLs you could assemble by
hand from a captured token or a carrier's documented search form, and reads data
your own browser already downloaded. It does not bypass anything: no credentials,
no signed-RPC replay, no anti-bot evasion. Airline links are search handoffs —
never a cart, a held seat or a fare.

## Credits

Protocol work cross-checked against `punitarani/fli`, `AWeirdDev/flights` and
`google-flights-ts`.

The airline-link half — `lib/airline-links.js`, `lib/airline-directory.js`,
`lib/aa-handoff.js` and the Matrix importer in `lib/matrix.js` — is ported from
[`Adhambadrun/SpicyLinkGenerator`](https://github.com/Adhambadrun/SpicyLinkGenerator),
including its recorded findings: the AA metasearch envelope, the 66-carrier
directory, and BA's **BLOCKED** offer-search handoff with the guards that keep it
from coming back. Ported files, fidelity evidence and the seven deliberate
divergences are itemised in [docs/COMBINE-AUDIT.md](docs/COMBINE-AUDIT.md).
