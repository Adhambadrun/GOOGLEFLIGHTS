# Combine audit — GOOGLEFLIGHTS × SpicyLinkGenerator

What the two repositories already agreed on, where they genuinely disagreed, what
the combination still cannot do, and the evidence for each claim.

Companion to `lib/unified.js` and `POST /api/links`. Written before the merge so
that a reviewer can check the reasoning rather than take the payload's word for it.

---

## 1. What each side contributed

| | GOOGLEFLIGHTS | SpicyLinkGenerator |
| --- | --- | --- |
| Question it answers | how to **search** a trip whose legs have different cabins | how to **hand a known trip to a carrier** |
| Input vocabulary | `legs[] {from, to, date, cabin}` | `segments[] {origin, dest, ymd, carrier, num, cls, depH…}` or Matrix JSON |
| Cabin model | `tfs` field 9, codes 1–4, whole-search only | RBD letters, per-carrier class maps, one class per search form |
| Strongest asset | byte-exact `tfs` encoder (34 goldens) + per-leg result matcher | recorded carrier behaviour: AA envelope, BA **BLOCKED**, 66-carrier directory |
| Blind spot | cannot reach any airline | cannot express per-leg cabin at all |

Neither is complete alone. Google Flights can *express* "business then economy"
but cannot book it; a carrier link can book but has one cabin selector and, for
most carriers, no verifiable prefill. `lib/unified.js` takes one itinerary and
returns all four things you can do with it.

---

## 2. Overlaps found

Things both repositories independently implemented. Each row says how the
combination resolved it — and, where they disagreed, why neither side was
overruled.

| # | Concept | GOOGLEFLIGHTS | SpicyLinkGenerator | Resolution |
| --- | --- | --- | --- | --- |
| 1 | **One cabin per search** | The core finding: `tfs` field 9 is whole-trip, there is no per-leg cabin field | `gfSearchGroup()`: "Google Flights accepts one cabin per search, so a mixed-cabin itinerary cannot be preserved leg by leg" | Same conclusion reached independently from opposite directions (protocol vs. UI). Stated once, in `lib/unified.js`'s header. |
| 2 | **Which single cabin to use** | `board` opens in the **highest** requested cabin — never downgrades a leg you asked to fly premium | `itinerarySearchCabin()` picks the **most common** cabin, ties to the higher one | **Genuinely different, both defensible.** Neither was rewritten. `strategies.board.openInCabin` carries *highest*, `strategies.airlineLinks.searchCabin` carries *most common*, and `cabinPolicy` states both rules and when they disagree (business + economy + economy → business vs. economy). |
| 3 | Cabin vocabulary | `SEAT` 1–4; `economy / premium-economy / business / first` | `COACH / PREMIUM-COACH / BUSINESS / FIRST`; per-carrier RBD maps (`BA_CABIN_MAP`) | Two explicit maps, no implicit coercion: `SURFACE_TO_SEAT` (unified.js) inbound, `matrixCabinWord()` (matrix.js) outbound. Upstream's RBD→cabin inference is reused, not reimplemented. |
| 4 | Cabin precedence | requested cabin is authoritative | cabin is *inferred* from the RBD letter | Requested cabin wins, RBD is the fallback. Per-leg cabin control is the reason the combined tool exists, so an explicit request outranks an inference. Recorded as divergence D1. |
| 5 | Passenger vocabulary | `{adults, children, infantsOnLap, infantsInSeat}`; 9-traveller ceiling; infant codes settled from live-pricing evidence | `{adults, seniors, youths, children, infantsInSeat, infantsInLap}` — all six **must** be integers or the AA builder throws | `normalizePassengers()` returns **both** shapes (`google`, `spicy`) so each consumer gets the object it validates against. |
| 6 | Seniors / youths | No such concept — `tfs` field 8 has only adult, child, infant-on-lap, infant-in-seat | Counted separately, then folded into adults by `counts()` | Folded into `google.adults` for tokens only (the same fold upstream does), kept separate in `spicy`, and **warned about** in `warnings[]`. |
| 7 | Airport code validation | `/^[A-Za-z0-9]{2,3}$/` — 2 chars allowed (city codes) | `/^[A-Z]{3}$/` for BA and Matrix, `/^[A-Z0-9]{2}$/` for carriers | Kept apart on purpose. A 2-character city code still builds a Google link and is reported as a *gap* for carrier and Matrix outputs, rather than being rejected outright or silently padded. |
| 8 | Direction vs. connection | one `legs[]` entry = one travel direction; connections are pinned legs inside it | `baSliceIndex()` collapses connection legs into O&D slices on a route break or a >24 h gap | `sliceIndex()` exported and **shared** with `lib/matrix.js`, so BA's typed instructions and the Matrix document cannot disagree about where one direction ends. Divergence D2. |
| 9 | "The one Google Flights link" | the whole repository — a real `tfs` token | `gfSearchGroup()` — a described alternative search, no token | GOOGLEFLIGHTS supersedes it: the board link carries an actual token. `thirdPartySearch` is still reported for parity with upstream's UI contract. |
| 10 | API conventions | `api/*.js` + `safe()` / `methodGuard()` / `sendJson()`, `vercel.json` no-store | `api/*.js`, `dev-server.mjs`, `vercel.json` | Already the same convention (the README credits it). `/api/links` uses GOOGLEFLIGHTS' helpers and returns 400 for a malformed itinerary, 405 for the wrong verb. |
| 11 | Offline by default | live fetch off unless `GF_LIVE=1`; no proxies, no CAPTCHA solving, no fingerprint spoofing | no live fetch at all — carrier evidence came from manual browser runs | `/api/links` makes **zero** network requests. Nothing in the combination added a fetch. |
| 12 | Honesty conventions | byte-exact goldens; an explicit "verification gap" section | outcomes recorded as BLOCKED with dates; "a URL is not proof of a fare" | Both preserved and reconciled in `verification` on every payload, so a consumer cannot read a link as a confirmed result. |

