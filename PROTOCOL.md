# The Google Flights `tfs` protocol

Notes from reverse-engineering how Google Flights encodes a search into a URL,
and what that means for **searching different cabins on different legs**.

Everything here was derived from public captures and from cross-checking three
independent open-source implementations. Nothing required credentials, and
nothing here touches Google's internal RPCs.

---

## 1. What `tfs` is

A Google Flights search is one protobuf message, url-safe-base64'd, passed as
the `tfs` query parameter:

```
https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDMwLTA5LTE1…&hl=en&gl=US
```

Give Google a valid token and it renders the results page directly — no form
interaction, no session, no API key. The token is stateless and deterministic:
the same inputs always produce the same bytes.

Base64 is URL-safe and unpadded. `toBase64Url` / `fromBase64Url` in
`lib/protobuf.js` handle the `-`/`_` swap and the missing `=`.

### Transport

There are two ways to get results, and only one of them is usable:

| Path | Status |
| --- | --- |
| Public results page, `GET /travel/flights/search?tfs=…` | **Works.** Results are inlined in the HTML. |
| `FlightsFrontendService` RPC via `/_/FlightsFrontendService/data/batchexecute` | Gated by the `x-goog-batchexecute-bgr` header since roughly 2026-08. |

The RPC header is a signature computed over the exact request bytes. Change a
single byte of the body and the server answers error 13. There is no published
key and no legitimate way to compute it, so replaying captured RPC traffic is a
dead end — and the page does not need it anyway.

The page inlines its results in a script blob:

```js
AF_initDataCallback({key: 'ds:1', hash: '…', data:[…], sideChannel: {}});
```

The blob's `data` has the same shape the old RPC returned, so parsing the page
offline gets you the same data the RPC would have. Rows live at
`payload[2][0]` and `payload[3][0]`.

One operational note: roughly 1 in 60 page fetches comes back HTTP 200 with no
`ds:1` at all. That is a transient rendering hiccup, not a block — retry, with
backoff, and only retry that specific condition.

---

## 2. Field map

### Top level

| Field | Wire | Meaning |
| --- | --- | --- |
| 1 | varint | constant `28` |
| 2 | varint | constant `2` |
| 3 | message | **segment** — one per travel direction, repeated |
| 8 | varint | **passenger** — one entry per traveller, repeated |
| 9 | varint | **cabin class** — the whole trip, see below |
| 14 | varint | constant `1` |
| 16 | fixed64-ish | booking pin (deep links only), see §6 |
| 19 | varint | **trip type** — 1 round-trip, 2 one-way, 3 multi-city |

**Cabin (field 9):** `1` economy, `2` premium economy, `3` business, `4` first.
The same numbering is reused for the per-leg cabin in results (§5) — handy,
because it means one enum serves both.

### Segment (inside field 3)

| Field | Wire | Meaning |
| --- | --- | --- |
| 2 | string | departure date, `YYYY-MM-DD` |
| 4 | message | **pinned physical leg**, repeated |
| 5 | varint | stop ceiling — **zero-based**, see below |
| 6 | string | carrier include, repeated |
| 7 | string | carrier exclude, repeated |
| 13 | message | origin airport, repeated |
| 14 | message | destination airport, repeated |
| 15 | string | layover airport include, repeated |
| 17 | varint | minimum layover, minutes |
| 18 | varint | maximum layover, minutes |

Airport sub-message: `1` = constant `1`, `2` = IATA code.

### Pinned leg (inside field 3.4)

| Field | Wire | Meaning |
| --- | --- | --- |
| 1 | string | origin IATA |
| 2 | string | date |
| 3 | string | destination IATA |
| 5 | string | airline IATA |
| 6 | string | flight number |

### Envelope order

Byte order matters for byte-exact parity with Google's own output, even though
protobuf does not require it:

```
f1, f2, [f3…], [f8…], f9, f14, [f16], f19
```

The three constants (`f1=28`, `f2=2`, `f14=1`) are cosmetic — a token without
them is accepted. They are emitted by default anyway (`flavor: 'google'`),
because matching what Google itself sends is the safer bet, and because the
regression tests compare against real captures.

### Traps

**Field 5 is zero-based.** `0` means *non-stop*, `1` means *one stop or fewer*.
To ask for "any number of stops" you **omit the field entirely**. Writing `0`
for "any" silently pins the search to non-stop — a plausible-looking token that
returns the wrong answer. This is the single easiest way to get a wrong result
without any error.

**Passenger codes:** `1` adult, `2` child, `3` infant on lap, `4` infant in
seat. The two infant codes are exactly where the community's published protos
disagree — `fast-flights`' proto has 3 and 4 swapped. The live-pricing evidence
(an infant priced at ~10% of the adult fare for code 3, ~100% for code 4) says
3 = lap, 4 = seat, and that is what this repo follows. Getting it backwards
produces a valid search that quotes the wrong fare. Max 9 travellers; an empty
mix still sends one adult.

**Multi-airport searches** repeat fields 13 and 14 — one entry per airport. A
decoder that reads only the first silently drops the rest of the search.

---

## 3. The core finding: one cabin per *request*

Field 9 sits at the **top level**. There is no per-segment cabin field, and no
per-leg one. Google's own UI has a single cabin selector for the same reason.

So there is **no token that says "leg 1 in business, leg 2 in economy."** That
is not a gap in this implementation — the field does not exist.

What *is* per-leg is the **response**. Every leg Google returns carries its own
cabin code, and the row carries a flag saying the itinerary mixes cabins. This
is what turns mixed-cabin search from an encoding problem into a matching
problem. See §5.

