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
import { politeFetch, makeUA } from "./lib/http.js";
import { DATE_TITLE_RE, YEAR_RE } from "./lib/walk.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;
const wikiArg = process.argv.find((a) => a.startsWith("--wiki="))?.slice(7);
const FORCE = process.argv.includes("--force"); // re-parse every page, ignoring revision match
const wiki = wikis.find((w) => w.id === wikiArg);
if (!wiki) { console.error(`Unknown --wiki=${wikiArg}`); process.exit(1); }

const OUT_DIR = path.join(ROOT, "output", wiki.id);
const SRC = createClient({ url: `file:${path.join(OUT_DIR, "wiki.sqlite")}` });
const LINKS = createClient({ url: `file:${path.join(OUT_DIR, "links.sqlite")}` });

// --- wikitext parsing (same logic as the OSRS analysis, namespace-agnostic) ---
const INTERWIKI = new Set(["w","wikipedia","wp","wiktionary","wikt","m","mw","meta",
  "commons","s","b","q","nov","osw","rsw"]);
// language interwiki prefixes: [[cs:Zbraně]], [[ru:Оружие]], [[pt-br:Armas]] …
// these are translations, not walk targets (README: interwiki links excluded)
const LANG_PREFIX_RE = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/;
function isInterwikiPrefix(prefix: string): boolean {
  const p = prefix.toLowerCase().trim();
  return INTERWIKI.has(p) || LANG_PREFIX_RE.test(p);
}

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

