// Airline website DIRECTORY, not a checkout connector.
//
// PORTED from Adhambadrun/SpicyLinkGenerator `airline-directory.js` so the
// unified itinerary (lib/unified.js) can emit carrier links next to Google
// Flights links. Behaviour is unchanged; the differences from the original are
// listed in docs/COMBINE-AUDIT.md and are:
//
//   * reformatted and commented to match this repository's style;
//   * `logoUrl` is always null here — the bundled airline logos
//     (assets/airline-logos/*.svg, ~66 files under their own SOARING-LICENSE)
//     were NOT ported, because nothing in this repository renders a UI that
//     would use them. Emitting a path to a file that does not exist would be a
//     dead reference, so the field is kept (same shape) and left empty.
//
// These are candidate public homepages for common marketing carriers. They have
// NOT been live-tested in this sandbox; redirects and ownership can change. Do
// not infer booking capability from them. Never construct a host from itinerary
// text, and never put passenger data into a URL.

const SITES = Object.freeze({
  AA: ['American Airlines', 'www.aa.com'], AS: ['Alaska Airlines', 'www.alaskaair.com'],
  DL: ['Delta Air Lines', 'www.delta.com'], UA: ['United Airlines', 'www.united.com'],
  WN: ['Southwest Airlines', 'www.southwest.com'], B6: ['JetBlue', 'www.jetblue.com'],
  AC: ['Air Canada', 'www.aircanada.com'], WS: ['WestJet', 'www.westjet.com'],
  HA: ['Hawaiian Airlines', 'www.hawaiianairlines.com'], F9: ['Frontier Airlines', 'www.flyfrontier.com'],
  NK: ['Spirit Airlines', 'www.spirit.com'],
  BA: ['British Airways', 'www.britishairways.com'], LH: ['Lufthansa', 'www.lufthansa.com'],
  LX: ['SWISS', 'www.swiss.com'], OS: ['Austrian Airlines', 'www.austrian.com'],
  SN: ['Brussels Airlines', 'www.brusselsairlines.com'], AF: ['Air France', 'www.airfrance.com'],
  KL: ['KLM', 'www.klm.com'], IB: ['Iberia', 'www.iberia.com'],
  EI: ['Aer Lingus', 'www.aerlingus.com'], AY: ['Finnair', 'www.finnair.com'],
  SK: ['SAS', 'www.flysas.com'], TP: ['TAP Air Portugal', 'www.flytap.com'],
  AZ: ['ITA Airways', 'www.ita-airways.com'], VS: ['Virgin Atlantic', 'www.virginatlantic.com'],
  TK: ['Turkish Airlines', 'www.turkishairlines.com'],
  FR: ['Ryanair', 'www.ryanair.com'], U2: ['easyJet', 'www.easyjet.com'],
  W6: ['Wizz Air', 'www.wizzair.com'], VY: ['Vueling', 'www.vueling.com'],
  PC: ['Pegasus Airlines', 'www.flypgs.com'], EW: ['Eurowings', 'www.eurowings.com'],
  DY: ['Norwegian', 'www.norwegian.com'], HV: ['Transavia', 'www.transavia.com'],
  EK: ['Emirates', 'www.emirates.com'], QR: ['Qatar Airways', 'www.qatarairways.com'],
  EY: ['Etihad Airways', 'www.etihad.com'], SV: ['Saudia', 'www.saudia.com'],
  MS: ['EgyptAir', 'www.egyptair.com'], ET: ['Ethiopian Airlines', 'www.ethiopianairlines.com'],
  AT: ['Royal Air Maroc', 'www.royalairmaroc.com'],
  SQ: ['Singapore Airlines', 'www.singaporeair.com'], CX: ['Cathay Pacific', 'www.cathaypacific.com'],
  QF: ['Qantas', 'www.qantas.com'], NZ: ['Air New Zealand', 'www.airnewzealand.com'],
  JL: ['Japan Airlines', 'www.jal.co.jp'], NH: ['ANA', 'www.ana.co.jp'],
  KE: ['Korean Air', 'www.koreanair.com'], TG: ['Thai Airways', 'www.thaiairways.com'],
  MH: ['Malaysia Airlines', 'www.malaysiaairlines.com'], BR: ['EVA Air', 'www.evaair.com'],
  CI: ['China Airlines', 'www.china-airlines.com'], VN: ['Vietnam Airlines', 'www.vietnamairlines.com'],
  AI: ['Air India', 'www.airindia.com'], '6E': ['IndiGo', 'www.goindigo.in'],
  AK: ['AirAsia', 'www.airasia.com'], '5J': ['Cebu Pacific', 'www.cebupacificair.com'],
  TR: ['Scoot', 'www.flyscoot.com'], JQ: ['Jetstar', 'www.jetstar.com'],
  LA: ['LATAM Airlines', 'www.latamairlines.com'], AV: ['Avianca', 'www.avianca.com'],
  CM: ['Copa Airlines', 'www.copaair.com'], AM: ['Aeromexico', 'www.aeromexico.com'],
  G3: ['GOL', 'www.voegol.com.br'], AD: ['Azul', 'www.voeazul.com.br'],
  AR: ['Aerolíneas Argentinas', 'www.aerolineas.com.ar'],
});

export const listedAirlineCodes = Object.freeze(Object.keys(SITES));
export const listedAirlineCount = listedAirlineCodes.length;

/** A directory entry is not a verified prefill, availability result, or checkout. */
export function airlineOption(carrier) {
  const key = typeof carrier === 'string' ? carrier.toUpperCase() : '';
  if (!/^[A-Z0-9]{2}$/.test(key)) return { carrier: key, name: 'Unknown airline', url: null, logoUrl: null, level: 'unsupported' };
  const entry = Object.hasOwn(SITES, key) ? SITES[key] : null;
  if (!entry) return { carrier: key, name: key, url: null, logoUrl: null, level: 'unsupported' };
  const [name, host] = entry;
  // The static whitelist is authoritative. No URL is ever derived from user input.
  return { carrier: key, name, url: `https://${host}/`, logoUrl: null, level: 'homepage_unverified' };
}

/** Include only actual marketing carriers in itinerary order, not arbitrary alternatives. */
export function itineraryAirlines(segments) {
  if (!Array.isArray(segments)) return [];
  return [...new Set(segments.map((s) => s?.carrier).filter((c) => typeof c === 'string' && /^[A-Z0-9]{2}$/.test(c)))].map(
    airlineOption
  );
}
