/**
 * extract-parallel.ts — run one wiki's extraction in parallel OS processes.
 *
 * Spawns N instances of extract-links.ts, each taking a page-id shard
 * (id % N == i); they share links.sqlite (WAL + busy-retry) and the
 * machine-wide 1 req/s API budget (file-locked, see lib/http.ts), so shards
 * — and shards of other wikis — still never exceed 1 request/second
 * combined. Optionally runs analyze.ts once all shards finish.
 *
 * Usage:
 *   npx tsx scripts/extract-parallel.ts --wiki=rs3 --shards=4 [--analyze] [--force]
 *
 * Expected wall time at ~50-57 pages/s/core: rs3 4 shards ≈ 7-8 min
 * (vs ~27 single), osrs/fortnite 4 shards ≈ 3 min.
 */
import { spawn } from "child_process";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const wikiArg = process.argv.find((a) => a.startsWith("--wiki="))?.slice(7);
const shardsArg = Number(process.argv.find((a) => a.startsWith("--shards="))?.slice(9) ?? 4);
const doAnalyze = process.argv.includes("--analyze");
const force = process.argv.includes("--force");

if (!wikiArg) {
  console.error("Usage: npx tsx scripts/extract-parallel.ts --wiki=<id> --shards=<n> [--analyze] [--force]");
  process.exit(1);
}
const SHARDS = Math.max(1, Math.min(32, Number.isFinite(shardsArg) ? shardsArg : 4));

function run(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    // shell:true lets Windows resolve npx.cmd; args below contain no shell metacharacters
    const child = spawn("npx", ["tsx", ...args], { cwd: ROOT, stdio: "inherit", shell: true });
    child.on("error", (e) => { console.error(e); resolve(1); });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const t0 = Date.now();
  console.log(`=== ${wikiArg}: ${SHARDS} extract shard${SHARDS > 1 ? "s" : ""} ===`);
  const codes = await Promise.all(
    Array.from({ length: SHARDS }, (_, i) =>
      run(["scripts/extract-links.ts", `--wiki=${wikiArg}`, `--shard=${i}/${SHARDS}`, ...(force ? ["--force"] : [])]),
    ),
  );
  const failed = codes.filter((c) => c !== 0).length;
  if (failed > 0) {
    console.error(`${failed}/${SHARDS} shards failed — skipping analyze`);
    process.exit(1);
  }
  console.log(`=== ${wikiArg}: shards done in ${Math.round((Date.now() - t0) / 1000)}s ===`);
  if (doAnalyze) {
    const code = await run(["scripts/analyze.ts", `--wiki=${wikiArg}`]);
    if (code !== 0) process.exit(1);
  }
  console.log(`=== ${wikiArg}: parallel extract complete in ${Math.round((Date.now() - t0) / 1000)}s ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
