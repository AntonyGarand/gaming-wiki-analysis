/**
 * fetch-wiki.ts — download all mainspace articles from a MediaWiki instance.
 *
 * Polite scraping:
 *   - 1 request/second by default (RATE_LIMIT_MS env)
 *   - descriptive User-Agent
 *   - exponential backoff on 429/5xx
 *   - only mainspace content pages (ns=0, non-redirects)
 *   - idempotent: only fetches pages with missing text
 *
 * Usage: npx tsx scripts/fetch-wiki.ts --wiki=minecraft
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;
const wikiArg = process.argv.find((a) => a.startsWith("--wiki="))?.slice(7);
const wiki = wikis.find((w) => w.id === wikiArg);
if (!wiki) {
  console.error(`Unknown --wiki=${wikiArg}. Available: ${wikis.map((w) => w.id).join(", ")}`);
  process.exit(1);
}

const OUT_DIR = path.join(ROOT, "output", wiki.id);
fs.mkdirSync(OUT_DIR, { recursive: true });
const DB_PATH = path.join(OUT_DIR, "wiki.sqlite");
const API = `${wiki.origin}/api.php`;
const UA = `gaming-wikipedia-parsing/1.0 (first-link network analysis; ${wiki.id})`;
const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS ?? 1000);

const db = createClient({ url: `file:${DB_PATH}` });

let lastRequestAt = 0;
async function politeFetch(params: Record<string, string>): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const wait = RATE_LIMIT_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();

    const url = new URL(API);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { "User-Agent": UA } });

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

async function main() {
  const t0 = Date.now();
  console.log(`[${wiki.id}] fetching from ${wiki.origin}`);

  // init schema
  await db.execute(`CREATE TABLE IF NOT EXISTS page (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, namespace INTEGER DEFAULT 0,
    text TEXT, revision_id INTEGER, aliases TEXT DEFAULT '[]'
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

  // 1. discover namespaces (to build skip list)
  console.log(`[${wiki.id}] fetching namespace list...`);
  const nsData = await politeFetch({ action: "query", meta: "siteinfo", siprop: "namespaces", format: "json" });
  const nsNames = new Set<string>(["file", "image", "category", "cat", "template", "module",
    "user", "mediawiki", "help", "portal", "draft", "talk", "update", "transcript",
    "poll", "calculator", "chisel", "bestiary", "exchange", "map", "signatures",
    ...Object.values(nsData?.query?.namespaces ?? {}).flatMap((n: any) =>
      [n?.name, n?.canonical, ...(n?.aliases ?? [])].filter(Boolean).map((s: string) => s.toLowerCase())
    ),
  ]);
  await db.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    args: ["namespaces", JSON.stringify([...nsNames])] });
  console.log(`[${wiki.id}] ${nsNames.size} namespace names to skip`);

  // 2. list all mainspace pages
  console.log(`[${wiki.id}] listing mainspace pages...`);
  const pageList: Array<{ pageid: number; title: string }> = [];
  let apcontinue: string | undefined;
  for (;;) {
    const params: Record<string, string> = {
      action: "query", list: "allpages", apnamespace: "0",
      apfilterredir: "nonredirects", aplimit: "500", format: "json",
    };
    if (apcontinue) params.apcontinue = apcontinue;
    const data = await politeFetch(params);
    for (const p of data?.query?.allpages ?? []) pageList.push({ pageid: p.pageid, title: p.title });
    apcontinue = data?.continue?.apcontinue;
    if (!apcontinue) break;
    if (pageList.length % 5000 === 0) console.log(`  listed ${pageList.length} pages...`);
  }
  console.log(`[${wiki.id}] ${pageList.length} mainspace articles found`);

  // 3. upsert page stubs
  const existing = new Set(
    (await db.execute("SELECT id FROM page")).rows.map((r) => Number(r.id))
  );
  const newPages = pageList.filter((p) => !existing.has(p.pageid));
  console.log(`[${wiki.id}] ${newPages.length} new pages to insert`);
  for (let i = 0; i < newPages.length; i += 250) {
    const chunk = newPages.slice(i, i + 250);
    await db.batch(chunk.map((p) => ({
      sql: "INSERT OR IGNORE INTO page (id, title, namespace) VALUES (?, ?, 0)",
      args: [p.pageid, p.title],
    })) as never);
  }

  // 4. fetch content for pages with NULL text
  const missing = (await db.execute("SELECT id FROM page WHERE text IS NULL")).rows;
  const missingIds = missing.map((r) => Number(r.id));
  console.log(`[${wiki.id}] ${missingIds.length} pages need content`);
  let fetched = 0, failed = 0;
  for (let i = 0; i < missingIds.length; i += 50) {
    const chunk = missingIds.slice(i, i + 50);
    const data = await politeFetch({
      action: "query", format: "json", formatversion: "2",
      prop: "revisions", rvprop: "content|ids", rvslots: "main",
      pageids: chunk.join("|"),
    });
    const updates: Array<{ sql: string; args: any[] }> = [];
    for (const page of data?.query?.pages ?? []) {
      const content = page?.revisions?.[0]?.slots?.main?.content;
      const revid = page?.revisions?.[0]?.revid;
      if (typeof content === "string" && typeof revid === "number") {
        updates.push({
          sql: "UPDATE page SET text = ?, revision_id = ? WHERE id = ?",
          args: [content, revid, page.pageid],
        });
      } else {
        failed++;
      }
    }
    if (updates.length > 0) {
      for (let u = 0; u < updates.length; u += 50) {
        await db.batch(updates.slice(u, u + 50) as never);
      }
    }
    fetched += chunk.length;
    if (fetched % 1000 < 50) console.log(`  ${fetched} / ${missingIds.length} fetched (failed: ${failed})`);
  }
  console.log(`[${wiki.id}] content: ${fetched - failed} fetched, ${failed} failed`);

  // 5. fetch redirects/aliases for all pages
  const allPages = (await db.execute("SELECT id, title, aliases FROM page")).rows;
  const emptyAliases = allPages.filter((r) => {
    try { return JSON.parse(String(r.aliases ?? "[]")).length === 0; } catch { return true; }
  });
  console.log(`[${wiki.id}] ${emptyAliases.length} pages need aliases`);
  let aliasCount = 0;
  for (let i = 0; i < emptyAliases.length; i += 50) {
    const chunk = emptyAliases.slice(i, i + 50);
    let rdcontinue: string | undefined;
    const redirects = new Map<number, string[]>();
    for (;;) {
      const params: Record<string, string> = {
        action: "query", format: "json", formatversion: "2",
        prop: "redirects", rdlimit: "max",
        titles: chunk.map((r) => String(r.title)).join("|"),
      };
      if (rdcontinue) params.rdcontinue = rdcontinue;
      const data = await politeFetch(params);
      for (const page of data?.query?.pages ?? []) {
        if (Array.isArray(page.redirects)) {
          const list = redirects.get(Number(page.pageid)) ?? [];
          for (const rd of page.redirects) if (rd?.title) list.push(rd.title);
          redirects.set(Number(page.pageid), list);
        }
      }
      rdcontinue = data?.continue?.rdcontinue;
      if (!rdcontinue) break;
    }
    const updates: Array<{ sql: string; args: any[] }> = [];
    for (const [pageId, titles] of redirects) {
      if (!titles.length) continue;
      const row = chunk.find((r) => Number(r.id) === pageId);
      if (!row) continue;
      let existing2: string[] = [];
      try { existing2 = JSON.parse(String(row.aliases ?? "[]")); } catch { }
      const merged = [...new Set([...existing2, ...titles])];
      if (merged.length > existing2.length) {
        aliasCount++;
        updates.push({ sql: "UPDATE page SET aliases = ? WHERE id = ?", args: [JSON.stringify(merged), pageId] });
      }
    }
    for (let u = 0; u < updates.length; u += 50) {
      await db.batch(updates.slice(u, u + 50) as never);
    }
    if ((i / 50) % 20 === 19) console.log(`  ${i + chunk.length} / ${emptyAliases.length} pages checked (${aliasCount} with aliases)`);
  }
  console.log(`[${wiki.id}] aliases: ${aliasCount} pages gained aliases`);

  // meta
  const total = (await db.execute("SELECT COUNT(*) as n FROM page")).rows[0];
  const withText = (await db.execute("SELECT COUNT(*) as n FROM page WHERE text IS NOT NULL")).rows[0];
  for (const [k, v] of Object.entries({
    wiki: wiki.id, origin: wiki.origin, generatedAt: new Date().toISOString(),
    totalPages: String(total.n), pagesWithText: String(withText.n),
  })) {
    await db.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", args: [k, v] });
  }
  console.log(`[${wiki.id}] done in ${Math.round((Date.now() - t0) / 1000)}s → ${DB_PATH}`);
  console.log(`[${wiki.id}] ${withText.n} pages with text out of ${total.n} total`);
}

main().catch((e) => { console.error(e); process.exit(1); });
