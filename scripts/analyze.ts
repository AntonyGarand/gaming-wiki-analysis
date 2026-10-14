/**
 * analyze.ts — Nth-link network analysis for one wiki.
 * Computes convergence, attractors, histograms, centrality, decay curves.
 *
 * The walk itself (eligibility rules, successor tables, attractor detection)
 * lives in lib/walk.ts — this file only turns a successor table into numbers.
 *
 * Usage: npx tsx scripts/analyze.ts --wiki=minecraft --ranks=strict1,1,2,3,5,last,random
 */
import * as fs from "fs";
import * as path from "path";
import { loadCorpus, successorsFor, analyzeFunctionalGraph, DEAD, TERM, plainLinkCount } from "./lib/walk.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;
const wikiArg = process.argv.find((a) => a.startsWith("--wiki="))?.slice(7) ?? "osrs";
const ranksArg = process.argv.find((a) => a.startsWith("--ranks="))?.slice(8) ?? "strict1,2,3,5,last,random";
const RANKS = ranksArg.split(",").map((s) => s.trim()).filter(Boolean);
const wiki = wikis.find((w) => w.id === wikiArg);
if (!wiki) { console.error(`Unknown --wiki=${wikiArg}`); process.exit(1); }

const OUT_DIR = path.join(ROOT, "output", wiki.id);
fs.mkdirSync(OUT_DIR, { recursive: true });

const FAMOUS: Record<string, string[]> = {};
// wiki-specific famous articles can be added here

async function main() {
  const t0 = Date.now();
  const corpus = await loadCorpus(wiki.id);
  const { ids, titles, linksByPage, skipTargets } = corpus;
  const N = ids.length;
  console.log(`[${wiki.id}] corpus: ${N} pages (${skipTargets.size} skipped targets)`);

  const summary: Array<Record<string, unknown>> = [];

  for (const rankKey of RANKS) {
    const { succ, term } = successorsFor(corpus, rankKey);
    const { attractor, dist, loops: attractors, inDeg } = analyzeFunctionalGraph(succ);

    const basinCount = new Map<number, number>();
    let noLinks = 0, tooFew = 0, unresolvable = 0, deadBasin = 0;
    for (let i = 0; i < N; i++) {
      if (term[i] === TERM.NO_LINKS) noLinks++;
      else if (term[i] === TERM.TOO_FEW) tooFew++;
      else if (term[i] === TERM.UNRESOLVED) unresolvable++;
      const a = attractor[i];
      if (a === DEAD) deadBasin++;
      else if (a !== -1) basinCount.set(a, (basinCount.get(a) ?? 0) + 1);
    }

    // --- dead-end terminals: where do non-converging chains actually die? ---
    const deadTerminal = new Map<number, { count: number; reason: string }>();
    for (let i = 0; i < N; i++) {
      if (attractor[i] !== DEAD) continue;
      // walk to the terminal node of this chain
      let cur = i; const seen = new Set();
      while (cur >= 0 && !seen.has(cur) && succ[cur] !== -1) { seen.add(cur); cur = succ[cur]; }
      // cur is now the terminal node (succ[cur] === -1 or a cycle back)
      const reason = term[cur] === TERM.NO_LINKS ? "no eligible links"
        : term[cur] === TERM.TOO_FEW ? `only ${plainLinkCount(corpus, cur)} eligible links`
        : term[cur] === TERM.UNRESOLVED ? "redlink target"
        : "chain breaks";
      const entry = deadTerminal.get(cur) ?? { count: 0, reason };
      entry.count++;
      deadTerminal.set(cur, entry);
    }
    const topDeadTerminals = [...deadTerminal.entries()]
      .sort((a, b) => b[1].count - a[1].count).slice(0, 15)
      .map(([nodeIdx, info]) => ({
        title: titles[nodeIdx],
        chains: info.count,
        pct: +(100 * info.count / N).toFixed(2),
        reason: info.reason,
      }));

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

    const topInDegree = Array.from(inDeg.keys()).sort((a, b) => inDeg[b] - inDeg[a]).slice(0, 30)
      .map((i) => ({ title: titles[i], inDegree: inDeg[i] }));

    const between = new Float64Array(N);
    for (let u = 0; u < N; u++) {
      if (succ[u] === -1) continue;
      const path: number[] = []; const seen = new Set<number>();
      let cur = u;
      while (cur !== -1 && !seen.has(cur) && path.length < 500) { seen.add(cur); path.push(cur); cur = succ[cur]; }
      for (let k = 1; k < path.length; k++) between[path[k]] += path.length - k - 1;
    }
    const topBetweenness = Array.from(between.keys()).sort((a, b) => between[b] - between[a]).slice(0, 30)
      .map((i) => ({ title: titles[i], betweenness: Math.round(between[i]) }));

    const cycles = ranked.map(([a, b]) => ({
      cycle: attractors[a].map((n) => titles[n]),
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
      deadEndTerminals: topDeadTerminals,
      roadsToTopAttractor: [],
      topInDegree, topBetweenness,
    };
    fs.writeFileSync(path.join(OUT_DIR, `stats-r${key}.json`), JSON.stringify(stats, null, 1));
    fs.writeFileSync(path.join(OUT_DIR, `distances-r${key}.csv`),
      "page_id,title,attractor,distance,fate\n" + Array.from({ length: Math.min(N, 50000) }, (_, i) => {
        const fate = attractor[i] === DEAD ? "dead-end" : attractor[i] === -1 ? "unvisited" : "cycle";
        const attr = attractor[i] >= 0 && attractors[attractor[i]]
          ? `"${attractors[attractor[i]].map((n) => titles[n]).join("|")}"` : "";
        return `${ids[i]},"${(titles[i] ?? "").replace(/"/g, '""')}","${attr}",${dist[i]},${fate}`;
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
