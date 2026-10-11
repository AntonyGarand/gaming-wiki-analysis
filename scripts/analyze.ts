/**
 * analyze.ts — Nth-link network analysis for one wiki.
 * Computes convergence, attractors, histograms, centrality, decay curves.
 *
 * Usage: npx tsx scripts/analyze.ts --wiki=minecraft --ranks=strict1,1,2,3,5,last,random
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;
const wikiArg = process.argv.find((a) => a.startsWith("--wiki="))?.slice(7) ?? "osrs";
const ranksArg = process.argv.find((a) => a.startsWith("--ranks="))?.slice(8) ?? "strict1,1,2,3,5,last,random";
const RANKS = ranksArg.split(",").map((s) => s.trim()).filter(Boolean);
const wiki = wikis.find((w) => w.id === wikiArg);
if (!wiki) { console.error(`Unknown --wiki=${wikiArg}`); process.exit(1); }

const OUT_DIR = path.join(ROOT, "output", wiki.id);
fs.mkdirSync(OUT_DIR, { recursive: true });
const db = createClient({ url: `file:${path.join(OUT_DIR, "links.sqlite")}` });

const FAMOUS: Record<string, string[]> = {};
// wiki-specific famous articles can be added here

async function main() {
  const t0 = Date.now();
  const pagesRes = await db.execute("SELECT id, title FROM page ORDER BY id");
  const ids = pagesRes.rows.map((r) => Number(r.id));
  const titles = new Map<number, string>(pagesRes.rows.map((r) => [Number(r.id), String(r.title)]));
  const N = ids.length;
  const idToIdx = new Map<number, number>(ids.map((id, i) => [id, i]));
  console.log(`[${wiki.id}] corpus: ${N} pages`);

  const linksByPage = new Map<number, Array<{ rank: number; target: number | null; paren: boolean; italic: boolean }>>();
  {
    let lastRow = -1;
    for (;;) {
      const res = await db.execute({
        sql: "SELECT page_id, rank, target_id, paren, italic FROM link WHERE page_id > ? ORDER BY page_id, rank LIMIT 5000",
        args: [lastRow],
      });
      if (res.rows.length === 0) break;
      for (const r of res.rows) {
        const pid = Number(r.page_id);
        lastRow = pid;
        let arr = linksByPage.get(pid);
        if (!arr) { arr = []; linksByPage.set(pid, arr); }
        arr.push({ rank: Number(r.rank), target: r.target_id === null ? null : Number(r.target_id),
          paren: Number(r.paren) === 1, italic: Number(r.italic) === 1 });
      }
      if (res.rows.length < 5000) break;
    }
  }
  console.log(`[${wiki.id}] links loaded`);

  function rngFor(pageId: number): number {
    let x = (pageId ^ 0x9e3779b9) >>> 0;
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  }

  function successorsFor(rankKey: string): { succ: Int32Array; term: Uint8Array } {
    const succ = new Int32Array(N).fill(-1);
    const term = new Uint8Array(N);
    const nRank = /^\d+$/.test(rankKey) ? Number(rankKey) : null;
    for (let i = 0; i < N; i++) {
      const links = linksByPage.get(ids[i]);
      if (!links || links.length === 0) { term[i] = 1; continue; }
      let chosen: number | null = null;
      if (rankKey === "strict1") {
        const first = links.find((l) => !l.paren && !l.italic);
        chosen = first ? first.target : null;
        if (!first) { term[i] = 1; continue; }
      } else if (rankKey === "last") {
        chosen = links[links.length - 1].target;
      } else if (rankKey === "random") {
        chosen = links[Math.floor(rngFor(ids[i]) * links.length)].target;
      } else if (nRank !== null) {
        const at = links.find((l) => l.rank === nRank);
        if (!at) { term[i] = 2; continue; }
        chosen = at.target;
      } else { term[i] = 1; continue; }
      if (chosen === null) { term[i] = 3; continue; }
      const idx = idToIdx.get(chosen);
      if (idx === undefined) { term[i] = 3; continue; }
      succ[i] = idx;
    }
    return { succ, term };
  }

  const summary: Array<Record<string, unknown>> = [];

  for (const rankKey of RANKS) {
    const { succ, term } = successorsFor(rankKey);
    const attractor = new Int32Array(N).fill(-1);
    const dist = new Int32Array(N).fill(-1);
    const attractors: Array<{ nodes: number[] }> = [];
    const DEAD = -2;
    const mark = new Int32Array(N).fill(-1);
    let walkId = 0;
    for (let s = 0; s < N; s++) {
      if (mark[s] !== -1) continue;
      walkId++;
      const path: number[] = [], posInPath = new Map<number, number>();
      let cur = s;
      for (;;) {
        if (mark[cur] === walkId) {
          const at = posInPath.get(cur)!;
          const a = attractors.push({ nodes: path.slice(at) }) - 1;
          for (const n of attractors[a].nodes) { attractor[n] = a; dist[n] = 0; }
          for (let p = at - 1; p >= 0; p--) { attractor[path[p]] = a; dist[path[p]] = at - p; }
          break;
        }
        if (mark[cur] !== -1) {
          const t2 = attractor[cur], base = t2 === DEAD ? 0 : dist[cur];
          for (let p = path.length - 1; p >= 0; p--) { attractor[path[p]] = t2; dist[path[p]] = base + (path.length - p); }
          break;
        }
        mark[cur] = walkId; posInPath.set(cur, path.length); path.push(cur);
        const nx = succ[cur];
        if (nx === -1) { for (let p = 0; p < path.length; p++) { attractor[path[p]] = DEAD; dist[path[p]] = path.length - 1 - p; } break; }
        if (nx === cur) {
          const a = attractors.push({ nodes: [cur] }) - 1;
          attractor[cur] = a; dist[cur] = 0;
          for (let p = path.length - 2; p >= 0; p--) { attractor[path[p]] = a; dist[path[p]] = path.length - 1 - p; }
          break;
        }
        cur = nx;
      }
    }

    const basinCount = new Map<number, number>();
    let noLinks = 0, tooFew = 0, unresolvable = 0, deadBasin = 0;
    for (let i = 0; i < N; i++) {
      if (term[i] === 1) noLinks++;
      else if (term[i] === 2) tooFew++;
      else if (term[i] === 3) unresolvable++;
      const a = attractor[i];
      if (a === DEAD) deadBasin++;
      else if (a !== -1) basinCount.set(a, (basinCount.get(a) ?? 0) + 1);
    }
    const ranked = [...basinCount.entries()].sort((x, y) => y[1] - x[1]);
    const cycled = ranked.reduce((acc, [, b]) => acc + b, 0);
    const dists: number[] = [];
    for (let i = 0; i < N; i++) if (attractor[i] !== DEAD && attractor[i] !== -1 && dist[i] >= 0) dists.push(dist[i]);
    dists.sort((a, b) => a - b);
    const histogram: Record<string, number> = {};
    for (const d of dists) histogram[String(d)] = (histogram[String(d)] ?? 0) + 1;
    const hopStats = {
      mean: +(dists.reduce((a, b) => a + b, 0) / (dists.length || 1)).toFixed(2),
      median: dists[Math.floor(dists.length / 2)] ?? null,
      p90: dists[Math.floor(dists.length * 0.9)] ?? null,
      max: dists[dists.length - 1] ?? null,
    };

    const inDeg = new Int32Array(N);
    for (let i = 0; i < N; i++) if (succ[i] >= 0) inDeg[succ[i]]++;
    const topInDegree = Array.from(inDeg.keys()).sort((a, b) => inDeg[b] - inDeg[a]).slice(0, 30)
      .map((i) => ({ title: titles.get(ids[i])!, inDegree: inDeg[i] }));

    const between = new Float64Array(N);
    for (let u = 0; u < N; u++) {
      if (succ[u] === -1) continue;
      const path: number[] = []; const seen = new Set<number>();
      let cur = u;
      while (cur !== -1 && !seen.has(cur) && path.length < 500) { seen.add(cur); path.push(cur); cur = succ[cur]; }
      for (let k = 1; k < path.length; k++) between[path[k]] += path.length - k - 1;
    }
    const topBetweenness = Array.from(between.keys()).sort((a, b) => between[b] - between[a]).slice(0, 30)
      .map((i) => ({ title: titles.get(ids[i])!, betweenness: Math.round(between[i]) }));

    const cycles = ranked.map(([a, b]) => ({
      cycle: attractors[a].nodes.map((n) => titles.get(ids[n])!),
      basin: b, pct: +(100 * b / N).toFixed(2),
    }));

    const key = rankKey.replace(/[^a-z0-9]+/gi, "");
    const stats = {
      wiki: wiki.id, rank: rankKey, nodes: N,
      converge: { articles: cycled, pct: +(100 * cycled / N).toFixed(2),
        deadEnd: deadBasin, deadEndPct: +(100 * deadBasin / N).toFixed(2),
        noLinks, tooFewLinks: tooFew, unresolvable },
      hopStats, histogram,
      components: ranked.length + (deadBasin > 0 ? 1 : 0),
      cycleCount: ranked.length,
      largestCycle: cycles[0] ? { members: cycles[0].cycle, size: cycles[0].cycle.length, basin: cycles[0].basin } : null,
      topAttractors: cycles.slice(0, 20),
      roadsToTopAttractor: [],
      topInDegree, topBetweenness,
    };
    fs.writeFileSync(path.join(OUT_DIR, `stats-r${key}.json`), JSON.stringify(stats, null, 1));
    fs.writeFileSync(path.join(OUT_DIR, `distances-r${key}.csv`),
      "page_id,title,attractor,distance,fate\n" + Array.from({ length: Math.min(N, 50000) }, (_, i) => {
        const fate = attractor[i] === DEAD ? "dead-end" : attractor[i] === -1 ? "unvisited" : "cycle";
        const attr = attractor[i] >= 0 && attractors[attractor[i]]
          ? `"${attractors[attractor[i]].nodes.map((n) => titles.get(ids[n])).join("|")}"` : "";
        return `${ids[i]},"${(titles.get(ids[i]) ?? "").replace(/"/g, '""')}","${attr}",${dist[i]},${fate}`;
      }).join("\n"));

    summary.push({
      rank: rankKey, convergePct: stats.converge.pct, deadEndPct: stats.converge.deadEndPct,
      components: stats.components, cycleCount: stats.cycleCount,
      meanHops: hopStats.mean, medianHops: hopStats.median, maxHops: hopStats.max,
      topAttractor: cycles[0]?.cycle ?? null, topAttractorPct: cycles[0]?.pct ?? 0,
    });
    console.log(`  rank=${rankKey}: ${stats.converge.pct}% converge, top attractor ${cycles[0]?.pct ?? 0}%`);
  }

  fs.writeFileSync(path.join(OUT_DIR, "summary.json"),
    JSON.stringify({ wiki: wiki.id, generatedAt: new Date().toISOString(), ranks: summary }, null, 1));
  console.log(`[${wiki.id}] done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
