/**
 * pipeline.ts — run the full fetch → extract → analyze pipeline for a wiki.
 *
 * Usage: npx tsx scripts/pipeline.ts --wiki=minecraft [--ranks=strict1,1,2,3,5,last,random]
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const wikiArg = process.argv.find((a) => a.startsWith("--wiki="))?.slice(7);
const ranksArg = process.argv.find((a) => a.startsWith("--ranks="))?.slice(8) ?? "strict1,1,2,3,5,last,random";
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;
const wiki = wikis.find((w) => w.id === wikiArg);
if (!wiki) { console.error(`Unknown --wiki=${wikiArg}. Available: ${wikis.map((w) => w.id).join(", ")}`); process.exit(1); }

const steps = [
  { name: "fetch", cmd: `npx tsx scripts/fetch-wiki.ts --wiki=${wiki.id}`, skipIf: () => false },
  { name: "extract", cmd: `npx tsx scripts/extract-links.ts --wiki=${wiki.id}`, skipIf: () => false },
  { name: "analyze", cmd: `npx tsx scripts/analyze.ts --wiki=${wiki.id} --ranks=${ranksArg}`, skipIf: () => false },
];

console.log(`\n=== pipeline: ${wiki.id} (${wiki.name}) ===\n`);
const t0 = Date.now();
for (const step of steps) {
  console.log(`\n--- ${step.name} ---`);
  const stepT0 = Date.now();
  try {
    execSync(step.cmd, { cwd: ROOT, stdio: "inherit", timeout: 3600_000 });
    console.log(`--- ${step.name} done in ${Math.round((Date.now() - stepT0) / 1000)}s ---`);
  } catch (e) {
    console.error(`--- ${step.name} FAILED ---`);
    process.exit(1);
  }
}
console.log(`\n=== pipeline complete in ${Math.round((Date.now() - t0) / 1000)}s ===`);
console.log(`  data: output/${wiki.id}/`);
console.log(`  dashboard: npx tsx scripts/lab-server.ts`);
