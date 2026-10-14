/**
 * lib/http.ts — shared polite MediaWiki API fetcher.
 *
 * Modeled on the parsed-osrs wiki-scraper's WikiRequestService (the baseline
 * fetcher), with one strengthening: the 1 req/s budget is MACHINE-WIDE.
 * Concurrent processes (parallel extraction shards, multiple wikis at once)
 * share a single file-locked slot, so all wiki traffic combined never
 * exceeds 1 request/second. Transient failures (429, 5xx, timeouts) retry
 * with exponential backoff (honouring Retry-After); retries re-enter the
 * same throttle.
 *
 * RATE_LIMIT_MS can only slow requests down, never below 1/second.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RATE_LIMIT_MS = Math.max(1000, Number(process.env.RATE_LIMIT_MS ?? 1000) || 1000);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

export const makeUA = (wikiId: string) =>
  `gaming-wikipedia-parsing/1.0 (first-link network analysis; ${wikiId}; discord: anyny0)`;

// ---------------------------------------------------------------------------
// machine-wide throttle: one file lock guards a shared last-request stamp.
// The lock is HELD through the wait so exactly one process on the machine
// dispatches per RATE_LIMIT_MS window, no matter how many are running.
// ---------------------------------------------------------------------------
const LOCK_DIR = path.join(os.tmpdir(), "gaming-wiki-http-ratelimit");
const LOCK_PATH = path.join(LOCK_DIR, "lock");
const STATE_PATH = path.join(LOCK_DIR, "last-request");
const STALE_LOCK_MS = 15_000; // a holder that died mid-wait must not wedge everyone

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquireGlobalSlot(): Promise<() => void> {
  for (;;) {
    let fd: number | undefined;
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
      fd = fs.openSync(LOCK_PATH, "wx"); // exclusive create = the mutex
    } catch {
      try {
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) fs.rmSync(LOCK_PATH, { force: true });
      } catch { /* lock vanished — retry immediately */ }
      await sleep(25);
      continue;
    }
    try {
      let last = 0;
      try { last = Number(fs.readFileSync(STATE_PATH, "utf8")); } catch { /* first ever */ }
      if (!Number.isFinite(last) || last <= 0) last = 0;
      const wait = Math.max(0, RATE_LIMIT_MS - (Date.now() - last));
      if (wait > 0) await sleep(wait);
      // stamp dispatch time BEFORE sending so failures still count
      try { fs.writeFileSync(STATE_PATH, String(Date.now())); } catch { /* best effort */ }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.closeSync(fd!); } catch { /* already closed */ }
        try { fs.rmSync(LOCK_PATH, { force: true }); } catch { /* already gone */ }
      };
    } catch (e) {
      try { fs.closeSync(fd!); } catch { /* ignore */ }
      try { fs.rmSync(LOCK_PATH, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }
}

/** in-process serialization on top of the global slot (keeps one queue per process) */
let throttleChain: Promise<unknown> = Promise.resolve();

function schedule<T>(op: () => Promise<T>): Promise<T> {
  const run = throttleChain.then(op);
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

/** walk a fetch error's cause chain to the underlying network error */
function rootCause(err: unknown): { code?: string; name?: string } {
  let cur = err as { cause?: unknown; code?: string; name?: string };
  const seen = new Set<unknown>();
  while (cur?.cause && !seen.has(cur)) { seen.add(cur); cur = cur.cause as typeof cur; }
  return cur ?? {};
}

// undici wraps socket-level failures as TypeError("fetch failed") with the
// real errno on .cause — axios (the baseline) surfaced these on error.code
const RETRYABLE_NET_CODES = new Set([
  "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ECONNREFUSED",
  "EAI_AGAIN", "ENOTFOUND", "EHOSTUNREACH", "UND_ERR_SOCKET",
]);

export async function politeFetch(origin: string, ua: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${origin}/api.php`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt++) {
    try {
      return await schedule(async () => {
        const release = await acquireGlobalSlot();
        try {
          const res = await fetch(url, {
            headers: { "User-Agent": ua },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
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
        } finally {
          release();
        }
      });
    } catch (e) {
      const err = e as FetchFailure;
      const cause = rootCause(err);
      const retryable =
        err.status === 429 ||
        (typeof err.status === "number" && err.status >= 500) ||
        err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        err.code === "ETIMEDOUT" ||
        (err.name === "TypeError" && /fetch failed/i.test(err.message ?? "")) ||
        RETRYABLE_NET_CODES.has(String(cause.code ?? ""));
      if (!retryable || attempt >= MAX_RETRIES) throw e;
      const backoff = err.retryAfterMs && err.retryAfterMs > 0
        ? err.retryAfterMs
        : Math.min(30_000, 500 * 2 ** attempt);
      console.log(`  ${err.status ?? err.name ?? "fetch failed"}${cause.code ? ` (${cause.code})` : ""}, backing off ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(backoff);
      // the retry goes back through the global slot, so it also respects 1/s
    }
  }
}

/**
 * SQLite busy-retry, adopted from the baseline scraper's backfill script:
 * retriable "database is locked/busy" errors wait briefly and retry instead
 * of failing the whole run. Required now that parallel shards write the
 * same links.sqlite.
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
