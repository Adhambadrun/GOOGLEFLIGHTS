// Front-end. Talks only to this app's own /api/* endpoints, which are offline
// (except /api/search, which is off by default and never called from here).

const $ = (id) => document.getElementById(id);
const CABINS = ['economy', 'premium-economy', 'business', 'first'];

let legCount = 0;

// ---------------------------------------------------------------------------
// Itinerary builder
// ---------------------------------------------------------------------------

function addLeg(leg = {}) {
  const index = legCount++;
  const row = document.createElement('div');
  row.className = 'leg';
  row.dataset.index = String(index);
  row.innerHTML = `
    <span class="idx">${index + 1}</span>
    <div class="field">
      <label>From</label>
      <input class="code from" maxlength="3" placeholder="JFK" value="${esc(leg.from ?? '')}">
    </div>
    <div class="field">
      <label>To</label>
      <input class="code to" maxlength="3" placeholder="LHR" value="${esc(leg.to ?? '')}">
    </div>
    <div class="field">
      <label>Date</label>
      <input class="date" type="date" value="${esc(leg.date ?? '')}">
    </div>
    <div class="field">
      <label>Cabin</label>
      <select class="cabin">
        ${CABINS.map((c) => `<option value="${c}"${c === (leg.cabin ?? 'economy') ? ' selected' : ''}>${label(c)}</option>`).join('')}
      </select>
    </div>
    <button type="button" class="remove" title="Remove this leg">Remove</button>`;
  row.querySelector('.remove').addEventListener('click', () => {
    row.remove();
    renumber();
  });
  $('legs').appendChild(row);
  return row;
}

function renumber() {
  [...$('legs').children].forEach((row, i) => {
    row.querySelector('.idx').textContent = String(i + 1);
  });
}

function readLegs() {
  return [...$('legs').children].map((row) => ({
    from: row.querySelector('.from').value.trim().toUpperCase(),
    to: row.querySelector('.to').value.trim().toUpperCase(),
    date: row.querySelector('.date').value,
    cabin: row.querySelector('.cabin').value,
  }));
}

function readOptions() {
  const pax = {};
  pax[$('paxKind').value] = Number($('paxCount').textContent);
  const opts = { passengers: pax, currency: $('curr').value.trim() || undefined };
  if ($('stops').value !== '') opts.maxStops = Number($('stops').value);
  if ($('carriers').value.trim()) opts.carriers = [airlineToken($('carriers').value.trim())];
  return opts;
}

function validateLegs(legs) {
  const problems = [];
  if (!legs.length) problems.push('Add at least one leg.');
  legs.forEach((leg, i) => {
    if (!/^[A-Z]{3}$/.test(leg.from)) problems.push(`Leg ${i + 1}: origin needs a 3-letter IATA code.`);
    if (!/^[A-Z]{3}$/.test(leg.to)) problems.push(`Leg ${i + 1}: destination needs a 3-letter IATA code.`);
    if (!leg.date) problems.push(`Leg ${i + 1}: pick a departure date.`);
  });
  return problems;
}