---

## 3. Gaps — what the combination still cannot do

Ordered by how much they limit the tool.

1. **No generated link has been confirmed live.** This sandbox has no outbound
   access to `google.com`. The 34 byte-exact `tfs` goldens are the strongest
   offline check that exists: they prove the encoder has not drifted, not that
   Google still renders the token. Open a link before relying on it.
2. **No carrier site was reached either.** Every airline URL is unverified until
   opened in a browser. BA's BLOCKED status and the "form ignores every prefill
   parameter" finding are upstream's recorded real-browser runs of **2026-10-12**
   — they were *preserved*, not re-run here.
3. **BookWithMatrix acceptance is not proven.** What *is* proven: the emitted
   document round-trips through this repository's Matrix importer
   (`roundTrips: true`, asserted in test 9). Upstream's own
   `IMPLEMENTATION_BRIEF.md` requires a documented fixture and an actual
   acceptance test before claiming BookWithMatrix compatibility, and neither
   exists. Hence `roundTrips`, never `bookWithMatrixVerified`.
4. **Per-leg cabin still cannot be requested in one bundled search.** That is a
   property of Google's protocol (`tfs` field 9 is whole-trip), not a shortfall
   of this code. Combining the repositories does not change it, and no output
   claims otherwise.
5. **Carrier links need data GOOGLEFLIGHTS never asked for** — carrier, flight
   number, booking class, departure/arrival times. GF-style input therefore
   yields **2 of 4** outputs; `airlineLinks` and `matrixJson` come back
   `available: false` with a per-leg list of what is missing. Nothing is invented
   to close the gap: a guessed carrier or a synthesised booking class would look
   valid and be wrong.
6. **Only 40 airports have a verified IANA zone mapping.** Any other airport
   cannot get an offset-bearing timestamp, so no Matrix document and no AA
   handoff — both fail closed with a reason rather than assume UTC or the
   visitor's timezone.
7. **No airport or city name database.** Matrix output carries IATA codes only.
   Upstream's exporter fills in names; this repository would have to invent them.
8. **No prices anywhere.** The per-leg vs. bundled comparison (upstream sample:
   $1,107 bundled vs. $1,484 as two one-ways on identical JFK–LHR–CAI legs)
   still has to be made by a human in a browser.
9. **The UI is not wired.** `index.html` / `app.js` still drive `/api/plan` only.
   `/api/links` is reachable from the API and from `gf links` on the CLI. Wiring
   a fourth output panel into the single-page UI is separate work.
10. **No auth was ported.** Upstream gates its UI behind an OTP approval flow
    (`lib/core.js`, `lib/mailer.js`, domain-locked to two domains, with a
    hardcoded default `AUTH_SECRET` that upstream itself warns must be replaced).
    GOOGLEFLIGHTS has no auth. Adding an approval-email gate is a security and
    deployment decision, not a combination — see §5.

---

## 4. Fidelity evidence

The ported carrier logic had to keep producing the links upstream produced, or
the combination would quietly change behaviour that upstream pinned with
recorded browser evidence.

| Check | Result |
| --- | --- |
| **AA URL golden checksum** — upstream's own sha256 for `AA123 JFK→LAX 2026-11-12 15:45 K`, 1 adult, reproduced *through the unified path* | `76249debd11fd0238540fb99ebcb73754c2fa9a519a53f27a1acabca1cfbb268` — identical (test 5) |
| **Upstream's own test suites run against the ports** (`aa-handoff`, `airline-links`, `airline-directory`, `booking-tools`) | **19 / 20 pass.** The one failure is divergence D5 (`logoUrl`), by design |
| **GOOGLEFLIGHTS' 76 pre-existing tests** | unchanged, all pass; 34 `tfs` goldens still byte-exact |
| **`/api/links` cannot drift from `/api/plan`** | both build tokens through `planMixedCabin`; test 4 asserts byte equality of the board token and of every per-leg token |
| **BA blocked handoff cannot reappear** | `assertNotBlockedBaHandoff()` retained; test 6 asserts no `processOffer` / `search-journey-id` / `cid=` in any emitted BA URL, and that the 3-slice gate still throws |
| **Network** | zero requests from any test, any endpoint, or the CLI |

Reproduce the upstream port check:

