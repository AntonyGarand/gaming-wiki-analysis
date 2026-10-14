/**
 * build-static.ts — bake the article into a fully static site under dist/.
 *
 * Pure file copy: no server needed. For each wiki in wikis.json that has analysis
 * output, copies titles.json, succ-r*.json, stats-r*.json and summary.json, then
 * writes data/wikis.json (the wikis that actually have data) and index.html.
 *
 * Usage: npx tsx scripts/build-static.ts
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUTPUT = path.join(ROOT, "output");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, "data"), { recursive: true });

const available: Array<{ id: string; name: string; origin: string; description: string; ranks: string[] }> = [];
let bytes = 0;
for (const w of wikis) {
  const src = path.join(OUTPUT, w.id);
  const summaryPath = path.join(src, "summary.json");
  const titlesPath = path.join(src, "titles.json");
  if (!fs.existsSync(summaryPath) || !fs.existsSync(titlesPath)) { console.log(`${w.id}: no titles.json/summary.json, skipped`); continue; }
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const ranks: string[] = [];
  const dst = path.join(DIST, "data", w.id);
  fs.mkdirSync(dst, { recursive: true });
  const copy = (name: string) => {
    const p = path.join(src, name);
    if (!fs.existsSync(p)) return false;
    fs.copyFileSync(p, path.join(dst, name));
    bytes += fs.statSync(p).size;
    return true;
  };
  copy("summary.json"); copy("titles.json");
  for (const r of summary.ranks.map((x: any) => x.rank)) {
    const ok = copy(`succ-r${r}.json`) && copy(`stats-r${r}.json`);
    if (ok) ranks.push(r); else console.log(`  ${w.id}: rank ${r} incomplete (needs succ + stats), dropped`);
  }
  if (!ranks.length) { fs.rmSync(dst, { recursive: true, force: true }); console.log(`${w.id}: no complete rank, skipped`); continue; }
  available.push({ id: w.id, name: w.name, origin: w.origin, description: w.description, ranks });
  console.log(`${w.id}: ${ranks.length} ranks`);
}

fs.writeFileSync(path.join(DIST, "data", "wikis.json"), JSON.stringify({ generatedAt: new Date().toISOString(), wikis: available }));
fs.copyFileSync(path.join(ROOT, "scripts", "article.html"), path.join(DIST, "index.html"));
fs.copyFileSync(path.join(ROOT, "scripts", "walkfield.js"), path.join(DIST, "walkfield.js"));
fs.writeFileSync(path.join(DIST, ".nojekyll"), "");

// walk field page — the drainage map as its own page. works with no server:
// it reads the same successor tables the article ships and builds the graph
// client-side (live lab server mode uses /api/walktable instead)
const meshDir = path.join(DIST, "mesh");
fs.mkdirSync(meshDir, { recursive: true });
const meshHtml = fs.readFileSync(path.join(ROOT, "scripts", "walkfield.html"), "utf8")
  .replace("__WIKI_OPTIONS__", JSON.stringify(available.map((w) => ({ id: w.id, name: w.name, description: w.description }))));
fs.writeFileSync(path.join(meshDir, "index.html"), meshHtml);
fs.copyFileSync(path.join(ROOT, "scripts", "walkfield.js"), path.join(meshDir, "walkfield.js"));
console.log(`walk field: dist/mesh/index.html (${available.length} wikis, graph built client-side)`);
console.log(`\nstatic build complete → ${DIST} (${available.length} wikis, ${(bytes / 1e6).toFixed(1)} MB of data)`);
