/**
 * lab-server.ts — interactive dashboard for first-link analysis across wikis.
 *
 * Serves the dashboard + JSON API over the analysis outputs.
 *
 * Usage: npx tsx scripts/lab-server.ts   # → http://localhost:8787
 *   PORT=9000 npx tsx scripts/lab-server.ts
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 8787);
const DASHBOARD = path.join(ROOT, "scripts", "lab-dashboard.html");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;

function readSafe(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}
function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const q = url.searchParams;
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const raw = readSafe(DASHBOARD) ?? "";
      const wikiJson = JSON.stringify(wikis.map((w) => ({ id: w.id, name: w.name, description: w.description })));
      const html = raw.replace("__WIKI_OPTIONS__", wikiJson);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html ?? "dashboard html missing");
      return;
    }
    if (url.pathname === "/api/wikis") {
      json(res, 200, wikis.map((w) => ({
        id: w.id, name: w.name, origin: w.origin,
        available: fs.existsSync(path.join(ROOT, "output", w.id, "links.sqlite")),
      })));
      return;
    }
    const wiki = q.get("wiki") ?? "osrs";
    const wikiDir = path.join(ROOT, "output", wiki);
    if (!fs.existsSync(wikiDir)) { res.writeHead(404); res.end(`wiki ${wiki} not fetched yet`); return; }

    if (url.pathname === "/api/summary") {
      const data = readSafe(path.join(wikiDir, "summary.json"));
      if (!data) { res.writeHead(404); res.end("no summary — run analyze first"); return; }
      json(res, 200, JSON.parse(data));
      return;
    }
    if (url.pathname === "/api/stats") {
      const rank = (q.get("rank") ?? "strict1").replace(/[^a-z0-9]+/gi, "");
      const data = readSafe(path.join(wikiDir, `stats-r${rank}.json`));
      if (!data) { res.writeHead(404); res.end("no stats for this rank"); return; }
      json(res, 200, JSON.parse(data));
      return;
    }
    if (url.pathname === "/api/chain") {
      const rank = q.get("rank") ?? "strict1";
      const title = q.get("title") ?? "";
      const linksPath = path.join(wikiDir, "links.sqlite");
      if (!fs.existsSync(linksPath)) { res.writeHead(404); res.end("not extracted yet"); return; }
      const db = createClient({ url: `file:${linksPath}` });
      const pageRes = await db.execute({
        sql: "SELECT id, title FROM page WHERE title = ? COLLATE NOCASE LIMIT 1",
        args: [title],
      });
      if (pageRes.rows.length === 0) { res.writeHead(404); res.end(`article not found: ${title}`); return; }
      const startId = Number(pageRes.rows[0].id);
      // load links for this page + successors iteratively
      const titleCache = new Map<number, string>([[startId, String(pageRes.rows[0].title)]]);
      const chain: string[] = [String(pageRes.rows[0].title)];
      const seen = new Set<number>([startId]);
      let cur = startId, hops = 0, fate = "", reason = "", cycleSize = 0;
      const nRank = /^\d+$/.test(rank) ? Number(rank) : null;
      while (chain.length < 120) {
        const links = await db.execute({
          sql: "SELECT rank, target_id, paren, italic FROM link WHERE page_id = ? ORDER BY rank",
          args: [cur],
        });
        let targetId: number | null = null;
        if (rank === "strict1") {
          const first = links.rows.find((r) => Number(r.paren) === 0 && Number(r.italic) === 0);
          targetId = first ? (first.target_id === null ? null : Number(first.target_id)) : null;
          if (!first) { fate = "dead"; reason = "no eligible first link"; break; }
        } else if (rank === "last") {
          const last = links.rows[links.rows.length - 1];
          targetId = last ? (last.target_id === null ? null : Number(last.target_id)) : null;
        } else if (nRank !== null) {
          const at = links.rows.find((r) => Number(r.rank) === nRank);
          if (!at) { fate = "dead"; reason = `page has only ${links.rows.length} prose links`; break; }
          targetId = at.target_id === null ? null : Number(at.target_id);
        } else {
          // random
          if (links.rows.length === 0) { fate = "dead"; reason = "no links"; break; }
          const pick = links.rows[Math.floor(Math.random() * links.rows.length)];
          targetId = pick.target_id === null ? null : Number(pick.target_id);
        }
        if (targetId === null) { fate = "dead"; reason = "redlink (unresolvable target)"; break; }
        if (seen.has(targetId)) {
          fate = "cycle";
          const firstIdx = chain.findIndex((t) => titleCache.get(targetId!) === t || t === (titleCache.get(targetId) ?? ""));
          cycleSize = firstIdx >= 0 ? chain.length - firstIdx : 1;
          break;
        }
        seen.add(targetId);
        const targetRes = await db.execute({
          sql: "SELECT title FROM page WHERE id = ?",
          args: [targetId],
        });
        const tTitle = targetRes.rows.length ? String(targetRes.rows[0].title) : `#${targetId}`;
        titleCache.set(targetId, tTitle);
        chain.push(tTitle);
        hops = chain.length - 1;
        cur = targetId;
      }
      if (!fate) { fate = "cycle"; cycleSize = 1; }
      json(res, 200, { title, rank, chain, hops, fate, reason, cycleSize });
      return;
    }
    if (url.pathname === "/api/search") {
      const query = (q.get("q") ?? "").replace(/[%_]/g, "");
      const db = createClient({ url: `file:${path.join(wikiDir, "links.sqlite")}` });
      const r = await db.execute({
        sql: "SELECT title FROM page WHERE title LIKE ? ORDER BY LENGTH(title) LIMIT 12",
        args: [`%${query}%`],
      });
      json(res, 200, { titles: r.rows.map((row) => String(row.title)) });
      return;
    }
    if (url.pathname === "/api/random") {
      const db = createClient({ url: `file:${path.join(wikiDir, "links.sqlite")}` });
      const r = await db.execute("SELECT title FROM page ORDER BY RANDOM() LIMIT 1");
      json(res, 200, { title: r.rows.length ? String(r.rows[0].title) : "" });
      return;
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    res.writeHead(500); res.end((e as Error).message);
  }
});

server.listen(PORT, () => {
  const available = wikis.filter((w) => fs.existsSync(path.join(ROOT, "output", w.id, "links.sqlite")));
  console.log(`Link Lab → http://localhost:${PORT}`);
  console.log(`  wikis configured: ${wikis.length}, with data: ${available.length} (${available.map((w) => w.id).join(", ") || "none"})`);
});
