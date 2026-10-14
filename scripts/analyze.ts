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
import { loadCorpus, successorsFor, analyzeFunctionalGraph, DEAD, TERM, eligibleLinkCount } from "./lib/walk.js";

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
    const { succ, term } = successorsFor(corpus, rankKey); // random rank: seed 0's table
    const { attractor, dist, loops: attractors, inDeg } = analyzeFunctionalGraph(succ);

    // the random rank is stochastic: run several seeds and report the spread.
    // seed 0 above stays the canonical table used for stats and output files.
    let randomSeeds: { seeds: number; convergePct: { mean: number; sd: number }; topAttractorPct: { mean: number; sd: number } } | null = null;
    if (rankKey === "random") {
      const conv: number[] = [], top: number[] = [];
      for (let seed = 0; seed < 5; seed++) {
        const { succ: s2 } = successorsFor(corpus, rankKey, seed);
        const { attractor: at2 } = analyzeFunctionalGraph(s2);
        let cyc = 0;
        const basin = new Map<number, number>();
        for (let i = 0; i < N; i++) {
          const a = at2[i];
          if (a === DEAD) continue;
          if (a >= 0) { cyc++; basin.set(a, (basin.get(a) ?? 0) + 1); }
        }
        conv.push((100 * cyc) / N);
        top.push((100 * Math.max(0, ...basin.values())) / N);
      }
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
      randomSeeds = {
        seeds: 5,
        convergePct: { mean: +mean(conv).toFixed(2), sd: +sd(conv).toFixed(2) },
        topAttractorPct: { mean: +mean(top).toFixed(2), sd: +sd(top).toFixed(2) },
      };
      console.log(`  random over ${randomSeeds.seeds} seeds: converge ${randomSeeds.convergePct.mean}±${randomSeeds.convergePct.sd}, top attractor ${randomSeeds.topAttractorPct.mean}±${randomSeeds.topAttractorPct.sd}`);
    }

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
        : term[cur] === TERM.TOO_FEW ? `only ${eligibleLinkCount(corpus, cur)} eligible links`
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

    // how many pages' chosen (first/Nth/last/random) link points at each node —
    // for the strict-first rank this is "most linked-at by first links"
    const topFirstLinkTargets = Array.from(inDeg.keys()).sort((a, b) => inDeg[b] - inDeg[a]).slice(0, 30)
      .map((i) => ({ title: titles[i], firstLinks: inDeg[i] }));

    // chain traffic: how many chains pass through each node (successor path
    // walk from every start, counted once per chain)
    const traffic = new Int32Array(N);
    for (let u = 0; u < N; u++) {
      let cur = u;
      const seen = new Set<number>();
      while (cur !== -1 && !seen.has(cur)) { seen.add(cur); traffic[cur]++; cur = succ[cur]; }
    }
    const topThroughTraffic = Array.from(traffic.keys()).sort((a, b) => traffic[b] - traffic[a]).slice(0, 30)
      .map((i) => ({ title: titles[i], chains: traffic[i] }));

    const cycles = ranked.map(([a, b]) => ({
      cycle: attractors[a].map((n) => titles[n]),
      basin: b, pct: +(100 * b / N).toFixed(2),
    }));

    const key = rankKey.replace(/[^a-z0-9]+/gi, "");

    // eligible-link distribution: how many walkable links each page has
    const hist: Record<string, number> = {};
    let atLeast1 = 0, atLeast2 = 0, atLeast3 = 0, atLeast5 = 0;
    for (let i = 0; i < N; i++) {
      const c = eligibleLinkCount(corpus, i);
      const bucket = c >= 10 ? "10" : String(c);
      hist[bucket] = (hist[bucket] ?? 0) + 1;
      if (c >= 1) atLeast1++;
      if (c >= 2) atLeast2++;
      if (c >= 3) atLeast3++;
      if (c >= 5) atLeast5++;
    }
    const eligibleLinks = {
      histogram: hist, // pages by eligible-link count, capped at "10" = 10+
      atLeast: {
        "1": +(100 * atLeast1 / N).toFixed(1),
        "2": +(100 * atLeast2 / N).toFixed(1),
        "3": +(100 * atLeast3 / N).toFixed(1),
        "5": +(100 * atLeast5 / N).toFixed(1),
      }, // % of pages with >= N eligible links
    };

    // how concentrated the wiki's attention is across its attractor loops
    const pctSum = (k: number) => +(ranked.slice(0, k).reduce((acc, [, b]) => acc + b, 0) * 100 / N).toFixed(2);
    let entropyBits = 0;
    if (cycled > 0) for (const [, b] of ranked) { const p = b / cycled; entropyBits -= p * Math.log2(p); }
    const concentration = {
      top1Pct: pctSum(1), top3Pct: pctSum(3), top10Pct: pctSum(10),
      cycleCount: ranked.length,
      entropyBits: +entropyBits.toFixed(2), // Shannon entropy of basin shares, loops only
    };

    const stats = {
      wiki: wiki.id, rank: rankKey, nodes: N,
      converge: { articles: cycled, pct: +(100 * cycled / N).toFixed(2),
        deadEnd: deadBasin, deadEndPct: +(100 * deadBasin / N).toFixed(2),
        noLinks, tooFewLinks: tooFew, unresolvable },
      hopStats, histogram, eligibleLinks, concentration,
      components: ranked.length + (deadBasin > 0 ? 1 : 0),
      cycleCount: ranked.length,
      largestCycle: cycles[0] ? { members: cycles[0].cycle, size: cycles[0].cycle.length, basin: cycles[0].basin } : null,
      topAttractors: cycles.slice(0, 20),
      deadEndTerminals: topDeadTerminals,
      roadsToTopAttractor: [],
      topFirstLinkTargets, topThroughTraffic,
      ...(randomSeeds ? { randomSeeds } : {}),
    };
    fs.writeFileSync(path.join(OUT_DIR, `stats-r${key}.json`), JSON.stringify(stats, null, 1));
    fs.writeFileSync(path.join(OUT_DIR, `distances-r${key}.csv`),
      "page_id,title,attractor,distance,fate\n" + Array.from({ length: Math.min(N, 50000) }, (_, i) => {
        const fate = attractor[i] === DEAD ? "dead-end" : attractor[i] === -1 ? "unvisited" : "cycle";
        const attr = attractor[i] >= 0 && attractors[attractor[i]]
          ? `"${attractors[attractor[i]].map((n) => titles[n]).join("|")}"` : "";
        return `${ids[i]},"${(titles[i] ?? "").replace(/"/g, '""')}","${attr}",${dist[i]},${fate}`;
      }).join("\n"));

    const nRank = rankKey === "strict1" ? 1 : (/^\d+$/.test(rankKey) ? Number(rankKey) : null);
    summary.push({
      rank: rankKey, convergePct: stats.converge.pct, deadEndPct: stats.converge.deadEndPct,
      components: stats.components, cycleCount: stats.cycleCount,
      meanHops: hopStats.mean, medianHops: hopStats.median, maxHops: hopStats.max,
      topAttractor: cycles[0]?.cycle ?? null, topAttractorPct: cycles[0]?.pct ?? 0,
      top3Pct: concentration.top3Pct,
      eligiblePct: nRank !== null ? eligibleLinks.atLeast[String(nRank)] : 100,
    });
    console.log(`  rank=${rankKey}: ${stats.converge.pct}% converge, top attractor ${cycles[0]?.pct ?? 0}%`);
  }

  fs.writeFileSync(path.join(OUT_DIR, "summary.json"),
    JSON.stringify({ wiki: wiki.id, generatedAt: new Date().toISOString(), ranks: summary }, null, 1));
  console.log(`[${wiki.id}] done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