---

## 4. What cannot be encoded

These UI controls do not exist in `tfs`. They are applied by the page
client-side, so a token cannot express them:

- airline include/exclude (only via the *carrier* fields, which are alliance-aware)
- maximum trip duration
- price cap
- departure / arrival time windows
- `emissions`, `bags`, `exclude_basic_economy` — no known field at all

Alliances go in the same carrier lists as airlines, by name:
`ONEWORLD`, `STAR_ALLIANCE`, `SKYTEAM`.

---

## 5. Result shape

Rows live at `payload[2][0]` and `payload[3][0]`.

### Row

| Index | Meaning |
| --- | --- |
| `row[0]` | detail block |
| `row[1]` | price block `[[…, price], currency_token]` |
| `row[8]` | booking token |
| `row[10]` | **mixed-cabin flag** |

The price head is sometimes empty (`[[], token]`). That is Google saying "no
shopping-list price for this row" — routine on premium round-trips, especially
with several travellers, where the board shows "from $X" and the real fare only
appears once you open the itinerary. Parse it as `price = null`; do not guess.

The currency is inside the token, itself a protobuf: field 3 → nested field 3
→ the ISO code. See `currencyFromPriceToken` in `lib/results.js`.

### Detail block (`row[0]`)

| Index | Meaning |
| --- | --- |
| 0 | primary airline code |
| 1 | airline names |
| 2 | legs |
| 9 | total duration, minutes |
| 12 | self-transfer flag |
| 13 | layover info |

### Leg

| Index | Meaning |
| --- | --- |
| 3 / 6 | origin / destination IATA |
| 4 / 5 | origin / destination name |
| 8 + 20 | departure time `[h,m]` + date `[y,m,d]` |
| 10 + 21 | arrival time + date |
| 11 | duration, minutes |
| **16** | **cabin — 1..4, same numbering as field 9** |
| 17 | aircraft |
| 19 | overnight flag |
| 22 | `[airline code, flight number, operating airline]` |
| 31 | CO₂, grams |

`leg[16]` and `row[10]` together are what make mixed-cabin search possible.

### Multi-city has no parsable rows

A multi-city page renders fine in a browser, but its HTML carries **no** `ds:1`
rows — Google loads them client-side through the gated RPC. Two consequences:

- The multi-city **link** works. Only machine-parsing of that page is
  unavailable.
- To get parsable rows for a multi-leg trip, search each leg as its own
  one-way. That is what the `per-leg` strategy does, and it is the only
  strategy that both pins a distinct cabin per leg *and* yields parseable rows.

---

## 6. Booking deep links

```
https://www.google.com/travel/flights/booking?tfs=…
```

A booking token pins each physical flight (field 3.4) and adds the field-16
pin: a length-delimited field containing a single varint holding `2^64-1`.
Without it the URL opens as a plain search, not a booking page.

Two details:

- **Field 19 is 2 for a single-segment booking and 1 for anything with more
  segments, multi-city included.** It is *not* the 1/2/3 trip enum.
- The `tfu` parameter the Google UI emits alongside `tfs` is **not** needed.

Because nothing session-dependent goes in, booking links are deterministic —
same flights, same URL, forever. Safe to store and share.

---

## 7. How the field map was derived, and how to extend it

The method is a **diff probe**. Capture a token, change exactly one control in
the UI, capture again, and diff the two byte streams. Whichever field moved is
the field that control writes:

```bash
node tools/gf.mjs diff <token-before> <token-after>
```

- switch economy → business → field **9** moves,
- switch round-trip → one-way → field **19** moves (1 → 2),
- add a traveller → another field **8** entry appears,
- set "1 stop or fewer" → field **5** appears inside the segment (value 1),
- pin a specific flight → field **4** appears inside the segment.

`lib/protobuf.js` exposes this as `diffMessages(a, b)`, and it compares
**values**, not field counts — a count-only diff misses most real changes.

When Google ships something new, the same probe tells you what it is. Decoding
surfaces fields this schema does not know under `unknown` rather than dropping
them, and `/api/decode` re-encodes and reports `roundTrip.matches`; if that is
ever `false`, the schema is missing something and `unknown` is where to look.

`tools/CAPTURE.md` walks through capturing tokens and pages.

---

## 8. Confidence

| Area | Status |
| --- | --- |
| Field numbers, types, envelope order | **Byte-verified** — 34 captured tokens, encoder output matches exactly and round-trips |
| Cabin / trip / passenger enum values | **Verified** against captures and live pricing |
| Result row + leg index map | **Verified** against captured pages |
| Booking pin, field-19 quirk | **Verified** against captured booking links |
| Zero-based stops, "any" = omit | **Verified** — and the most dangerous trap |
| Field 1/2/14 constants | Cosmetic; Google accepts tokens without them |
| `emissions` / `bags` / `exclude_basic_economy` | **No known encoding** |
| RPC access | **Blocked** by request signing; not used |

### Verification gap

The encoder is verified byte-for-byte against real captures, which is the
strongest offline check available. It has **not** been confirmed against live
Google from the environment this was built in — that sandbox has no outbound
access to `google.com`. Before relying on a link, open one and confirm the
board renders the trip you asked for. `tools/CAPTURE.md` explains how.

---

## References

- `punitarani/fli` — the most current public implementation of the search-page
  transport; source of the golden tokens in `test/goldens.js`.
- `AWeirdDev/flights` (`fast-flights`) — published proto, useful but has the
  two infant codes swapped.
- `google-flights-ts` — independent encoder; does not emit the placeholder or
  the price/baggage fields.