```bash
git clone --depth 1 https://github.com/Adhambadrun/SpicyLinkGenerator /tmp/spicy
mkdir -p /tmp/portcheck/test && cd /tmp/portcheck
echo '{"type":"module"}' > package.json
cp ~/GOOGLEFLIGHTS/lib/aa-handoff.js ~/GOOGLEFLIGHTS/lib/airline-links.js \
   ~/GOOGLEFLIGHTS/lib/airline-directory.js ~/GOOGLEFLIGHTS/lib/tfs.js \
   ~/GOOGLEFLIGHTS/lib/protobuf.js .
cp ~/GOOGLEFLIGHTS/lib/matrix.js booking-tools.js
cp /tmp/spicy/test/{aa-handoff,airline-links,airline-directory,booking-tools}.test.mjs test/
node --test test/*.test.mjs          # → 19 pass, 1 fail (D5)
```

---

## 5. Deliberate divergences

Everything the ports do differently from upstream, and why. Nothing else changed.

| | Change | Reason |
| --- | --- | --- |
| **D1** | `segmentCabin(carrier, cls, cabinName?)` exported, third argument added | Upstream infers cabin **only** from the RBD letter, so a leg with no booking class reported `COACH`. In this repository that would tell a user to type *"economy"* into BA's form for a leg they asked to fly in **business**. When `cabinName` is absent the behaviour is byte-identical to upstream. Test 6 pins the corrected hint. |
| **D2** | `sliceIndex()` exported (upstream's private `baSliceIndex`) | `lib/matrix.js` groups Matrix slices with it, so the Matrix document and BA's typed instructions can never disagree about O&D boundaries. No behaviour change. |
| **D3** | `parseMatrixInput()` also returns `departureIso` / `arrivalIso` | Upstream kept the epoch and the wall-clock parts but dropped the **offset** — the one part an exporter must not re-derive. Additive; upstream's importer tests still pass. |
| **D4** | Matrix **export** omits `pricings`, `tickets`, `fares`, `taxTotals`, `displayTotal` | Upstream's `buildCompleteJson` synthesises fare basis, fare construction, taxes and a total — which upstream's own `IMPLEMENTATION_BRIEF.md` flags as "not suitable for ticketing or live fare validation". This tool has no fare data at all. An itinerary with no price is honest; a plausible-looking price is not. Test 11 asserts no money-shaped key survives. |
| **D5** | `logoUrl` is always `null` | The 66 bundled airline SVGs (and their `SOARING-LICENSE.txt` / `ATTRIBUTION.md`) were **not** ported — nothing in this repository renders a carrier logo. The field is kept so the shape matches, and left empty: emitting a path to a file that does not exist would be a dead reference. This is the single upstream test that fails against the port. |
| **D6** | Matrix export gives IATA codes only, no `city.name` / airport `name` | No airport name database here. Upstream has one; inventing names would be fabricating data. |
| **D7** | The board sweep lives at `strategies.board.sweep`, not as a fifth strategy | GOOGLEFLIGHTS' third strategy (the board once per distinct cabin) *is* a board variant — same multi-city token, different seat field. Nesting it keeps the four documented output types without losing the sweep. |

**Not ported**, deliberately:

- `lib/core.js`, `lib/mailer.js`, `api/{request-code,session,verify}.js` — the
  OTP approval gate. Porting it would put an email-sending, domain-locked
  authentication layer into a repository that has none, and would carry upstream's
  hardcoded default `AUTH_SECRET` with it.
- `app.html`, `index.html`, `deploy-kit/` — upstream's single-page UI and its
  bundled deploy copies.
- `seatmap.js`, `seatmap_layouts.js` — seat maps, unrelated to link generation.
- `tools/ba-live-probe.mjs` (51 KB) and `gh-workflow-ba-live-probe.yml` — the
  probe that produced BA's BLOCKED finding. Its *conclusions* are ported and
  enforced; re-running it needs a browser and outbound access this sandbox lacks.
- `AA_ACCEPTANCE.md`, `FIRST_CABIN_NOTES.md`, `IMPLEMENTATION_BRIEF.md`,
  `Dead end.jpg`, `logo.png`, the two `.zip` bundles — evidence and artefacts.
  The findings that matter are quoted in `lib/airline-links.js` where the guard
  that enforces them lives.

---

## 6. Ported modules

| File | From | Lines | Changed |
| --- | --- | --- | --- |
| `lib/airline-directory.js` | `airline-directory.js` | 78 | D5 |
| `lib/aa-handoff.js` | `aa-handoff.js` | 129 | comments, `hasZone()` / `zoneMappedAirports` added |
| `lib/airline-links.js` | `airline-links.js` | 365 | D1, D2, comments |
| `lib/matrix.js` | `booking-tools.js` + new exporter | 255 | D3, D4, D6; `buildMatrixItinerary` and `isoAtAirport` are new |
| `lib/unified.js` | new | 481 | — |
| `api/links.js` | new | 44 | — |

Every note string, guard, URL shape and recorded date in the ported carrier
modules is preserved verbatim, because those strings carry evidence
(real-browser runs, rendering probes) and the guards are the reason a blocked BA
handoff cannot reappear.
