# Capturing real `tfs` tokens and result pages

Everything in this repo is offline, so its ground truth comes from captures you
make yourself. Two things are worth capturing:

1. a **`tfs` token** — proves what Google emits for a given search,
2. a **saved results page** — gives the decoder real rows to parse.

Both are one minute of DevTools.

---

## 1. Capture a `tfs` token

1. Open <https://www.google.com/travel/flights>.
2. Set up the search you care about (route, dates, cabin, passengers, stops).
3. Click **Search**. The URL becomes:
   ```
   https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDMwLTA5LTE1…&hl=en&gl=US
   ```
4. Copy everything between `tfs=` and the first `&`.
5. Decode it:
   ```bash
   node tools/gf.mjs decode CBwQAhoeEgoyMDMwLTA5LTE1agcIARIDSkZLcgcIARIDTEFYQAFIAXABmAEC
   ```

### Discovering what a control does (the `diff` probe)

Change **one** thing in the UI at a time and capture the token before and after.
Then:

```bash
node tools/gf.mjs diff <token-before> <token-after>
```

Whichever field number changes is the field that control writes. That is how
the field map in `PROTOCOL.md` was assembled, and it is how you extend it when
Google ships something new:

- switch cabin economy → business → field **9** moves (1 → 3),
- switch round-trip → one-way → field **19** moves (1 → 2),
- add a traveller → another field **8** entry appears,
- set "1 stop or fewer" → field **5** appears inside the segment (value 1),
- pin a specific flight → field **4** appears inside the segment.

If a field moves that the schema does not know, `decode` still shows it under
`unknownFields`, and `diff` shows it under `changed`.

---

## 2. Capture a results page

1. Run a **one-way or round-trip** search (not multi-city — see below).
2. Wait for the list to finish loading.
3. Right-click → **Save page as…** → **Webpage, HTML Only**.
4. Parse it:
   ```bash
   node tools/gf.mjs parse ~/Downloads/JFK-LHR.html --cabin business,economy
   ```

### Why not multi-city?

Google loads multi-city results **client-side**, through the
`FlightsFrontendService` RPC. The saved HTML of a multi-city page contains no
`ds:1` rows at all, so there is nothing to parse — the parser reports
`noPayload` and says so rather than pretending the trip has no flights.

Two consequences worth internalising:

- The multi-city **link** still works perfectly. Open it in a browser and the
  board renders. Only machine-parsing of that page is unavailable.
- To get parsable rows for a multi-leg trip, search each leg as its own
  one-way. This is exactly what the `per-leg` strategy in `lib/mixed-cabin.js`
  does — and it is the only strategy that pins a different cabin to each leg.

---

## 3. Capture a booking deep link

1. In the results list, click the itinerary you want.
2. On the booking page the URL is:
   ```
   https://www.google.com/travel/flights/booking?tfs=ANd9GcQGx8ii2KbSDdbdz…
   ```
3. `node tools/gf.mjs decode <that token>` shows the pinned legs (field 3.4)
   and the field-16 pin.

Booking tokens are deterministic — same flights, same URL — so they are safe to
store and share.

---

## Keeping captures out of git

`captures/` is git-ignored. Saved pages carry real dates, prices and sometimes
session identifiers; keep them local.
