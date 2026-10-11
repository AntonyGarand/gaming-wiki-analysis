/**
 * extract-links.ts — parse ordered prose links from wikitext into a link table.
 *
 * For each mainspace page, extracts every [[link]] in the article body
 * (excluding templates, tables, refs, comments, galleries, file/category/
 * interwiki/namespace links), recording:
 *   - rank (1-based order of appearance)
 *   - target_id (resolved page ID, or null for redlinks)
 *   - paren (inside parentheses)
 *   - italic (italicised)
 *
 * Usage: npx tsx scripts/extract-links.ts --wiki=minecraft
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;
const wikiArg = process.argv.find((a) => a.startsWith("--wiki="))?.slice(7);
const wiki = wikis.find((w) => w.id === wikiArg);
if (!wiki) { console.error(`Unknown --wiki=${wikiArg}`); process.exit(1); }

const OUT_DIR = path.join(ROOT, "output", wiki.id);
const SRC = createClient({ url: `file:${path.join(OUT_DIR, "wiki.sqlite")}` });
const LINKS = createClient({ url: `file:${path.join(OUT_DIR, "links.sqlite")}` });

// --- wikitext parsing (same logic as the OSRS analysis, namespace-agnostic) ---
const INTERWIKI = new Set(["w","wikipedia","wp","wiktionary","wikt","m","mw","meta",
  "commons","s","b","q","nov","osw","rsw","zh","de","fr","es","pt","nl","lv","fi","pl","tr"]);

let SKIP_NS: Set<string>;
{
  const meta = await SRC.execute({ sql: "SELECT value FROM meta WHERE key = 'namespaces'", args: [] });
  const list = meta.rows.length ? JSON.parse(String(meta.rows[0].value)) : [];
  SKIP_NS = new Set([...list.map((s: string) => s.toLowerCase()), ...INTERWIKI]);
  console.log(`skip namespaces: ${SKIP_NS.size}`);
}

function stripCommentsAndRefs(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/\s*>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref\s*>/gi, "")
    .replace(/<gallery[\s\S]*?<\/gallery\s*>/gi, "");
}
function stripTemplates(text: string): string {
  let prev: string;
  do { prev = text; text = text.replace(/\{\{[^{}]*\}\}/g, ""); } while (text !== prev);
  return text;
}
function stripTables(text: string): string {
  let prev: string;
  do { prev = text; text = text.replace(/\{\|(?:(?!\{\|)[\s\S])*?\|\}/g, ""); } while (text !== prev);
  return text;
}
function tokenizeLinks(text: string): Array<{ start: number; end: number; raw: string }> {
  const spans: Array<{ start: number; end: number; raw: string }> = [];
  const stack: number[] = [];
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] === "[" && text[i + 1] === "[") { stack.push(i); i += 2; }
    else if (text[i] === "]" && text[i + 1] === "]") {
      const s = stack.pop();
      if (s === undefined) { i += 2; continue; }
      if (stack.length === 0) spans.push({ start: s, end: i + 2, raw: text.slice(s + 2, i) });
      i += 2;
    } else i++;
  }
  return spans;
}
function normKey(raw: string): string | null {
  let t = raw.split("|")[0].trim();
  const hash = t.indexOf("#");
  if (hash === 0) return null;
  if (hash > 0) t = t.slice(0, hash).trim();
  if (!t) return null;
  t = t.replace(/_/g, " ");
  t = t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

interface ParsedLink { rank: number; target: string; paren: boolean; italic: boolean }

function parseLinks(wikitext: string): ParsedLink[] {
  if (!wikitext) return [];
  let text = stripCommentsAndRefs(wikitext);
  const redirect = text.match(/^\s*#redirect\s*:?\s*\[\[([^\]]+)\]\]/i);
  if (redirect) {
    const t = normKey(redirect[1]);
    return t ? [{ rank: 1, target: t, paren: false, italic: false }] : [];
  }
  text = stripTables(stripTemplates(text));
  const spans = tokenizeLinks(text);
  const candidates: Array<{ target: string; start: number; end: number }> = [];
  let masked = "", last = 0;
  for (const s of spans) {
    const target = normKey(s.raw);
    if (!target) continue;
    const m = target.match(/^:?\s*([^:]+):/);
    if (m && SKIP_NS.has(m[1].toLowerCase().trim())) continue;
    masked += text.slice(last, s.start) + `\u0000${candidates.length}\u0000`;
    last = s.end;
    candidates.push({ target, start: s.start, end: s.end });
  }
  masked += text.slice(last);
  if (candidates.length === 0) return [];
  const out: ParsedLink[] = [];
  let depth = 0, i = 0, rank = 0;
  while (i < masked.length) {
    const c = masked[i];
    if (c === "\u0000") {
      const j = masked.indexOf("\u0000", i + 1);
      const idx = Number(masked.slice(i + 1, j));
      let k = i - 1, apostrophes = 0;
      while (k >= 0 && masked[k] === "'") { apostrophes++; k--; }
      const italic = apostrophes > 0 && apostrophes % 3 === 2;
      out.push({ rank: ++rank, target: candidates[idx].target, paren: depth > 0, italic });
      i = j + 1;
    } else {
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      i++;
    }
  }
  return out;
}

// --- build resolution maps ---
const byKey = new Map<string, number>();
const byKeyLower = new Map<string, number>();
const aliasKey = new Map<string, number>();
const aliasKeyLower = new Map<string, number>();
{
  let lastId = -1;
  for (;;) {
    const res = await SRC.execute({
      sql: "SELECT id, title, namespace, aliases FROM page WHERE id > ? ORDER BY id LIMIT 1500",
      args: [lastId],
    });
    if (res.rows.length === 0) break;
    for (const r of res.rows) {
      lastId = Number(r.id);
      byKey.set(String(r.title), lastId);
      byKeyLower.set(String(r.title).toLowerCase(), lastId);
      let aliases: unknown[] = [];
      try { aliases = JSON.parse(String(r.aliases ?? "[]")); } catch { }
      if (Array.isArray(aliases)) for (const a of aliases) {
        const k = String(a).charAt(0).toUpperCase() + String(a).slice(1);
        if (!aliasKey.has(k)) aliasKey.set(k, lastId);
        if (!aliasKeyLower.has(k.toLowerCase())) aliasKeyLower.set(k.toLowerCase(), lastId);
      }
    }
    if (res.rows.length < 1500) break;
  }
}
const resolve = (t: string): number | null => {
  const hit = byKey.get(t) ?? aliasKey.get(t) ?? byKeyLower.get(t.toLowerCase()) ?? aliasKeyLower.get(t.toLowerCase());
  return hit !== undefined ? hit : null;
};
console.log(`resolution: ${byKey.size} titles, ${aliasKey.size} aliases`);

// --- create output tables ---
await LINKS.execute(`CREATE TABLE IF NOT EXISTS page (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`);
await LINKS.execute(`CREATE TABLE IF NOT EXISTS link (
  page_id INTEGER NOT NULL, rank INTEGER NOT NULL,
  target_id INTEGER, paren INTEGER DEFAULT 0, italic INTEGER DEFAULT 0,
  PRIMARY KEY (page_id, rank)
)`);
// wipe old data
await LINKS.execute("DELETE FROM link");
await LINKS.execute("DELETE FROM page");

// --- extract ---
let totalPages = 0, totalLinks = 0;
{
  let lastId = -1;
  let pageBatch: Array<{ sql: string; args: any[] }> = [];
  let linkBatch: Array<{ sql: string; args: any[] }> = [];

  const flush = async () => {
    if (pageBatch.length) { await LINKS.batch(pageBatch as never); pageBatch = []; }
    for (let i = 0; i < linkBatch.length; i += 150) {
      await LINKS.batch(linkBatch.slice(i, i + 150) as never);
    }
    linkBatch = [];
  };

  for (;;) {
    const res = await SRC.execute({
      sql: "SELECT id, title, text FROM page WHERE namespace = 0 AND id > ? AND text IS NOT NULL ORDER BY id LIMIT 1000",
      args: [lastId],
    });
    if (res.rows.length === 0) break;
    for (const r of res.rows) {
      lastId = Number(r.id);
      totalPages++;
      pageBatch.push({ sql: "INSERT INTO page (id, title) VALUES (?, ?)", args: [lastId, String(r.title)] });
      for (const l of parseLinks(String(r.text ?? ""))) {
        totalLinks++;
        linkBatch.push({
          sql: "INSERT INTO link (page_id, rank, target_id, paren, italic) VALUES (?, ?, ?, ?, ?)",
          args: [lastId, l.rank, resolve(l.target), l.paren ? 1 : 0, l.italic ? 1 : 0],
        });
      }
    }
    if (pageBatch.length >= 200) await flush();
    if (totalPages % 5000 === 0) console.log(`  ${totalPages} pages, ${totalLinks} links`);
    if (res.rows.length < 1000) break;
  }
  await flush();
}

console.log(`[${wiki.id}] extracted ${totalLinks} links from ${totalPages} pages → ${path.join(OUT_DIR, "links.sqlite")}`);