// --- link-rendering templates: {{plink|Item}} and friends render as real
// links on the page, so their first positional parameter counts as one.
// The Weird Gloop set is the default (those wikis share it); wikis.json can
// add per-wiki templates (e.g. Minecraft's BlockLink/ItemLink family).
const LINK_TEMPLATES = new Set([
  "plink", "plinkt", "plinkp", "ilink", "scp", "gep", "reicon", "costline", "icon",
  "blocklink", "itemlink",
  ...(Array.isArray((wiki as any).linkTemplates)
    ? (wiki as any).linkTemplates.map((s: string) => String(s).toLowerCase())
    : []),
]);
function rewriteLinkTemplates(text: string): string {
  let prev: string;
  do {
    prev = text;
    // (?<!\{)/(?!\{) guard: {{{param}}} triple braces are parameter
    // placeholders, never template invocations
    text = text.replace(/(?<!\{)\{\{\s*([A-Za-z0-9 _-]+)((?:\|[^{}]*)?)\}\}(?!\{)/g, (full, name: string, rest: string) => {
      if (!LINK_TEMPLATES.has(String(name).trim().toLowerCase())) return full;
      for (const p of rest.split("|").slice(1)) {
        const s = p.trim();
        if (!s || s.includes("=")) continue;
        return `[[${s}]]`;
      }
      return full;
    });
  } while (text !== prev);
  return text;
}

// --- transclusions: {{:Page}} inlines another page's content ---
const pageTextCache = new Map<string, string | null>();
async function getPageText(title: string): Promise<string | null> {
  if (pageTextCache.has(title)) return pageTextCache.get(title) ?? null;
  const r = await SRC.execute({ sql: "SELECT text FROM page WHERE title = ? COLLATE NOCASE LIMIT 1", args: [title] });
  const t = r.rows.length && r.rows[0].text ? String(r.rows[0].text) : null;
  pageTextCache.set(title, t);
  return t;
}
/**
 * How a page's wikitext looks when transcluded into another page
 * (MediaWiki semantics): <noinclude> drops, <includeonly> unwraps,
 * <onlyinclude> keeps just those spans. Refs/galleries/comments never
 * render as body links, so they drop too.
 */
function transclusionView(body: string): string {
  let t = stripCommentsAndRefs(body);
  const only = [...t.matchAll(/<onlyinclude[^>]*>([\s\S]*?)<\/onlyinclude\s*>/gi)];
  if (only.length) return only.map((m) => m[1]).join("\n");
  t = t.replace(/<noinclude[^>]*>[\s\S]*?<\/noinclude\s*>/gi, "");
  t = t.replace(/<includeonly[^>]*>/gi, "").replace(/<\/includeonly\s*>/gi, "");
  return t;
}
async function expandTransclusions(text: string, depth: number, seen?: Set<string>): Promise<string> {
  if (depth <= 0) return text;
  const matches = [...text.matchAll(/\{\{\s*:\s*([^|}]+)[^}]*\}\}/g)];
  if (!matches.length) return text;
  seen ??= new Set();
  let out = text;
  for (const m of matches) {
    const title = normKey(m[1]);
    if (!title || seen.has(title)) continue; // cycle / already inlined above us
    const sub = await getPageText(title);
    if (sub === null) continue;
    seen.add(title);
    const inner = await expandTransclusions(transclusionView(sub), depth - 1, seen);
    out = out.split(m[0]).join("\n" + inner + "\n"); // literal replace, no $-pattern surprises
  }
  return out;
}
function stripTables(text: string): string {
  let prev: string;
  do { prev = text; text = text.replace(/\{\|(?:(?!\{\|)[\s\S])*?\|\}/g, ""); } while (text !== prev);
  return text;
}

// --- template expansion for fallback pages ---
//
// Some pages' entire body text is generated by templates whose prose renders
// on the page (e.g. OSRS's {{Treasure Trails Guide Anagrams Intro}}). The
// strict parse strips every {{...}} invocation, so those pages fall through
// to the table-link fallback and their prose links are never seen. For those
// pages only, we fetch the invoked templates from the wiki, keep the ones
// that are self-contained prose (links written out in the body, no
// parameters), and inline them at their invocation site before the fallback
// re-parse.
//
// A template is expanded only when ALL of these hold:
//   1. its name is not a known chrome pattern (navbox/infobox/toc/hatnote/…)
//      and not a single-link renderer (LINK_TEMPLATES, rewritten separately)
//   2. its body contains no {{{parameter}}} placeholders — machinery that
//      builds links from arguments ({{main|X}}, {{SCP|...}}) never expands
//   3. after transclusionView, it still has a [[link]] in running text
//      outside tables and nested invocations — i.e. it renders prose

// fetched template bodies, keyed by lowercase name; null = known missing
const templateCache = new Map<string, string | null>();
const UA = makeUA(wiki.id);
let templatesFetched = 0, templatesMissing = 0;

const CHROME_PLAIN_PREFIXES = [
  "navbox", "navbar", "infobox", "toc", "sidebar", "hatnote", "shortcut",
  "stub", "disambig", "documentation", "metadata", "mbox", "ambox", "cleanup",
];
const CHROME_WORD_PREFIXES = [ // matched as exact word or word + separator
  "about", "main", "see", "for", "further", "detail", "delete", "merge",
  "external", "redirect",
];
function isChromeTemplateName(lowerName: string): boolean {
  const n = lowerName.trim().toLowerCase();
  if (n.includes("navbox") || n.includes("navbar") || n.includes("navigation")) return true;
  if (n.endsWith("nav")) return true; // TechNav, BuildingNav, …
  for (const p of CHROME_PLAIN_PREFIXES) if (n.startsWith(p)) return true;
  for (const p of CHROME_WORD_PREFIXES) {
    if (n === p || n.startsWith(p + " ") || n.startsWith(p + "/") || n.startsWith(p + ":")) return true;
  }
  return false;
}

const proseBodyMemo = new Map<string, boolean>();
function isProseTemplateBody(lowerName: string, body: string): boolean {
  const hit = proseBodyMemo.get(lowerName);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    let t = transclusionView(body);
    if (!t.includes("{{{")) {
      // links must live in running text: outside tables and nested invocations
      t = stripTables(t).replace(/\{\{[^{}]*\}\}/g, "");
      ok = /\[\[[^[\]{}]+\]\]/.test(t);
    }
  } catch { ok = false; }
  proseBodyMemo.set(lowerName, ok);
  return ok;
}

/** normalize a flat invocation's name; null when it is not a named template */
function templateInvocationName(raw: string): string | null {
  let name = raw.split("|")[0].trim();
  name = name.replace(/^template\s*:\s*/i, "");
  if (!name) return null;
  if (name.startsWith("#") || name.startsWith(":")) return null;
  if (/^(subst|safesubst|msgnw|raw)\s*:/i.test(name)) return null;
  return name;
}

/** template names worth fetching for a fallback page, in first-seen order */
function collectTemplateNames(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?<!\{)\{\{([^{}]+)\}\}(?!\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = templateInvocationName(m[1]);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (LINK_TEMPLATES.has(key)) continue; // single-link renderers, rewritten elsewhere
    if (isChromeTemplateName(key)) continue;
    seen.add(key);
    out.push(name.charAt(0).toUpperCase() + name.slice(1));
  }
  return out;
}

