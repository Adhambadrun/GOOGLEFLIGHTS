# GOOGLEFLIGHTS

Search Google Flights for **multi-leg itineraries where each leg has its own
cabin** — outbound in business, return in economy, or a different cabin on
every leg of a multi-city trip.

```
JFK → LHR   business
LHR → CAI   economy
```

Google's own UI has one cabin selector for the whole trip, so it cannot express
that. This tool builds the links that can.

Everything runs offline. Links are constructed locally from airports, dates and
flight numbers — no request is made to Google unless you open a link.

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
npm test           # 76 tests, all offline
```

Open the page, edit the two example legs, hit **Plan mixed-cabin search**.

### Command line

```bash
# one search link
node tools/gf.mjs build --from JFK --to LHR --date 2026-12-01 --cabin business

# the mixed-cabin planner
node tools/gf.mjs plan --legs trip.json

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
| `POST /api/plan` | mixed-cabin multi-leg plan | offline |
| `POST /api/build` | one `tfs` token + URLs | offline |
| `POST /api/booking` | deep link to one exact itinerary | offline |
| `POST /api/decode` | decode any `tfs` token | offline |
| `POST /api/parse-results` | itineraries out of a saved page | offline |
| `POST /api/search` | fetch a results page | **off unless `GF_LIVE=1`** |

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
api/                handlers (health, build, plan, booking, decode, parse-results, search)
lib/
  protobuf.js       zero-dependency wire codec + describeMessage + diffMessages
  tfs.js            build/decode tfs tokens, search + booking URLs
  results.js        parse saved pages, match itineraries against a cabin vector
  mixed-cabin.js    the three-strategy planner
  booking-link.js   deterministic deep links to one exact itinerary
  live.js           opt-in, rate-limited page fetch
  http.js           tiny request/response helpers
tools/gf.mjs        CLI
tools/CAPTURE.md    how to capture your own tokens and pages
test/               76 tests, all offline
PROTOCOL.md         the reverse-engineering notes
```

---

## Tests

```bash
npm test
```

- **34 golden tokens** from real captures, compared **byte for byte** and
  round-tripped. A `tfs` token is bytes on the wire: if the encoder drifts,
  Google does not reject it, it quietly answers a slightly different question.
  So the tests compare bytes, not decoded meaning.
- Decoder tests for multi-airport segments, pinned legs, unknown fields, and
  the passenger-code traps.
- Result-parser and cabin-vector matching tests.
- Planner, booking-link and endpoint tests.

Zero dependencies, zero network.

---

## Verification status

The encoder is byte-exact against 34 real captured tokens — the strongest
offline check available. It has **not** been confirmed against live Google from
the environment this was built in, which has no outbound access to
`google.com`. Open a generated link and confirm the board shows the trip you
asked for before relying on it.

## Scope

Built for research into how Google Flights represents a search. It constructs
URLs you could assemble by hand from a captured token, and reads data your own
browser already downloaded. It does not bypass anything: no credentials, no
signed-RPC replay, no anti-bot evasion.

## Credits

Protocol work cross-checked against `punitarani/fli`, `AWeirdDev/flights` and
`google-flights-ts`. UI conventions follow `Adhambadrun/SpicyLinkGenerator`.
