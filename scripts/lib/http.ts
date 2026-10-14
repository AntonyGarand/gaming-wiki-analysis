/**
 * lib/http.ts — shared polite MediaWiki API fetcher.
 *
 * Same contract for every script that talks to a wiki (README: Polite scraping):
 *   - hard cap of 1 request/second — RATE_LIMIT_MS can only slow it down,
 *     never speed it up
 *   - requests are strictly sequential (one in flight per process), and
 *     only one fetching process should run at a time
 *   - descriptive User-Agent
 *   - exponential backoff on 429/5xx
 */
const RATE_LIMIT_MS = Math.max(1000, Number(process.env.RATE_LIMIT_MS ?? 1000) || 1000);
let lastRequestAt = 0;

export const makeUA = (wikiId: string) =>
  `gaming-wikipedia-parsing/1.0 (first-link network analysis; ${wikiId}; discord: anyny0)`;

export async function politeFetch(origin: string, ua: string, params: Record<string, string>): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const wait = RATE_LIMIT_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();

    const url = new URL(`${origin}/api.php`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { "User-Agent": ua } });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) throw new Error(`API ${res.status} after ${attempt} attempts`);
      const backoff = 2000 * attempt;
      console.log(`  ${res.status}, backing off ${backoff}ms...`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }
}
