/**
 * lib/http.ts — shared polite MediaWiki API fetcher.
 *
 * Modeled on the parsed-osrs wiki-scraper's WikiRequestService (the baseline
 * fetcher): every request is serialized through a single promise chain so at
 * least RATE_LIMIT_MS separates two requests no matter who initiates them,
 * transient failures (429, 5xx, timeouts) retry with exponential backoff
 * (honouring Retry-After), and a retry re-enters the same throttle.
 *
 * Hard cap: RATE_LIMIT_MS can only slow requests down, never below 1/second.
 * Only one fetching process should run at a time (the chain is per-process).
 */
const RATE_LIMIT_MS = Math.max(1000, Number(process.env.RATE_LIMIT_MS ?? 1000) || 1000);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

export const makeUA = (wikiId: string) =>
  `gaming-wikipedia-parsing/1.0 (first-link network analysis; ${wikiId}; discord: anyny0)`;

/** process-wide throttle state: strictly sequential, ≥1s apart */
let throttleChain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function schedule<T>(op: () => Promise<T>): Promise<T> {
  const run = throttleChain.then(async () => {
    const wait = Math.max(0, RATE_LIMIT_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // stamp dispatch time BEFORE sending so a failed request still counts
    // toward the throttle gap (baseline WikiRequestService semantics)
    lastRequestAt = Date.now();
    return op();
  });
  // chain future requests behind this one; swallow errors so a single
  // failure can never wedge the chain
  throttleChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface FetchFailure extends Error {
  status?: number;
  retryAfterMs?: number;
  code?: string;
}

export async function politeFetch(origin: string, ua: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${origin}/api.php`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt++) {
    try {
      return await schedule(() =>
        fetch(url, {
          headers: { "User-Agent": ua },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }).then(async (res) => {
          if (res.status === 429 || res.status >= 500) {
            const err: FetchFailure = new Error(`API ${res.status}`);
            err.status = res.status;
            const retryAfter = res.headers.get("retry-after");
            if (retryAfter && Number.isFinite(Number(retryAfter))) {
              err.retryAfterMs = Number(retryAfter) * 1000;
            }
            throw err;
          }
          if (!res.ok) throw new Error(`API ${res.status}`);
          return res.json();
        }),
      );
    } catch (e) {
      const err = e as FetchFailure;
      const retryable =
        err.status === 429 ||
        (typeof err.status === "number" && err.status >= 500) ||
        err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        err.code === "ETIMEDOUT";
      if (!retryable || attempt >= MAX_RETRIES) throw e;
      const backoff = err.retryAfterMs && err.retryAfterMs > 0
        ? err.retryAfterMs
        : Math.min(30_000, 500 * 2 ** attempt);
      console.log(`  ${err.status ?? err.name}, backing off ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise((r) => setTimeout(r, backoff));
      // the retry goes back through schedule(), so it also respects the 1s gap
    }
  }
}

/**
 * SQLite busy-retry, adopted from the baseline scraper's backfill script:
 * retriable "database is locked/busy" errors wait briefly and retry instead
 * of failing the whole fetch run.
 */
export async function withBusyRetry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === tries || !/lock|busy/i.test(String((e as Error)?.message))) throw e;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}
