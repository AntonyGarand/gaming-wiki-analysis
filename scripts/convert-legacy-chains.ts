/**
 * convert-legacy-chains.ts — one-off bridge from the old static data format
 * (dist/data/<wiki>/chains-r*.json, every page repeating its whole chain) to the
 * compact successor tables the article now consumes (titles.json + succ-r*.json).
 *
 * Reads:  <src>/<wiki>/{chains-r*.json, stats-r*.json, summary.json}
 * Writes: output/<wiki>/{titles.json, succ-r*.json, stats-r*.json, summary.json}
 *
 * Usage: npx tsx scripts/convert-legacy-chains.ts [--src=dist/data]
 * Once analyze.ts writes succ tables itself this script can be deleted.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.resolve(ROOT, process.argv.find((a) => a.startsWith("--src="))?.slice(6) ?? "dist/data");
const OUT = path.join(ROOT, "output");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;

function termCode(reason: string): number {
  if (!reason) return 0;
  if (/redlink|unresolvable/i.test(reason)) return 3;
  if (/only \d+|too few/i.test(reason)) return 2;
  return 1;
}

for (const w of wikis) {
  const srcDir = path.join(SRC, w.id);
  if (!fs.existsSync(path.join(srcDir, "summary.json"))) { console.log(`${w.id}: no legacy data, skipped`); continue; }
  const outDir = path.join(OUT, w.id);
  fs.mkdirSync(outDir, { recursive: true });
  const summary = JSON.parse(fs.readFileSync(path.join(srcDir, "summary.json"), "utf8"));
  fs.copyFileSync(path.join(srcDir, "summary.json"), path.join(outDir, "summary.json"));
  const ranks: string[] = summary.ranks.map((r: any) => r.rank);
  let titles: string[] | null = null;
  let titleIdx = new Map<string, number>();
  for (const rank of ranks) {
    const st = path.join(srcDir, `stats-r${rank}.json`);
    if (fs.existsSync(st)) fs.copyFileSync(st, path.join(outDir, `stats-r${rank}.json`));
    const cf = path.join(srcDir, `chains-r${rank}.json`);
    if (!fs.existsSync(cf)) { console.log(`${w.id}: no chains for ${rank}`); continue; }
    const chains: Record<string, [string[], number, number, string]> = JSON.parse(fs.readFileSync(cf, "utf8"));
    if (!titles) {
      titles = Object.keys(chains);
      titleIdx = new Map(titles.map((t, i) => [t, i]));
      fs.writeFileSync(path.join(outDir, "titles.json"), JSON.stringify(titles));
    }
    const N = titles.length;
    const succ = new Array<number>(N).fill(-1);
    const term = new Array<number>(N).fill(0);
    let missing = 0;
    for (let i = 0; i < N; i++) {
      const rec = chains[titles[i]];
      if (!rec) { term[i] = 1; missing++; continue; }
      const [chain, fate, cycleSize, reason] = rec;
      if (chain.length > 1) {
        const j = titleIdx.get(chain[1]);
        if (j === undefined) { term[i] = 3; missing++; } else succ[i] = j;
      } else if (fate === 0 && cycleSize === 1) {
        succ[i] = i; // legacy self-loop
      } else {
        term[i] = termCode(reason) || 1;
      }
    }
    fs.writeFileSync(path.join(outDir, `succ-r${rank}.json`), JSON.stringify({ rank, succ, term }));
    console.log(`${w.id} ${rank}: ${N} nodes, ${succ.filter((s) => s >= 0).length} edges${missing ? `, ${missing} unresolved` : ""}`);
  }
}
console.log(`→ ${OUT}`);
