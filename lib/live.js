// Opt-in live fetch of a Google Flights results page.
//
// DEFAULT OFF. Set GF_LIVE=1 to enable the /api/search endpoint.
//
// What this deliberately does NOT do:
//   * no proxy rotation, no residential IPs
//   * no CAPTCHA solving
//   * no browser-fingerprint spoofing or headless-browser stealth
//   * no forging of the `x-goog-batchexecute-bgr` signature that gates the
//     FlightsFrontendService RPC — we never call that RPC at all
//
// It is a plain, rate-limited GET of the public results page, the same request
// a browser makes when you open a `tfs` link. That page is not signature-gated
// and inlines its results, which is why no RPC is needed. Keep the volume low
// and personal: automated querying of Google is against their Terms of Service,
// and this is here for research and low-volume checking, not for a product.

import { searchUrl } from './tfs.js';
import { parseResultsHtml } from './results.js';

/** Serialise requests so at most one is in flight and they are spaced out. */
export function createRateLimiter(minIntervalMs = 3000) {
  let chain = Promise.resolve();
  let last = 0;
  return function schedule(task) {
    const run = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return task();
    });
    // Keep the chain alive even if a task rejects.
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * Fetch one results page.
 *
 * @param {string} tfs
 * @param {{hl?:string, gl?:string, curr?:string, fetchImpl?:Function, timeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean, status?:number, url:string, reason?:string, blocked?:boolean,
 *                    rateLimited?:boolean, noPayload?:boolean, itineraries?:Array, parsed?:object}>}
 */
export async function fetchSearchPage(tfs, options = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = options;
  const url = searchUrl(tfs, { hl: options.hl, gl: options.gl, curr: options.curr });

  if (typeof fetchImpl !== 'function') {
    return { ok: false, url, reason: 'no fetch implementation available (needs Node 18+)' };
  }

  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': options.hl ? `${options.hl},en;q=0.9` : 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, url, reason: `request failed: ${error.message}` };
  }

  if (response.status === 429) {
    return { ok: false, url, status: 429, rateLimited: true, reason: 'rate limited (HTTP 429) — slow down' };
  }
  if (!response.ok) {
    return { ok: false, url, status: response.status, reason: `HTTP ${response.status}` };
  }

  const html = await response.text();

  // Google answers a block with HTTP 200 and a /sorry/ interstitial.
  const finalUrl = response.url || url;
  if (/\/sorry\//.test(finalUrl) || /unusual traffic|automated requests/i.test(html.slice(0, 20000))) {
    return { ok: false, url, blocked: true, reason: 'Google served a block page — back off' };
  }
  if (/consent\.google\.com|Before you continue|Accept all/i.test(html.slice(0, 40000))) {
    return { ok: false, url, blocked: true, reason: 'consent wall — open the URL in a browser once first' };
  }

  const parsed = parseResultsHtml(html);
  if (!parsed.found) {
    return {
      ok: true,
      url,
      noPayload: true,
      reason:
        'page carried no ds:1 rows. Expected for multi-city (Google loads those client-side) and for some passenger mixes.',
      parsed,
    };
  }
  return { ok: true, url, parsed, itineraries: parsed.itineraries };
}

export const LIVE_ENABLED = () => process.env.GF_LIVE === '1';