function showWarnings(problems) {
  const box = $('legWarn');
  box.textContent = problems.join('\n');
  box.classList.toggle('show', problems.length > 0);
  return problems.length === 0;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

async function plan() {
  const legs = readLegs();
  if (!showWarnings(validateLegs(legs))) return;
  const result = await postJson('/api/plan', { legs, ...readOptions() });
  if (result.error) return showWarnings([result.error]);
  renderPlan(result);
}

async function singleSearch() {
  const legs = readLegs();
  if (!showWarnings(validateLegs(legs))) return;
  // One cabin for the whole search — take the highest cabin requested, which
  // is the only choice that cannot hide a cheaper cabin in the results.
  const rank = { economy: 0, 'premium-economy': 1, business: 2, first: 3 };
  const seat = legs.reduce((a, b) => (rank[b.cabin] > rank[a.cabin] ? b : a)).cabin;
  const options = readOptions();
  const result = await postJson('/api/build', {
    segments: legs.map((l) => ({ from: l.from, to: l.to, date: l.date, maxStops: options.maxStops, carriers: options.carriers })),
    seat,
    trip: legs.length > 1 ? 'multi-city' : 'one-way',
    passengers: options.passengers,
    curr: options.currency,
  });
  if (result.error) return showWarnings([result.error]);
  $('resultsTitle').textContent = 'Plain search link';
  $('warnings').innerHTML = '';
  $('strategies').innerHTML = strategyHtml({
    label: `One search in ${label(seat)}`,
    why: 'A single tfs token carries one cabin for the whole search. Use the planner above when the legs differ.',
    searches: [{ route: legs.map((l) => `${l.from}→${l.to}`).join(' · '), cabin: label(seat), tfs: result.tfs, url: result.url }],
    caveats: [],
  });
  $('resultsCard').hidden = false;
  lastPlan = result;
}

let lastPlan = null;

function renderPlan(plan) {
  $('resultsTitle').innerHTML =
    `Cabin vector <span class="badge${plan.isMixed ? ' mixed' : ''}">${plan.cabinVector.map(label).join(' · ')}</span>`;
  $('warnings').innerHTML = plan.warnings.map((w) => `<div class="note">${esc(w)}</div>`).join('');

  const order = ['per-leg', 'board', 'matrix'];
  $('strategies').innerHTML = order
    .filter((key) => plan.strategies[key])
    .map((key) => strategyHtml(plan.strategies[key]))
    .join('');
  $('resultsCard').hidden = false;
  $('rawOut').hidden = true;
  lastPlan = plan;
}

function strategyHtml(strategy) {
  const searches = strategy.searches ?? [{ ...strategy, route: 'whole trip', cabin: strategy.openInCabin ?? '' }];
  const rows = searches
    .map(
      (s) => `
      <div class="search">
        <div class="meta">${esc(s.route ?? '')}${s.date ? ` · ${esc(s.date)}` : ''}${s.cabin ? ` · <strong>${esc(label(s.cabin))}</strong>` : ''}</div>
        <div class="row" style="margin-top:4px">
          <a class="btn-link" style="display:inline-flex;align-items:center;text-decoration:none;padding:9px 13px;border-radius:8px;border:1px solid #3a3a3e;background:#23232b;color:#fafafc;font-size:13px;font-weight:600" href="${esc(s.url)}" target="_blank" rel="noopener">Open on Google Flights ↗</a>
          <button type="button" class="copy" data-copy="${esc(s.url)}">Copy link</button>
        </div>
        <div class="out" style="margin-top:6px;max-height:96px;overflow:auto">${esc(s.tfs)}</div>
      </div>`
    )
    .join('');

  const caveats = (strategy.caveats ?? []).map((c) => `<li>${esc(c)}</li>`).join('');
  return `
    <div class="strategy">
      <h2 style="font-size:14px">${esc(strategy.label)}</h2>
      <p class="why">${esc(strategy.why)}</p>
      ${rows}
      ${caveats ? `<ul>${caveats}</ul>` : ''}
      ${strategy.matchWith ? `<p class="hint">Then: <code>${esc(strategy.matchWith)}</code></p>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async function decodeToken() {
  const raw = $('decodeIn').value.trim();
  const match = /[?&]tfs=([^&]+)/.exec(raw);
  const token = match ? decodeURIComponent(match[1]) : raw;
  if (!token) return out('decodeOut', 'Paste a tfs token or a Google Flights URL.');
  const result = await postJson('/api/decode', { tfs: token });
  if (result.error) return out('decodeOut', result.error);
  const lines = [
    `trip        ${result.trip}`,
    `cabin       ${result.seat}`,
    `passengers  ${result.passengers.map((p) => p.name).join(', ') || '(none)'}`,
    `pinned      ${result.pinned}`,
    `round-trips ${result.roundTrip.matches ? 'yes — this schema captured it exactly' : 'NO — this token carries something unknown, see below'}`,
    '',
    ...result.segments.map((s, i) => {
      const bits = [
        `  ${s.from.join(', ')} → ${s.to.join(', ')}`,
        `  date    ${s.date}`,
        `  stops   ${s.stopsLabel}`,
      ];
      if (s.carriers?.length) bits.push(`  include ${s.carriers.join(', ')}`);
      if (s.carriersExclude?.length) bits.push(`  exclude ${s.carriersExclude.join(', ')}`);
      if (s.layoverAirports?.length) bits.push(`  via     ${s.layoverAirports.join(', ')}`);
      if (s.minLayover != null) bits.push(`  layover ${s.minLayover}–${s.maxLayover ?? '∞'} min`);
      for (const leg of s.legs ?? []) {
        bits.push(`  pinned  ${leg.airline}${leg.flightNumber} ${leg.origin}→${leg.dest} ${leg.date}`);
      }
      return `segment ${i + 1}\n${bits.join('\n')}`;
    }),
  ];
  if (Object.keys(result.unknown ?? {}).length) {
    lines.push('', `unknown fields: ${JSON.stringify(result.unknown)}`);
  }
  lines.push('', result.roundTrip.matches ? '' : `re-encoded: ${result.roundTrip.token}`);
  out('decodeOut', lines.join('\n'));
}

async function parsePage() {
  const html = $('parseIn').value;
  if (!html.trim()) return out('parseOut', 'Paste the saved HTML of a results page.');
  const body = { html };
  const vector = $('vector').value.trim();
  if (vector) body.cabinVector = vector.split(',').map((s) => s.trim().toLowerCase());
  const result = await postJson('/api/parse-results', body);
  if (result.error) return out('parseOut', result.error);
  if (!result.found) {
    return out('parseOut', `No ds:1 payload found in this page.\n\n${result.reason}\n\nIf this is a multi-city page that is expected: Google loads multi-city rows client-side, so the saved HTML carries none.`);
  }

  const lines = [`rows found   ${result.rowCount}`, `parsed       ${result.parsedCount}`];
  if (result.cabinVector) {
    lines.push(`cabin vector ${result.cabinVector.map(label).join(' · ')}`, '', `matches      ${result.matches.length}`);
    if (result.matches.length) {
      const rows = result.matches
        .map(
          (m) => `<tr>
            <td>${m.price != null ? `${m.price} ${m.currency ?? ''}` : '<span class="bad">no list price</span>'}</td>
            <td>${esc(m.airline ?? '')}</td>
            <td>${m.durationMinutes ?? '?'} min</td>
            <td>${m.stops} stop(s)</td>
            <td>${m.mixedCabin ? '<span class="badge mixed">mixed</span>' : ''}</td>
            <td class="${m.exact ? 'ok' : ''}">${m.perLeg.map((l) => `${l.route} <strong>${l.gotName}</strong>${l.status === 'exact' ? '' : ` (${l.status})`}`).join('<br>')}</td>
          </tr>`
        )
        .join('');
      lines.push(
        `<table><thead><tr><th>Price</th><th>Airline</th><th>Duration</th><th>Stops</th><th>Cabins</th><th>Per leg</th></tr></thead><tbody>${rows}</tbody></table>`
      );
    } else {
      lines.push('\nNothing matched. Try allowing upgrades, or widen the cabin vector.');
    }
  } else {
    const rows = result.itineraries
      .map(
        (it) => `<tr>
          <td>${it.price != null ? `${it.price} ${it.currency ?? ''}` : '<span class="bad">no list price</span>'}</td>
          <td>${esc(it.airlineName ?? it.airline ?? '')}</td>
          <td>${it.durationMinutes ?? '?'} min</td>
          <td>${it.stops}</td>
          <td>${it.mixedCabin ? '<span class="badge mixed">mixed</span>' : ''}</td>
          <td>${it.legs.map((l) => `${l.from}→${l.to} <strong>${l.cabinName ?? '?'}</strong>`).join('<br>')}</td>
        </tr>`
      )
      .join('');
    lines.push('', '<table><thead><tr><th>Price</th><th>Airline</th><th>Duration</th><th>Stops</th><th>Cabins</th><th>Per leg cabin</th></tr></thead><tbody>' + rows + '</tbody></table>');
  }
  out('parseOut', lines.join('\n'), true);
}

async function bookingLink() {
  const raw = $('bookIn').value.trim();
  if (!raw) return out('bookOut', 'Paste one parsed itinerary as JSON.');
  let itineraries;
  try {
    itineraries = JSON.parse(raw);
  } catch (error) {
    return out('bookOut', `Not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(itineraries) ? itineraries : [itineraries];
  const segments = list.map((it) =>
    (it.legs ?? []).map((leg) => ({
      origin: leg.from,
      date: (leg.departure ?? '').slice(0, 10),
      dest: leg.to,
      airline: leg.airline,
      flightNumber: leg.flightNumber,
    }))
  );
  const result = await postJson('/api/booking', { segments, curr: $('curr').value.trim() || undefined });
  if (result.error) return out('bookOut', result.error);
  out('bookOut', `${result.url}\n\ntfs: ${result.tfs}`);
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function postJson(path, body) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await response.json();
  } catch (error) {
    return { error: `request failed: ${error.message}` };
  }
}

function out(id, text, html = false) {
  const box = $(id);
  box.hidden = false;
  if (html) box.innerHTML = text;
  else box.textContent = text;
}

const label = (cabin) =>
  ({
    economy: 'Economy',
    'premium-economy': 'Premium economy',
    business: 'Business',
    first: 'First',
  })[cabin] ?? cabin;

const airlineToken = (value) => value.toUpperCase();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

addLeg({ from: 'JFK', to: 'LHR', cabin: 'business' });
addLeg({ from: 'LHR', to: 'CAI', cabin: 'economy' });

$('addLeg').addEventListener('click', () => addLeg({ cabin: 'economy' }));
$('plan').addEventListener('click', plan);
$('single').addEventListener('click', singleSearch);

for (const button of document.querySelectorAll('[data-pax]')) {
  button.addEventListener('click', () => {
    const delta = Number(button.dataset.pax);
    const next = Math.max(1, Math.min(9, Number($('paxCount').textContent) + delta));
    $('paxCount').textContent = String(next);
  });
}

$('copyAll').addEventListener('click', async () => {
  const urls = [...document.querySelectorAll('.strategy a[href]')].map((a) => a.href).join('\n');
  await copy(urls);
  flash($('copyAll'), 'Copied');
});

$('showJson').addEventListener('click', () => {
  const box = $('rawOut');
  box.hidden = !box.hidden;
  box.textContent = JSON.stringify(lastPlan, null, 2);
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button.copy');
  if (!button) return;
  await copy(button.dataset.copy);
  flash(button, 'Copied');
});

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[data-tab]')) {
      other.setAttribute('aria-selected', String(other === tab));
      $(`tab-${other.dataset.tab}`).hidden = other !== tab;
    }
  });
}

$('decodeGo').addEventListener('click', decodeToken);
$('parseGo').addEventListener('click', parsePage);
$('bookGo').addEventListener('click', bookingLink);

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked — the links are visible on screen anyway */
  }
}

function flash(button, message) {
  const original = button.textContent;
  button.textContent = message;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}
