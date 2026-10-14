/**
 * fetch-wiki.ts — download all mainspace articles from MediaWiki instances.
 *
 * Polite scraping:
 *   - 1 request/second by default (RATE_LIMIT_MS env)
 *   - descriptive User-Agent with contact info
 *   - exponential backoff on 429/5xx
 *   - only mainspace content pages (ns=0, non-redirects)
 *   - idempotent: only fetches pages with missing text
 *
 * Usage:
 *   npx tsx scripts/fetch-wiki.ts --wiki=minecraft
 *   npx tsx scripts/fetch-wiki.ts --all
 */
import { createClient, type Client } from "@libsql/client";
import * as fs from "fs";
import * as path from "path";
import { politeFetch, makeUA } from "./lib/http.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;
const wikiArg = process.argv.find((a) => a.startsWith("--wiki="))?.slice(7);
const allFlag = process.argv.includes("--all");
const targets = allFlag ? wikis : wikis.filter((w) => w.id === wikiArg);
if (targets.length === 0) {
  console.error(`No matching wiki. Available: ${wikis.map((w) => w.id).join(", ")}`);
  console.error(`Usage: npx tsx scripts/fetch-wiki.ts --wiki=<id> or --all`);
  process.exit(1);
}

async function fetchWiki(wiki: typeof wikis[0]): Promise<void> {
  const t0 = Date.now();
  const outDir = path.join(ROOT, "output", wiki.id);
  fs.mkdirSync(outDir, { recursive: true });
  const dbPath = path.join(outDir, "wiki.sqlite");
  const ua = makeUA(wiki.id);
  const db = createClient({ url: `file:${dbPath}` });
  const log = (msg: string) => console.log(`[${wiki.id}] ${msg}`);

  log(`fetching from ${wiki.origin}`);

  await db.execute(`CREATE TABLE IF NOT EXISTS page (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, namespace INTEGER DEFAULT 0,
    text TEXT, revision_id INTEGER, aliases TEXT DEFAULT '[]'
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

  // 1. namespaces
  log("fetching namespace list...");
  const nsData = await politeFetch(wiki.origin, ua, { action: "query", meta: "siteinfo", siprop: "namespaces", format: "json" });
  const nsNames = new Set<string>([
    "file", "image", "category", "cat", "template", "module", "user",
    "mediawiki", "help", "portal", "draft", "talk", "update", "transcript",
    "poll", "calculator", "chisel", "bestiary", "exchange", "map", "signatures",
    ...Object.values(nsData?.query?.namespaces ?? {}).flatMap((n: any) =>
      [n?.name, n?.canonical, ...(n?.aliases ?? [])].filter(Boolean).map((s: string) => s.toLowerCase())
    ),
  ]);
  await db.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    args: ["namespaces", JSON.stringify([...nsNames])] });
  log(`${nsNames.size} namespace names to skip`);

  // 2. list mainspace pages
  log("listing mainspace pages...");
  const pageList: Array<{ pageid: number; title: string }> = [];
  let apcontinue: string | undefined;
  for (;;) {
    const params: Record<string, string> = {
      action: "query", list: "allpages", apnamespace: "0",
      apfilterredir: "nonredirects", aplimit: "500", format: "json",
    };
    if (apcontinue) params.apcontinue = apcontinue;
    const data = await politeFetch(wiki.origin, ua, params);
    for (const p of data?.query?.allpages ?? []) pageList.push({ pageid: p.pageid, title: p.title });
    apcontinue = data?.continue?.apcontinue;
    if (!apcontinue) break;
    if (pageList.length % 5000 === 0) log(`  listed ${pageList.length} pages...`);
  }
  log(`${pageList.length} mainspace articles found`);

  // 3. upsert stubs
  const existing = new Set((await db.execute("SELECT id FROM page")).rows.map((r) => Number(r.id)));
  const newPages = pageList.filter((p) => !existing.has(p.pageid));
  log(`${newPages.length} new pages to insert`);
  for (let i = 0; i < newPages.length; i += 250) {
    const chunk = newPages.slice(i, i + 250);
    await db.batch(chunk.map((p) => ({
      sql: "INSERT OR IGNORE INTO page (id, title, namespace) VALUES (?, ?, 0)",
      args: [p.pageid, p.title],
    })) as never);
  }

  // 4. fetch content for pages with NULL text
  const missingIds = (await db.execute("SELECT id FROM page WHERE text IS NULL"))
    .rows.map((r) => Number(r.id));
  log(`${missingIds.length} pages need content`);
  let fetched = 0, failed = 0;
  for (let i = 0; i < missingIds.length; i += 50) {
    const chunk = missingIds.slice(i, i + 50);
    const data = await politeFetch(wiki.origin, ua, {
      action: "query", format: "json", formatversion: "2",
      prop: "revisions", rvprop: "content|ids", rvslots: "main",
      pageids: chunk.join("|"),
    });
    const updates: Array<{ sql: string; args: any[] }> = [];
    for (const page of data?.query?.pages ?? []) {
      const content = page?.revisions?.[0]?.slots?.main?.content;
      const revid = page?.revisions?.[0]?.revid;
      if (typeof content === "string" && typeof revid === "number") {
        updates.push({ sql: "UPDATE page SET text = ?, revision_id = ? WHERE id = ?", args: [content, revid, page.pageid] });
      } else failed++;
    }
    for (let u = 0; u < updates.length; u += 50) await db.batch(updates.slice(u, u + 50) as never);
    fetched += chunk.length;
    if (fetched % 1000 < 50) log(`  ${fetched} / ${missingIds.length} fetched (failed: ${failed})`);
  }
  log(`content: ${fetched - failed} fetched, ${failed} failed`);

  // 5. aliases
  const allPages = (await db.execute("SELECT id, title, aliases FROM page")).rows;
  const needAliases = allPages.filter((r) => {
    try { return JSON.parse(String(r.aliases ?? "[]")).length === 0; } catch { return true; }
  });
  log(`${needAliases.length} pages need aliases`);
  let aliasCount = 0;
  for (let i = 0; i < needAliases.length; i += 50) {
    const chunk = needAliases.slice(i, i + 50);
    let rdcontinue: string | undefined;
    const redirects = new Map<number, string[]>();
    for (;;) {
      const params: Record<string, string> = {
        action: "query", format: "json", formatversion: "2",
        prop: "redirects", rdlimit: "max",
        titles: chunk.map((r) => String(r.title)).join("|"),
      };
      if (rdcontinue) params.rdcontinue = rdcontinue;
      const data = await politeFetch(wiki.origin, ua, params);
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
      let prev: string[] = [];
      try { prev = JSON.parse(String(row.aliases ?? "[]")); } catch { }
      const merged = [...new Set([...prev, ...titles])];
      if (merged.length > prev.length) {
        aliasCount++;
        updates.push({ sql: "UPDATE page SET aliases = ? WHERE id = ?", args: [JSON.stringify(merged), pageId] });
      }
    }
    for (let u = 0; u < updates.length; u += 50) await db.batch(updates.slice(u, u + 50) as never);
    if ((i / 50) % 20 === 19) log(`  ${i + chunk.length} / ${needAliases.length} checked (${aliasCount} with aliases)`);
  }
  log(`aliases: ${aliasCount} pages gained aliases`);

  const total = (await db.execute("SELECT COUNT(*) as n FROM page")).rows[0];
  const withText = (await db.execute("SELECT COUNT(*) as n FROM page WHERE text IS NOT NULL")).rows[0];
  for (const [k, v] of Object.entries({ wiki: wiki.id, origin: wiki.origin, generatedAt: new Date().toISOString(),
    totalPages: String(total.n), pagesWithText: String(withText.n) })) {
    await db.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", args: [k, v] });
  }
  log(`done in ${Math.round((Date.now() - t0) / 1000)}s — ${withText.n}/${total.n} pages with text`);
}

async function main() {
  for (const wiki of targets) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${wiki.name} (${wiki.origin})`);
    console.log(`${"=".repeat(60)}`);
    try {
      await fetchWiki(wiki);
    } catch (e) {
      console.error(`[${wiki.id}] FAILED: ${(e as Error).message}`);
      console.error(`  continuing to next wiki...`);
    }
  }
  console.log(`\nAll done. ${targets.length} wiki(s) processed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
