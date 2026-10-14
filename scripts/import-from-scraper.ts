/**
 * import-from-scraper.ts — seed a wiki's page dumps from the parsed-osrs
 * wiki-scraper baseline (../osrs-cloud-wiki-scraper/wiki-scraper).
 *
 * The baseline scraper keeps complete OSRS + RS3 dumps in its own SQLite
 * (wiki_page: id, title, namespace, text, revision_id, aliases). Instead of
 * re-fetching those wikis over the API, merge its dump into our
 * output/<wiki>/wiki.sqlite:
 *
 *   - pages missing here        → insert
 *   - baseline revision newer   → update title/text/revision/namespace
 *   - aliases (redirects)       → union-merged in every case (they change
 *                                 independently of page revisions)
 *
 * No wiki API requests. Afterwards, extract-links.ts picks up changed
 * revisions incrementally on its next run.
 *
 * Usage:
 *   npx tsx scripts/import-from-scraper.ts --wiki=osrs
 *   npx tsx scripts/import-from-scraper.ts --wiki=rs3
 *   npx tsx scripts/import-from-scraper.ts --wiki=osrs --source=<path.sqlite>
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as path from "path";
import { withBusyRetry } from "./lib/http.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;
const wikiArg = process.argv.find((a) => a.startsWith("--wiki="))?.slice(7);
const sourceArg = process.argv.find((a) => a.startsWith("--source="))?.slice(9);
const wiki = wikis.find((w) => w.id === wikiArg);
if (!wiki) { console.error(`Unknown --wiki=${wikiArg}`); process.exit(1); }

const DEFAULT_SOURCES: Record<string, string> = {
  osrs: path.resolve(ROOT, "..", "osrs-cloud-wiki-scraper", "wiki-scraper", "data", "database.sqlite"),
  rs3: path.resolve(ROOT, "..", "osrs-cloud-wiki-scraper", "wiki-scraper", "data", "database-rs3.sqlite"),
};
const SOURCE = sourceArg ?? DEFAULT_SOURCES[wiki.id];
if (!SOURCE) { console.error(`No default source for '${wiki.id}' — pass --source=<path.sqlite>`); process.exit(1); }
if (!fs.existsSync(SOURCE)) { console.error(`Source dump not found: ${SOURCE}`); process.exit(1); }

const OUT_DIR = path.join(ROOT, "output", wiki.id);
fs.mkdirSync(OUT_DIR, { recursive: true });
const SRC = createClient({ url: `file:${SOURCE}` });
const DST = createClient({ url: `file:${path.join(OUT_DIR, "wiki.sqlite")}` });

function parseAliases(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

async function main() {
  const t0 = Date.now();
  await withBusyRetry(() => DST.execute(`CREATE TABLE IF NOT EXISTS page (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, namespace INTEGER DEFAULT 0,
    text TEXT, revision_id INTEGER, aliases TEXT DEFAULT '[]'
  )`));
  await withBusyRetry(() => DST.execute(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`));

  // load our rows (id → {rev, aliases}) in one pass
  const ours = new Map<number, { rev: number; text: string | null; aliases: string[] }>();
  {
    let lastId = -1;
    for (;;) {
      const res = await DST.execute({
        sql: "SELECT id, revision_id, text, aliases FROM page WHERE id > ? ORDER BY id LIMIT 5000",
        args: [lastId],
      });
      if (!res.rows.length) break;
      for (const r of res.rows) {
        lastId = Number(r.id);
        ours.set(lastId, {
          rev: r.revision_id === null ? -1 : Number(r.revision_id),
          text: r.text === null ? null : String(r.text),
          aliases: parseAliases(r.aliases),
        });
      }
      if (res.rows.length < 5000) break;
    }
  }
  console.log(`[${wiki.id}] ours: ${ours.size} rows`);

  let inserted = 0, updated = 0, aliasMerged = 0, scanned = 0;
  let lastId = -1;
  for (;;) {
    const res = await SRC.execute({
      sql: `SELECT id, title, namespace, text, revision_id, aliases FROM wiki_page WHERE id > ? ORDER BY id LIMIT 1000`,
      args: [lastId],
    });
    if (!res.rows.length) break;

    const writes: Array<{ sql: string; args: unknown[] }> = [];
    for (const r of res.rows) {
      lastId = Number(r.id);
      scanned++;
      const id = lastId;
      const title = String(r.title);
      const namespace = r.namespace === null ? 0 : Number(r.namespace);
      const text = r.text === null ? null : String(r.text);
      const rev = r.revision_id === null ? -1 : Number(r.revision_id);
      const aliases = parseAliases(r.aliases);
      const existing = ours.get(id);

      if (!existing) {
        inserted++;
        writes.push({
          sql: "INSERT OR REPLACE INTO page (id, title, namespace, text, revision_id, aliases) VALUES (?, ?, ?, ?, ?, ?)",
          args: [id, title, namespace, text, rev, JSON.stringify(aliases)],
        });
        ours.set(id, { rev, text, aliases });
        continue;
      }

      const merged = [...new Set([...existing.aliases, ...aliases])];
      const aliasesChanged = merged.length !== existing.aliases.length;
      const contentStale = (rev > existing.rev) || (existing.text === null && text !== null);
      if (contentStale) {
        updated++;
        writes.push({
          sql: "UPDATE page SET title = ?, namespace = ?, text = ?, revision_id = ?, aliases = ? WHERE id = ?",
          args: [title, namespace, text, rev, JSON.stringify(merged), id],
        });
        existing.rev = rev; existing.text = text; existing.aliases = merged;
      } else if (aliasesChanged) {
        aliasMerged++;
        writes.push({
          sql: "UPDATE page SET aliases = ? WHERE id = ?",
          args: [JSON.stringify(merged), id],
        });
        existing.aliases = merged;
      }
    }
    for (let i = 0; i < writes.length; i += 100) {
      await withBusyRetry(() => DST.batch(writes.slice(i, i + 100) as never));
    }
    if (res.rows.length < 1000) break;
  }

  await withBusyRetry(() => DST.execute({
    sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    args: ["seededFrom", JSON.stringify({ source: SOURCE, scanned, inserted, updated, aliasMerged, at: new Date().toISOString() })],
  }));

  console.log(`[${wiki.id}] import done in ${Math.round((Date.now() - t0) / 1000)}s: ${scanned} baseline rows → ${inserted} inserted, ${updated} updated, ${aliasMerged} alias-merged`);
  SRC.close(); DST.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
