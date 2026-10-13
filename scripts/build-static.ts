/**
 * build-static.ts — bake the article into a fully static site under dist/.
 *
 * Requires the lab server running on :8787 for graph/mesh computation
 * (they reuse its cached logic); everything else reads output/ directly.
 *
 * Usage: npx tsx scripts/lab-server.ts   (in another shell)
 *        npx tsx scripts/build-static.ts
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;
const SERVER = "http://localhost:8787";

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_RE = new RegExp(`^((0?[1-9]|[12]\\d|3[01]) (${MONTHS})|(${MONTHS}) (0?[1-9]|[12]\\d|3[01]))(,? \\d{4})?$`, "i");
const YEAR_RE = /^(1[0-9]{3}|20[0-9]{2})$/;

function fetchJson(url: string, tries = 4): Promise<any> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number) => {
      const req = http.get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          if (n < tries) { setTimeout(() => attempt(n + 1), 500 * n); return; }
          reject(new Error(`${res.statusCode} ${url}`)); return;
        }
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.on("error", (e) => {
        if (n < tries) { setTimeout(() => attempt(n + 1), 500 * n); return; }
        reject(e);
      });
    };
    attempt(0);
  });
}

async function skippedTargets(wikiId: string): Promise<Set<number>> {
  const s = new Set<number>();
  const wikiDb = createClient({ url: `file:${path.join(ROOT, "output", wikiId, "wiki.sqlite")}` });
  try {
    const r = await wikiDb.execute(
      "SELECT id FROM page WHERE namespace = 0 AND ((instr(lower(substr(text,1,400)), 'may refer to:') > 0 OR instr(lower(substr(text,1,400)), '{{disambig') > 0) OR title LIKE '% (disambiguation)')"
    );
    for (const row of r.rows) s.add(Number(row.id));
  } finally { wikiDb.close(); }
  const ldb = createClient({ url: `file:${path.join(ROOT, "output", wikiId, "links.sqlite")}` });
  try {
    const r = await ldb.execute("SELECT id, title FROM page");
    for (const row of r.rows) {
      const t = String(row.title);
      if (DATE_RE.test(t) || YEAR_RE.test(t)) s.add(Number(row.id));
    }
  } finally { ldb.close(); }
  return s;
}

async function buildChains(wikiId: string, ranks: string[]) {
  const OUT = path.join(ROOT, "output", wikiId);
  const ldb = createClient({ url: `file:${path.join(OUT, "links.sqlite")}` });
  const pagesRes = await ldb.execute("SELECT id, title FROM page ORDER BY id");
  const ids = pagesRes.rows.map((r) => Number(r.id));
  const titles = new Map<number, string>(pagesRes.rows.map((r) => [Number(r.id), String(r.title)]));
  const idToIdx = new Map<number, number>(ids.map((id, i) => [id, i]));
  const N = ids.length;
  const titleOf = (i: number) => titles.get(ids[i]) ?? "?";

  const linksByPage = new Map<number, Array<{ rank: number; target: number | null; paren: boolean; italic: boolean }>>();
  {
    let lastRow = -1;
    for (;;) {
      const res = await ldb.execute({
        sql: "SELECT page_id, rank, target_id, paren, italic FROM link WHERE page_id > ? ORDER BY page_id, rank LIMIT 20000",
        args: [lastRow],
      });
      if (res.rows.length === 0) break;
      for (const r of res.rows) {
        const pid = Number(r.page_id); lastRow = pid;
        let arr = linksByPage.get(pid);
        if (!arr) { arr = []; linksByPage.set(pid, arr); }
        arr.push({ rank: Number(r.rank), target: r.target_id === null ? null : Number(r.target_id),
          paren: Number(r.paren) === 1, italic: Number(r.italic) === 1 });
      }
      if (res.rows.length < 20000) break;
    }
  }
  ldb.close();

  function rngFor(pageId: number): number {
    let x = (pageId ^ 0x9e3779b9) >>> 0;
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  }

  const skipped = await skippedTargets(wikiId);

  for (const rank of ranks) {
    const succ = new Int32Array(N).fill(-1);
    const deadReason = new Map<number, string>(); // page idx -> why it dies
    const nRank = rank === "strict1" ? 1 : (/^\d+$/.test(rank) ? Number(rank) : null);
    for (let i = 0; i < N; i++) {
      const links = linksByPage.get(ids[i]);
      if (!links || links.length === 0) { deadReason.set(i, "no eligible links"); continue; }
      const eligible = links.filter((l) => !l.paren && !l.italic && !(l.target !== null && skipped.has(l.target)));
      if (eligible.length === 0) { deadReason.set(i, "no eligible links"); continue; }
      let chosen: number | null = null;
      if (rank === "last") chosen = eligible[eligible.length - 1].target;
      else if (rank === "random") chosen = eligible[Math.floor(rngFor(ids[i]) * eligible.length)].target;
      else if (nRank !== null) {
        const at = eligible[nRank - 1];
        if (!at) { deadReason.set(i, `page has only ${eligible.length} eligible links`); continue; }
        chosen = at.target;
      }
      if (chosen === null) { deadReason.set(i, "redlink (unresolvable target)"); continue; }
      const idx = idToIdx.get(chosen);
      if (idx === undefined) { deadReason.set(i, "redlink (unresolvable target)"); continue; }
      succ[i] = idx;
    }

    const out: Record<string, [string[], number, number, string]> = {};
    for (let s = 0; s < N; s++) {
      const chain: string[] = [titleOf(s)];
      const seen = new Set<number>([s]);
      let cur = s, fate = 0, cycleSize = 0, reason = "";
      while (chain.length < 120) {
        const nx = succ[cur];
        if (nx === -1) { fate = 1; reason = deadReason.get(cur) ?? "chain breaks"; break; }
        if (seen.has(nx)) {
          const first = chain.findIndex((t) => t === titleOf(nx));
          cycleSize = first >= 0 ? chain.length - first : 1;
          break;
        }
        seen.add(nx);
        chain.push(titleOf(nx));
        cur = nx;
      }
      if (fate === 0 && cycleSize === 0) { cycleSize = 1; }
      out[chain[0]] = [chain, fate, cycleSize, reason];
    }
    const file = path.join(DIST, "data", wikiId, `chains-r${rank}.json`);
    fs.writeFileSync(file, JSON.stringify(out));
    console.log(`  chains-r${rank}: ${Object.keys(out).length} articles, ${(fs.statSync(file).size / 1e6).toFixed(1)}MB`);
  }
}

async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, "data"), { recursive: true });

  // article + module
  const html = fs.readFileSync(path.join(ROOT, "scripts", "article.html"), "utf8");
  const wikiJson = JSON.stringify(wikis.map((w: any) => ({ id: w.id, name: w.name, description: w.description })));
  // inject the static flag into the main inline script (the last <script> in the document)
  const idx = html.lastIndexOf("<script>");
  const withStatic = html.slice(0, idx) + '<script>window.__STATIC__ = true;\n' + html.slice(idx + "<script>".length);
  const baked = withStatic.replace("__WIKI_OPTIONS__", wikiJson);
  fs.writeFileSync(path.join(DIST, "index.html"), baked);
  fs.copyFileSync(path.join(ROOT, "scripts", "meshfield.js"), path.join(DIST, "meshfield.js"));

  // overview
  fs.writeFileSync(path.join(DIST, "data", "overview.json"), JSON.stringify(await fetchJson(`${SERVER}/api/overview`)));
  console.log("overview.json written");

  let chainWork: Array<Promise<void>> = [];
  for (const w of wikis) {
    const outDir = path.join(ROOT, "output", w.id);
    if (!fs.existsSync(path.join(outDir, "links.sqlite"))) continue;
    const ddir = path.join(DIST, "data", w.id);
    fs.mkdirSync(ddir, { recursive: true });

    fs.copyFileSync(path.join(outDir, "summary.json"), path.join(ddir, "summary.json"));
    const ranks = JSON.parse(fs.readFileSync(path.join(outDir, "summary.json"), "utf8")).ranks.map((r: any) => r.rank);
    for (const r of ranks) {
      const st = path.join(outDir, `stats-r${r}.json`);
      if (fs.existsSync(st)) fs.copyFileSync(st, path.join(ddir, `stats-r${r}.json`));
    }
    console.log(`${w.id}: summary + ${ranks.length} stats copied`);

    // graph + mesh from the running server (cached there)
    for (const r of ranks) {
      fs.writeFileSync(path.join(ddir, `graph-r${r}.json`), JSON.stringify(await fetchJson(`${SERVER}/api/graph?wiki=${w.id}&rank=${r}&detail=2`)));
      fs.writeFileSync(path.join(ddir, `mesh-r${r}.json`), JSON.stringify(await fetchJson(`${SERVER}/api/mesh?wiki=${w.id}&rank=${r}&n=150`)));
    }
    console.log(`${w.id}: graph + mesh for ${ranks.length} ranks fetched`);

    chainWork.push(buildChains(w.id, ranks).catch((e) => console.error(`${w.id} chains failed:`, e.message)));
  }
  await Promise.all(chainWork);
  console.log(`\nstatic build complete → ${DIST}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