/** fetch uncached templates via the API (50/request) and persist them */
async function ensureTemplates(names: string[]): Promise<void> {
  const want = [...new Map(
    names.map((n) => n.trim()).filter(Boolean)
      .filter((n) => !templateCache.has(n.toLowerCase()))
      .map((n) => [n.toLowerCase(), n.charAt(0).toUpperCase() + n.slice(1)])
  ).values()];
  if (!want.length) return;
  for (let i = 0; i < want.length; i += 50) {
    const chunk = want.slice(i, i + 50);
    const data: any = await politeFetch(wiki.origin, UA, {
      action: "query", format: "json", formatversion: "2",
      prop: "revisions", rvprop: "content|ids", rvslots: "main", redirects: "1",
      titles: chunk.map((n) => `Template:${n}`).join("|"),
    });
    // resolve normalized titles + redirects: requested "Template:X" -> final page
    const alias = new Map<string, string>();
    for (const e of data?.query?.normalized ?? []) alias.set(String(e.from).toLowerCase(), String(e.to).toLowerCase());
    for (const e of data?.query?.redirects ?? []) alias.set(String(e.from).toLowerCase(), String(e.to).toLowerCase());
    const pagesByTitle = new Map<string, any>();
    for (const p of data?.query?.pages ?? []) pagesByTitle.set(String(p.title).toLowerCase(), p);
    const resolveKey = (fullLower: string): string => {
      const path = new Set<string>();
      let cur = fullLower;
      while (alias.has(cur) && !path.has(cur)) { path.add(cur); cur = alias.get(cur)!; }
      return cur.startsWith("template:") ? cur : `template:${cur}`;
    };
    const rows: Array<{ sql: string; args: unknown[] }> = [];
    for (const reqName of chunk) {
      const pg = pagesByTitle.get(resolveKey(`template:${reqName}`.toLowerCase()));
      const content = pg?.revisions?.[0]?.slots?.main?.content;
      const revid = pg?.revisions?.[0]?.revid ?? null;
      const body = !pg?.missing && typeof content === "string" ? content : null;
      templateCache.set(reqName.toLowerCase(), body);
      templatesFetched++;
      if (body === null) templatesMissing++;
      rows.push({ sql: "INSERT OR REPLACE INTO template (title, text, revision_id) VALUES (?, ?, ?)",
        args: [reqName, body, revid] });
    }
    for (let j = 0; j < rows.length; j += 50) await SRC.batch(rows.slice(j, j + 50) as never);
  }
}

/** inline eligible prose templates where they are invoked (fallback mode only) */
async function expandNamedTemplates(text: string, depth = 2, seen = new Set<string>()): Promise<string> {
  if (depth <= 0) return text;
  const re = /(?<!\{)\{\{([^{}]+)\}\}(?!\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = templateInvocationName(m[1]);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key) || LINK_TEMPLATES.has(key) || isChromeTemplateName(key)) continue;
    const body = templateCache.get(key);
    if (body == null || !isProseTemplateBody(key, body)) continue;
    seen.add(key);
    const inner = await expandNamedTemplates(transclusionView(body), depth - 1, seen);
    text = text.split(m[0]).join("\n" + inner + "\n");
    re.lastIndex = 0; // text mutated — rescan from the top
  }
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

async function parseLinks(wikitext: string, fallback = false): Promise<ParsedLink[]> {
  if (!wikitext) return [];
  let text = stripCommentsAndRefs(wikitext);
  const redirect = text.match(/^\s*#redirect\s*:?\s*\[\[([^\]]+)\]\]/i);
  if (redirect) {
    const t = normKey(redirect[1]);
    return t ? [{ rank: 1, target: t, paren: false, italic: false }] : [];
  }
  if (fallback) {
    // prose templates render body text the strict parse cannot see —
    // inline the eligible ones at their invocation site first
    text = await expandNamedTemplates(text);
  }
  text = rewriteLinkTemplates(await expandTransclusions(text, 2));
  if (fallback) {
    // table- and template-built pages (guide tables, cost lists): keep everything
    // that renders — links inside table cells and template parameters count
  } else {
    text = stripTables(stripTemplates(text));
  }
  const spans = tokenizeLinks(text);
  const candidates: Array<{ target: string; start: number; end: number }> = [];
  let masked = "", last = 0;
  for (const s of spans) {
    const target = normKey(s.raw);
    if (!target) continue;
    const m = target.match(/^:?\s*([^:]+):/);
    if (m && (SKIP_NS.has(m[1].toLowerCase().trim()) || isInterwikiPrefix(m[1]))) continue;
    masked += text.slice(last, s.start) + `\u0000${candidates.length}\u0000`;
    last = s.end;
    candidates.push({ target, start: s.start, end: s.end });
  }
  masked += text.slice(last);
  if (candidates.length === 0) return [];
  const out: ParsedLink[] = [];
  let depth = 0, italic = false, i = 0, rank = 0;
  while (i < masked.length) {
    const c = masked[i];
    if (c === "'") {
      // apostrophe runs track render state: '' toggles italics, ''' is bold
      // (ignored), ''''' toggles both — so italics wrap whole hatnotes, not
      // just the characters immediately beside a link
      let run = 1;
      while (masked[i + run] === "'") run++;
      if (run === 2 || run === 5) italic = !italic;
      i += run;
      continue;
    }
    if (c === "\u0000") {
      const j = masked.indexOf("\u0000", i + 1);
      const idx = Number(masked.slice(i + 1, j));
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
// walk-ineligible targets (mirrors lib/walk.ts skip rules): date / bare-year
// titles and disambiguation pages. The fallback trigger needs to know which
// links the walk could actually take — a page whose only strict links land
// on dates (e.g. rs3 achievement pages with trivia dates) must fall back too.
const walkSkip = new Set<number>();
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
      if (Number(r.namespace) === 0
        && (DATE_TITLE_RE.test(String(r.title)) || YEAR_RE.test(String(r.title)))) {
        walkSkip.add(lastId);
      }
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
  // disambiguation pages — same heuristic as lib/walk.ts
  const disambig = await SRC.execute(
    "SELECT id FROM page WHERE namespace = 0 AND ((instr(lower(substr(text,1,400)), 'may refer to:') > 0 OR instr(lower(substr(text,1,400)), '{{disambig') > 0) OR title LIKE '% (disambiguation)')"
  );
  for (const row of disambig.rows) walkSkip.add(Number(row.id));
}
const resolve = (t: string): number | null => {
  const hit = byKey.get(t) ?? aliasKey.get(t) ?? byKeyLower.get(t.toLowerCase()) ?? aliasKeyLower.get(t.toLowerCase());
  return hit !== undefined ? hit : null;
};
console.log(`resolution: ${byKey.size} titles, ${aliasKey.size} aliases, ${walkSkip.size} walk-ineligible targets`);

// --- create output tables ---
await LINKS.execute(`CREATE TABLE IF NOT EXISTS page (id INTEGER PRIMARY KEY, title TEXT NOT NULL, revision_id INTEGER)`);
await LINKS.execute(`CREATE TABLE IF NOT EXISTS link (
  page_id INTEGER NOT NULL, rank INTEGER NOT NULL,
  target_id INTEGER, paren INTEGER DEFAULT 0, italic INTEGER DEFAULT 0,
  PRIMARY KEY (page_id, rank)
)`);
// migration: add revision_id column if upgrading from old schema
try {
  await LINKS.execute("ALTER TABLE page ADD COLUMN revision_id INTEGER");
} catch { /* column already exists */ }

// template bodies fetched for fallback pages live next to the raw pages
await SRC.execute(`CREATE TABLE IF NOT EXISTS template (title TEXT PRIMARY KEY, text TEXT, revision_id INTEGER)`);
{
  const res = await SRC.execute("SELECT title, text FROM template");
  for (const r of res.rows) templateCache.set(String(r.title).toLowerCase(), r.text === null ? null : String(r.text));
}

// --- parser versioning: bump when parseLinks semantics change, so
// unchanged revisions get re-extracted once under the new rules ---
const PARSER_VERSION = "3-walk-aware-fallback";
await LINKS.execute(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
const prevParserVersion = String(
  (await LINKS.execute({ sql: "SELECT value FROM meta WHERE key = 'parserVersion'", args: [] })).rows[0]?.value ?? ""
);
const parserChanged = prevParserVersion !== PARSER_VERSION;

// --- incremental: load already-extracted pages with their revision IDs ---
const extractedRevs = new Map<number, number>(); // page_id → revision_id at extract time
{
  const res = await LINKS.execute("SELECT id, revision_id FROM page");
  for (const r of res.rows) {
    extractedRevs.set(Number(r.id), r.revision_id === null ? -1 : Number(r.revision_id));
  }
}
console.log(`already extracted: ${extractedRevs.size} pages`);

// --- extract (incremental: only re-parse pages with changed revisions) ---
let totalPages = 0, totalLinks = 0, skipped = 0, reExtracted = 0, newPages = 0;
let fallbackPages = 0, expandedFallback = 0;
{
  let lastId = -1;
  let pageBatch: Array<{ sql: string; args: any[] }> = [];
  let linkBatch: Array<{ sql: string; args: any[] }> = [];
  let deleteBatch: Array<{ sql: string; args: any[] }> = [];

  const flush = async () => {
    for (const d of deleteBatch) await LINKS.execute(d);
    deleteBatch = [];
    if (pageBatch.length) { await LINKS.batch(pageBatch as never); pageBatch = []; }
    for (let i = 0; i < linkBatch.length; i += 150) {
      await LINKS.batch(linkBatch.slice(i, i + 150) as never);
    }
    linkBatch = [];
  };

  const seenIds = new Set<number>();
  for (;;) {
    const res = await SRC.execute({
      sql: "SELECT id, title, text, revision_id FROM page WHERE namespace = 0 AND id > ? AND text IS NOT NULL ORDER BY id LIMIT 1000",
      args: [lastId],
    });
    if (res.rows.length === 0) break;
    for (const r of res.rows) {
      lastId = Number(r.id);
      totalPages++;
      seenIds.add(lastId);
      const revId = r.revision_id === null ? -1 : Number(r.revision_id);
      const prevRev = extractedRevs.get(lastId);

      if (!FORCE && !parserChanged && prevRev !== undefined && prevRev === revId) {
        // unchanged since last extract — skip
        skipped++;
        continue;
      }

      if (prevRev !== undefined) {
        // revision changed — delete old links, re-extract
        reExtracted++;
        deleteBatch.push({ sql: "DELETE FROM link WHERE page_id = ?", args: [lastId] });
        pageBatch.push({ sql: "UPDATE page SET title = ?, revision_id = ? WHERE id = ?",
          args: [String(r.title), revId, lastId] });
      } else {
        // new page
        newPages++;
        pageBatch.push({ sql: "INSERT OR REPLACE INTO page (id, title, revision_id) VALUES (?, ?, ?)",
          args: [lastId, String(r.title), revId] });
      }

      let links = await parseLinks(String(r.text ?? ""));
      // greedy rescue for table/template-built pages: if the strict parse
      // yields no link the walk could actually take (non-parenthesised,
      // non-italicised, resolvable, not a date/disambiguation target, not a
      // self-link), keep everything that renders — the page's real links
      // live in tables and templates (Tarkov's category listings, rs3's
      // achievement pages whose only strict links are trivia dates, …)
      const walkEligible = (l: ParsedLink) => {
        if (l.paren || l.italic) return false;
        const t = resolve(l.target);
        return t !== null && t !== lastId && !walkSkip.has(t);
      };
      if (!links.some(walkEligible)) {
        // the page's prose may be generated by self-contained templates
        // (e.g. guide intro templates) — fetch them, then re-parse with
        // the eligible ones inlined
        fallbackPages++;
        const needed = collectTemplateNames(String(r.text ?? ""));
        if (needed.length) {
          await ensureTemplates(needed);
          const anyProse = needed.some((n) => {
            const body = templateCache.get(n.toLowerCase());
            return body != null && isProseTemplateBody(n.toLowerCase(), body);
          });
          if (anyProse) expandedFallback++;
        }
        links = await parseLinks(String(r.text ?? ""), true);
      }
      for (const l of links) {
        totalLinks++;
        linkBatch.push({
          sql: "INSERT INTO link (page_id, rank, target_id, paren, italic) VALUES (?, ?, ?, ?, ?)",
          args: [lastId, l.rank, resolve(l.target), l.paren ? 1 : 0, l.italic ? 1 : 0],
        });
      }
    }
    if (pageBatch.length >= 200 || deleteBatch.length > 0) await flush();
    if (totalPages % 5000 === 0) console.log(`  ${totalPages} pages scanned (${newPages} new, ${reExtracted} changed, ${skipped} unchanged)`);
    if (res.rows.length < 1000) break;
  }
  await flush();

  // remove pages that no longer exist in the source
  let removed = 0;
  for (const [pid] of extractedRevs) {
    if (!seenIds.has(pid)) {
      await LINKS.execute({ sql: "DELETE FROM link WHERE page_id = ?", args: [pid] });
      await LINKS.execute({ sql: "DELETE FROM page WHERE id = ?", args: [pid] });
      removed++;
    }
  }
  if (removed > 0) console.log(`  removed ${removed} deleted pages`);
}

await LINKS.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('parserVersion', ?)", args: [PARSER_VERSION] });

console.log(`[${wiki.id}] extract done: ${newPages} new, ${reExtracted} updated, ${skipped} unchanged (${totalLinks} links) → ${path.join(OUT_DIR, "links.sqlite")}`);
console.log(`[${wiki.id}] fallback pages: ${fallbackPages} (${expandedFallback} gained prose-template links; templates: ${templatesFetched} fetched, ${templatesMissing} missing)`);
