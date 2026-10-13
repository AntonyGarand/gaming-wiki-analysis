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
const ARTICLE = path.join(ROOT, "scripts", "article.html");
const DASHBOARD = path.join(ROOT, "scripts", "lab-dashboard.html");
const wikis = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;

// small LRU cache for the expensive viz endpoints (/api/graph, /api/mesh) —
// they reload and re-analyse the whole link table per request otherwise
const vizCache = new Map<string, string>();
function sendCache(res: http.ServerResponse, key: string): boolean {
  const hit = vizCache.get(key);
  if (hit === undefined) return false;
  vizCache.delete(key); vizCache.set(key, hit); // refresh LRU order
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(hit);
  return true;
}
function cachePut(res: http.ServerResponse, key: string, body: unknown) {
  const s = JSON.stringify(body);
  vizCache.set(key, s);
  if (vizCache.size > 16) vizCache.delete(vizCache.keys().next().value as string);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

// disambiguation pages ("X may refer to:") are not valid walk targets —
// cached per wiki, read from the raw dump's wikitext
const disambigCache = new Map<string, Set<number>>();
async function disambigSetFor(wikiId: string): Promise<Set<number>> {
  const hit = disambigCache.get(wikiId);
  if (hit) return hit;
  const s = new Set<number>();
  const wikiDbPath = path.join(ROOT, "output", wikiId, "wiki.sqlite");
  if (fs.existsSync(wikiDbPath)) {
    const wdb = createClient({ url: `file:${wikiDbPath}` });
    try {
      const r = await wdb.execute(
        "SELECT id FROM page WHERE namespace = 0 AND ((instr(lower(substr(text,1,400)), 'may refer to:') > 0 OR instr(lower(substr(text,1,400)), '{{disambig') > 0) OR title LIKE '% (disambiguation)')"
      );
      for (const row of r.rows) s.add(Number(row.id));
    } finally { wdb.close(); }
  }
  disambigCache.set(wikiId, s);
  return s;
}

// date pages ("28 April", "April 28", "17 March 2019") are update-history
// indexes — cached per wiki, detected by title shape
const dateCache = new Map<string, Set<number>>();
const MONTHS_RE = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_TITLE_RE = new RegExp(
  `^((0?[1-9]|[12]\\d|3[01]) (${MONTHS_RE})|(${MONTHS_RE}) (0?[1-9]|[12]\\d|3[01]))(,? \\d{4})?$`, "i"
);
async function dateSetFor(wikiId: string): Promise<Set<number>> {
  const hit = dateCache.get(wikiId);
  if (hit) return hit;
  const s = new Set<number>();
  const linksPath2 = path.join(ROOT, "output", wikiId, "links.sqlite");
  if (fs.existsSync(linksPath2)) {
    const ldb = createClient({ url: `file:${linksPath2}` });
    try {
      const r = await ldb.execute("SELECT id, title FROM page");
      for (const row of r.rows) {
        const t = String(row.title);
        if (DATE_TITLE_RE.test(t) || /^(1[0-9]{3}|20[0-9]{2})$/.test(t)) s.add(Number(row.id)); // bare years too
      }
    } finally { ldb.close(); }
  }
  dateCache.set(wikiId, s);
  return s;
}
async function skippedTargetsFor(wikiId: string): Promise<Set<number>> {
  const [a, b] = await Promise.all([disambigSetFor(wikiId), dateSetFor(wikiId)]);
  const s = new Set<number>(a);
  for (const x of b) s.add(x);
  return s;
}

function readSafe(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}
function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// live graph computation — attractor detection, BFS node selection, radial
// tree layout with collision resolution (adapted from the OSRS project)
// ---------------------------------------------------------------------------
async function computeGraph(wikiId: string, rank: string, detail: number) {
  const wikiDir = path.join(ROOT, "output", wikiId);
  const db = createClient({ url: `file:${path.join(wikiDir, "links.sqlite")}` });

  // load all pages
  const pagesRes = await db.execute("SELECT id, title FROM page ORDER BY id");
  const ids = pagesRes.rows.map((r) => Number(r.id));
  const titles = new Map<number, string>(pagesRes.rows.map((r) => [Number(r.id), String(r.title)]));
  const idToIdx = new Map<number, number>(ids.map((id, i) => [id, i]));
  const N = ids.length;
  const title = (i: number) => titles.get(ids[i]) ?? "?";

  // load links and build successor map for the requested rank
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
  function rngFor(pageId: number): number {
    let x = (pageId ^ 0x9e3779b9) >>> 0;
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  }
  const succ = new Int32Array(N).fill(-1);
  {
    const skipped = await skippedTargetsFor(wikiId);
    const nRank = rank === "strict1" ? 1 : (/^\d+$/.test(rank) ? Number(rank) : null);
    for (let i = 0; i < N; i++) {
      const links = linksByPage.get(ids[i]);
      if (!links || links.length === 0) continue;
      const eligible = links.filter((l) => !l.paren && !l.italic && !(l.target !== null && skipped.has(l.target))); // every rank is strict, disambiguation pages never count
      if (eligible.length === 0) continue;
      let chosen: number | null = null;
      if (rank === "last") chosen = eligible[eligible.length - 1].target;
      else if (rank === "random") chosen = eligible[Math.floor(rngFor(ids[i]) * eligible.length)].target;
      else if (nRank !== null) { const at = eligible[nRank - 1]; chosen = at ? at.target : null; }
      if (chosen === null) continue;
      const idx = idToIdx.get(chosen);
      if (idx !== undefined) succ[i] = idx;
    }
  }

  // attractor analysis
  const attractor = new Int32Array(N).fill(-1);
  const attractors: Array<{ nodes: number[] }> = [];
  const DEAD = -2;
  const mark = new Int32Array(N).fill(-1);
  let walkId = 0;
  for (let s = 0; s < N; s++) {
    if (mark[s] !== -1) continue;
    walkId++;
    const walkPath: number[] = [], posInPath = new Map<number, number>();
    let cur = s;
    for (;;) {
      if (mark[cur] === walkId) {
        const at = posInPath.get(cur)!;
        const a = attractors.push({ nodes: walkPath.slice(at) }) - 1;
        for (const n of attractors[a].nodes) attractor[n] = a;
        for (let p = at - 1; p >= 0; p--) attractor[walkPath[p]] = a;
        break;
      }
      if (mark[cur] !== -1) {
        const t = attractor[cur];
        for (let p = walkPath.length - 1; p >= 0; p--) attractor[walkPath[p]] = t;
        break;
      }
      mark[cur] = walkId; posInPath.set(cur, walkPath.length); walkPath.push(cur);
      const nx = succ[cur];
      if (nx === -1) { for (const p of walkPath) attractor[p] = DEAD; break; }
      if (nx === cur) { const a = attractors.push({ nodes: [cur] }) - 1; attractor[cur] = a; for (let p = walkPath.length - 2; p >= 0; p--) attractor[walkPath[p]] = a; break; }
      cur = nx;
    }
  }
  const basin = new Map<number, number>();
  for (let i = 0; i < N; i++) { const a = attractor[i]; if (a >= 0) basin.set(a, (basin.get(a) ?? 0) + 1); }
  const ranked = [...basin.entries()].sort((x, y) => y[1] - x[1]);
  const nLoops = Math.min(4, ranked.length);
  const clusterAttractors = ranked.slice(0, nLoops);

  // in-degree + predecessors
  const inDeg = new Int32Array(N);
  const preds = new Map<number, number[]>();
  for (let i = 0; i < N; i++) if (succ[i] >= 0) {
    inDeg[succ[i]]++;
    if (!preds.has(succ[i])) preds.set(succ[i], []);
    preds.get(succ[i])!.push(i);
  }

  // node selection BFS
  const include = new Set<number>();
  const groupOf = new Map<number, number>();
  clusterAttractors.forEach(([a], li) => { for (const n of attractors[a].nodes) { include.add(n); groupOf.set(n, li); } });
  const cycSet = new Set<number>();
  clusterAttractors.forEach(([a]) => { for (const n of attractors[a].nodes) cycSet.add(n); });

  const depthMax = [2, 3, 5, 8, 12][detail - 1];
  const budgets = [
    [1e9, 10, 6],
    [1e9, 20, 14, 10, 8],
    [1e9, 30, 24, 18, 14, 10, 8, 6],
    [1e9, 40, 34, 28, 22, 18, 14, 12, 10, 8, 8, 8, 8],
    [1e9, 200, 160, 120, 100, 80, 60, 50, 40, 30, 25, 20, 15],
  ][detail - 1];
  const perLoopCap = [40, 80, 150, 500, 2000][detail - 1];

  clusterAttractors.forEach(([a], li) => {
    let frontier = [...attractors[a].nodes];
    let clusterCount = frontier.length;
    for (let depth = 1; depth <= depthMax; depth++) {
      const cap = Math.min(budgets[depth] ?? 0, perLoopCap - clusterCount);
      if (cap <= 0) break;
      const candidates: number[] = [];
      for (const f of frontier) for (const p of preds.get(f) ?? []) if (!include.has(p)) candidates.push(p);
      const uniq = [...new Set(candidates)].sort((x, y) => inDeg[y] - inDeg[x]).slice(0, cap);
      for (const p of uniq) { include.add(p); groupOf.set(p, li); clusterCount++; }
      frontier = uniq;
    }
  });

  // dead-branch detection
  {
    const terminal = new Set<number>();
    for (const v of include) if (attractor[v] === DEAD || succ[v] === -1) terminal.add(v);
    const deadSet = new Set(terminal);
    const stack = [...terminal];
    while (stack.length) {
      const cur = stack.pop();
      for (const p of preds.get(cur) ?? []) if (include.has(p) && !deadSet.has(p)) { deadSet.add(p); stack.push(p); }
    }
    for (const v of deadSet) if (!cycSet.has(v)) groupOf.set(v, 4);
  }

  // radial tree layout
  const W = 1600, H = 1000;
  const wikiOrigin2 = wikis.find((w) => w.id === wikiId)?.origin ?? "";
  const wikiUrl = (t: string) => `${wikiOrigin2}/w/${encodeURIComponent(t.replace(/ /g, "_"))}`;
  const ANCHORS = [
    { x: 430, y: 430, core: 100, max: 280 }, { x: 1150, y: 390, core: 94, max: 265 },
    { x: 800, y: 830, core: 80, max: 230 }, { x: 1400, y: 830, core: 50, max: 145 },
    { x: 200, y: 850, core: 45, max: 135 },
  ];
  // scale the dominant loop's territory by its basin share
  if (clusterAttractors.length > 0) {
    const topPct = clusterAttractors[0][1] / N;
    if (topPct > 0.4) {
      const scale = Math.min(2.2, 0.8 + topPct * 1.8);
      ANCHORS[0].core = Math.round(ANCHORS[0].core * scale);
      ANCHORS[0].max = Math.round(Math.min(ANCHORS[0].max * scale, 480));
    }
  }
  const childrenOf = new Map<number, number[]>();
  const rootsByCluster: Array<number[]> = [[], [], [], [], []];
  for (const v of include) {
    const s = succ[v];
    const same = s >= 0 && include.has(s) && groupOf.get(s) === groupOf.get(v);
    if (s < 0 || !same || cycSet.has(v)) rootsByCluster[Math.min(groupOf.get(v) ?? 0, 4)].push(v);
    else { if (!childrenOf.has(s)) childrenOf.set(s, []); childrenOf.get(s)!.push(v); }
  }
  const subtree = new Map<number, number>();
  function sz(v: number): number {
    if (subtree.has(v)) return subtree.get(v)!;
    subtree.set(v, 1);
    let s2 = 1; for (const c of childrenOf.get(v) ?? []) s2 += sz(c);
    subtree.set(v, s2); return s2;
  }
  const px = new Float64Array(N), py = new Float64Array(N);
  const homeX = new Float64Array(N), homeY = new Float64Array(N);
  for (let gi = 0; gi <= 4; gi++) {
    const anchor = ANCHORS[gi];
    const roots = rootsByCluster[gi].filter((v) => include.has(v));
    if (!roots.length) continue;
    roots.sort((a, b) => sz(b) - sz(a));
    const total = roots.reduce((acc, r) => acc + sz(r), 0);
    let maxDepth = 0;
    const st: Array<[number, number]> = roots.map((r) => [r, 0]);
    while (st.length) { const [v, d] = st.pop()!; maxDepth = Math.max(maxDepth, d); for (const c of childrenOf.get(v) ?? []) st.push([c, d + 1]); }
    const gap = maxDepth > 0 ? (anchor.max - anchor.core) / maxDepth : 0;
    let angle = -Math.PI / 2;
    for (const r of roots) {
      const w = Math.PI * 2 * (sz(r) / total);
      const a = angle + w / 2;
      if (roots.length > 1) { px[r] = anchor.x + Math.cos(a) * anchor.core; py[r] = anchor.y + Math.sin(a) * anchor.core * 0.92; }
      else { px[r] = anchor.x; py[r] = anchor.y; }
      homeX[r] = px[r]; homeY[r] = py[r];
      const st2: Array<[number, number, number, number]> = [];
      const kids = (childrenOf.get(r) ?? []).slice().sort((x, y) => sz(y) - sz(x));
      let off = 0; const rSize = sz(r);
      for (const c of kids) {
        const cw = w * (sz(c) / Math.max(1, rSize - 1));
        const ca = a - w / 2 + off + cw / 2; off += cw;
        px[c] = anchor.x + Math.cos(ca) * (anchor.core + gap); py[c] = anchor.y + Math.sin(ca) * (anchor.core + gap) * 0.92;
        homeX[c] = px[c]; homeY[c] = py[c];
        st2.push([c, ca, cw, 1]);
      }
      while (st2.length) {
        const [v, va, vw, vd] = st2.pop()!;
        const vk = (childrenOf.get(v) ?? []).slice().sort((x, y) => sz(y) - sz(x));
        let vo = 0; const vs = sz(v);
        for (const ck of vk) {
          const kw = vw * (sz(ck) / Math.max(1, vs - 1));
          const ka = va - vw / 2 + vo + kw / 2; vo += kw;
          px[ck] = anchor.x + Math.cos(ka) * (anchor.core + (vd + 1) * gap); py[ck] = anchor.y + Math.sin(ka) * (anchor.core + (vd + 1) * gap) * 0.92;
          homeX[ck] = px[ck]; homeY[ck] = py[ck];
          st2.push([ck, ka, kw, vd + 1]);
        }
      }
      angle += w;
    }
  }

  // collision resolution
  {
    const inc = [...include];
    const minSep = new Float64Array(N);
    for (const v of inc) minSep[v] = cycSet.has(v) ? 30 : Math.max(14, 4 + 2.3 * Math.sqrt(inDeg[v]));
    for (let iter = 0; iter < 300; iter++) {
      let moved = 0;
      for (let i = 0; i < inc.length; i++) {
        const a = inc[i];
        if (cycSet.has(a)) continue;
        let fx = 0, fy = 0;
        for (let j = 0; j < inc.length; j++) {
          if (i === j) continue;
          const b = inc[j];
          const dx = px[a] - px[b], dy = py[a] - py[b];
          const d2 = dx * dx + dy * dy;
          const minD = minSep[a] + minSep[b];
          if (d2 < minD * minD && d2 > 0.01) { const d = Math.sqrt(d2); const f = (minD - d) / d * 0.5; fx += dx * f; fy += dy * f; }
        }
        fx += (homeX[a] - px[a]) * 0.08; fy += (homeY[a] - py[a]) * 0.08;
        const m = 100;
        if (px[a] < m) fx += (m - px[a]) * 0.3;
        if (px[a] > W - m) fx -= (px[a] - (W - m)) * 0.3;
        if (py[a] < m) fy += (m - py[a]) * 0.3;
        if (py[a] > H - m) fy -= (py[a] - (H - m)) * 0.3;
        const nx = Math.max(50, Math.min(W - 50, px[a] + fx));
        const ny = Math.max(50, Math.min(H - 50, py[a] + fy));
        if (Math.abs(nx - px[a]) > 0.5 || Math.abs(ny - py[a]) > 0.5) moved++;
        px[a] = nx; py[a] = ny;
      }
      if (moved < inc.length / 100) break;
    }
  }

  // flow counts
  const flow = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (attractor[i] < 0) continue;
    let cur = i; const seen = new Set<number>();
    while (cur >= 0 && !seen.has(cur) && seen.size < 100) { seen.add(cur); flow[cur]++; cur = succ[cur]; }
  }

  // build output
  const arr = [...include];
  const idOf = new Map(arr.map((v, i) => [v, i]));
  const gNodes = arr.map((v, i) => ({
    id: i, title: title(v), inDeg: inDeg[v], flow: flow[v],
    isCycle: cycSet.has(v), group: Math.min(groupOf.get(v) ?? 0, 4),
    famous: false, deadEnd: succ[v] === -1, target: null as string | null,
    url: wikiUrl(title(v)),
    x: +Math.max(50, Math.min(W - 50, px[v])).toFixed(1),
    y: +Math.max(50, Math.min(H - 50, py[v])).toFixed(1),
  }));
  const gEdges: Array<{ source: number; target: number }> = [];
  const ek = new Set<string>();
  for (const v of arr) {
    if (succ[v] < 0) continue;
    const t = idOf.get(succ[v]); if (t === undefined) continue;
    const s = idOf.get(v)!; const k = s + "-" + t;
    if (!ek.has(k)) { ek.add(k); gEdges.push({ source: s, target: t }); }
  }
  for (const e of gEdges) gNodes[e.source].target = gNodes[e.target].title;
  const loops = clusterAttractors.map(([a, b]) => ({
    cycle: attractors[a].nodes.map((n) => title(n)),
    basin: b, pct: +(100 * b / N).toFixed(1), minor: false,
  }));
  return { nodes: gNodes, edges: gEdges, loops, mainspace: N };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const q = url.searchParams;
  try {
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/article") {
      const raw = readSafe(ARTICLE) ?? "";
      const wikiJson = JSON.stringify(wikis.map((w) => ({ id: w.id, name: w.name, description: w.description })));
      const html = raw.replace("__WIKI_OPTIONS__", wikiJson);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html ?? "article html missing");
      return;
    }
    if (url.pathname === "/lab" || url.pathname === "/lab/") {
      const raw = readSafe(DASHBOARD) ?? "";
      const wikiJson = JSON.stringify(wikis.map((w) => ({ id: w.id, name: w.name, description: w.description })));
      const html = raw.replace("__WIKI_OPTIONS__", wikiJson);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html ?? "dashboard html missing");
      return;
    }
    if (url.pathname === "/meshfield.js") {
      const raw = readSafe(path.join(ROOT, "scripts", "meshfield.js"));
      if (!raw) { res.writeHead(404); res.end("meshfield.js missing"); return; }
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(raw);
      return;
    }
    if (url.pathname === "/api/wikis") {
      json(res, 200, wikis.map((w) => ({
        id: w.id, name: w.name, origin: w.origin,
        available: fs.existsSync(path.join(ROOT, "output", w.id, "links.sqlite")),
      })));
      return;
    }
    if (url.pathname === "/api/overview") {
      // cross-wiki headline numbers at the strict-first rank (for the article intro)
      const out = [];
      for (const w of wikis) {
        const st = readSafe(path.join(ROOT, "output", w.id, "stats-rstrict1.json"));
        if (!st) continue;
        try {
          const j = JSON.parse(st);
          out.push({
            id: w.id, name: w.name, nodes: j.nodes,
            convergePct: j.converge?.pct ?? 0, deadEndPct: j.converge?.deadEndPct ?? 0,
            meanHops: j.hopStats?.mean ?? 0, medianHops: j.hopStats?.median ?? 0,
            topAttractor: j.topAttractors?.[0]?.cycle ?? [],
            topAttractorPct: j.topAttractors?.[0]?.pct ?? 0,
          });
        } catch { /* skip malformed */ }
      }
      json(res, 200, out);
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
      const skipped = await skippedTargetsFor(wiki);
      const nRank = /^\d+$/.test(rank) ? Number(rank) : null;
      while (chain.length < 120) {
        const links = await db.execute({
          sql: "SELECT rank, target_id, paren, italic FROM link WHERE page_id = ? ORDER BY rank",
          args: [cur],
        });
        const eligible = links.rows.filter((r) => Number(r.paren) === 0 && Number(r.italic) === 0 && !(r.target_id !== null && skipped.has(Number(r.target_id)))); // every rank is strict, disambiguation pages never count
        let targetId: number | null = null;
        const nRank = rank === "strict1" ? 1 : (/^\d+$/.test(rank) ? Number(rank) : null);
        if (nRank !== null) {
          const at = eligible[nRank - 1];
          if (!at) { fate = "dead"; reason = `page has only ${eligible.length} eligible links`; break; }
          targetId = at.target_id === null ? null : Number(at.target_id);
        } else if (rank === "last") {
          const last = eligible[eligible.length - 1];
          targetId = last ? (last.target_id === null ? null : Number(last.target_id)) : null;
        } else {
          // random
          if (eligible.length === 0) { fate = "dead"; reason = "no eligible links"; break; }
          const pick = eligible[Math.floor(Math.random() * eligible.length)];
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
    if (url.pathname === "/api/graph") {
      const rank = q.get("rank") ?? "strict1";
      const detail = Math.max(1, Math.min(5, Number(q.get("detail") ?? 2)));
      const linksPath = path.join(wikiDir, "links.sqlite");
      if (!fs.existsSync(linksPath)) { res.writeHead(404); res.end("not extracted yet"); return; }
      const ck = `g|${wiki}|${rank}|${detail}`;
      if (sendCache(res, ck)) return;
      try { cachePut(res, ck, await computeGraph(wiki, rank, detail)); }
      catch (e) { res.writeHead(500); res.end((e as Error).message); }
      return;
    }
    if (url.pathname === "/api/mesh") {
      // abstract mesh for the hero: top attractor cycles + tributaries + random
      // articles, with successor links AND sibling links between them.
      // layout is computed client-side; here we just pick nodes and edges.
      const rank = q.get("rank") ?? "strict1";
      const target = Math.max(60, Math.min(600, Number(q.get("n") ?? 150)));
      const mck = `m|${wiki}|${rank}|${target}`;
      if (sendCache(res, mck)) return;
      const linksPath = path.join(wikiDir, "links.sqlite");
      if (!fs.existsSync(linksPath)) { res.writeHead(404); res.end("not extracted yet"); return; }
      const db = createClient({ url: `file:${linksPath}` });
      const pagesRes = await db.execute("SELECT id, title FROM page ORDER BY id");
      const ids = pagesRes.rows.map((r) => Number(r.id));
      const titles = new Map<number, string>(pagesRes.rows.map((r) => [Number(r.id), String(r.title)]));
      const idToIdx = new Map<number, number>(ids.map((id, i) => [id, i]));
      const N = ids.length;
      const linksByPage = new Map<number, Array<{ rank: number; target: number | null; paren: boolean; italic: boolean }>>();
      {
        let lastRow = -1;
        for (;;) {
          const r2 = await db.execute({
            sql: "SELECT page_id, rank, target_id, paren, italic FROM link WHERE page_id > ? ORDER BY page_id, rank LIMIT 5000",
            args: [lastRow],
          });
          if (r2.rows.length === 0) break;
          for (const r of r2.rows) {
            const pid = Number(r.page_id); lastRow = pid;
            let arr = linksByPage.get(pid);
            if (!arr) { arr = []; linksByPage.set(pid, arr); }
            arr.push({ rank: Number(r.rank), target: r.target_id === null ? null : Number(r.target_id),
              paren: Number(r.paren) === 1, italic: Number(r.italic) === 1 });
          }
          if (r2.rows.length < 5000) break;
        }
      }
      function rngFor(pageId: number): number {
        let x = (pageId ^ 0x9e3779b9) >>> 0;
        x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
        return x / 4294967296;
      }
      // strict successor map (parenthesised/italicised/disambiguation links never count)
      const skipped = await skippedTargetsFor(wiki);
      const succ = new Int32Array(N).fill(-1);
      const nRank = rank === "strict1" ? 1 : (/^\d+$/.test(rank) ? Number(rank) : null);
      for (let i = 0; i < N; i++) {
        const links = linksByPage.get(ids[i]);
        if (!links || links.length === 0) continue;
        const eligible = links.filter((l) => !l.paren && !l.italic && !(l.target !== null && skipped.has(l.target)));
        if (eligible.length === 0) continue;
        let chosen: number | null = null;
        if (rank === "last") chosen = eligible[eligible.length - 1].target;
        else if (rank === "random") chosen = eligible[Math.floor(rngFor(ids[i]) * eligible.length)].target;
        else if (nRank !== null) { const at = eligible[nRank - 1]; chosen = at ? at.target : null; }
        if (chosen === null) continue;
        const idx = idToIdx.get(chosen);
        if (idx !== undefined) succ[i] = idx;
      }
      // attractor detection
      const attractor = new Int32Array(N).fill(-1);
      const attractors: Array<{ nodes: number[] }> = [];
      const mark = new Int32Array(N).fill(-1);
      let walkId = 0;
      for (let s = 0; s < N; s++) {
        if (mark[s] !== -1) continue;
        walkId++;
        const walkPath: number[] = [], posInPath = new Map<number, number>();
        let cur = s;
        for (;;) {
          if (mark[cur] === walkId) {
            const at = posInPath.get(cur)!;
            const a = attractors.push({ nodes: walkPath.slice(at) }) - 1;
            for (const n of attractors[a].nodes) attractor[n] = a;
            for (let p = at - 1; p >= 0; p--) attractor[walkPath[p]] = a;
            break;
          }
          if (mark[cur] !== -1) {
            const t = attractor[cur];
            for (let p = walkPath.length - 1; p >= 0; p--) attractor[walkPath[p]] = t;
            break;
          }
          mark[cur] = walkId; posInPath.set(cur, walkPath.length); walkPath.push(cur);
          const nx = succ[cur];
          if (nx === -1) { for (const p of walkPath) attractor[p] = -2; break; }
          if (nx === cur) { const a = attractors.push({ nodes: [cur] }) - 1; attractor[cur] = a; for (let p = walkPath.length - 2; p >= 0; p--) attractor[walkPath[p]] = a; break; }
          cur = nx;
        }
      }
      const basin = new Map<number, number>();
      for (let i = 0; i < N; i++) { const a = attractor[i]; if (a >= 0) basin.set(a, (basin.get(a) ?? 0) + 1); }
      const ranked = [...basin.entries()].sort((x, y) => y[1] - x[1]);
      const inDeg = new Int32Array(N);
      const preds = new Map<number, number[]>();
      for (let i = 0; i < N; i++) if (succ[i] >= 0) {
        inDeg[succ[i]]++;
        if (!preds.has(succ[i])) preds.set(succ[i], []);
        preds.get(succ[i])!.push(i);
      }
      // selection: loop members, then tributaries by in-degree, then random fill
      const include = new Set<number>();
      const isCycle = new Uint8Array(N);
      ranked.slice(0, 4).forEach(([a]) => attractors[a].nodes.forEach((n) => { include.add(n); isCycle[n] = 1; }));
      let frontier = [...include];
      const budgets = [1e9, Math.round(target * 0.18), Math.round(target * 0.10), Math.round(target * 0.06)];
      for (let depth = 0; depth < 3 && include.size < target * 0.65; depth++) {
        const cand: number[] = [];
        for (const f of frontier) for (const p of preds.get(f) ?? []) if (!include.has(p)) cand.push(p);
        const uniq = [...new Set(cand)].sort((a, b) => inDeg[b] - inDeg[a]).slice(0, budgets[depth + 1] ?? 0);
        for (const p of uniq) include.add(p);
        frontier = uniq;
      }
      let guard = 0;
      const linksInto = (v: number) => {
        const links = linksByPage.get(ids[v]) ?? [];
        for (const l of links) {
          if (l.target === null) continue;
          const t = idToIdx.get(l.target);
          if (t !== undefined && include.has(t)) return true;
        }
        return false;
      };
      while (include.size < target && guard++ < target * 30) {
        const i = Math.floor(rngFor(ids[Math.floor(Math.random() * N)] ?? 0) * N + Math.random() * N) % N;
        if (!linksByPage.has(ids[i]) || include.has(i)) continue;
        if (!linksInto(i)) continue; // random fill must connect to something already in the mesh
        include.add(i);
      }
      // edges: every link between selected nodes, successor flagged, capped per source
      const idxs = [...include];
      const local = new Map(idxs.map((v, i) => [v, i]));
      const outNodes = idxs.map((v) => ({ t: titles.get(ids[v]) ?? "?", c: isCycle[v] === 1 }));
      const rawEdges: Array<[number, number, number]> = [];
      const seen = new Set<string>();
      for (const v of idxs) {
        const links = linksByPage.get(ids[v]) ?? [];
        const s = local.get(v)!;
        let count = 0;
        for (const l of links) {
          if (l.target === null) continue;
          const tl = idToIdx.get(l.target);
          if (tl === undefined) continue;
          const li = local.get(tl);
          if (li === undefined || li === s) continue;
          const key = s + ":" + li;
          if (seen.has(key)) continue;
          seen.add(key);
          rawEdges.push([s, li, succ[v] === tl ? 1 : 0]);
          if (++count >= 4) break;
        }
      }
      // belt and braces: drop anything that still ended up with no connections
      const deg = new Map<number, number>();
      for (const [s, t] of rawEdges) {
        deg.set(s, (deg.get(s) ?? 0) + 1);
        deg.set(t, (deg.get(t) ?? 0) + 1);
      }
      const keep = idxs.map((_, i) => i).filter((i) => (deg.get(i) ?? 0) > 0);
      const remap = new Map(keep.map((old, nu) => [old, nu]));
      const meshNodes = keep.map((i) => outNodes[i]);
      const meshEdges = rawEdges.filter(([s, t]) => remap.has(s) && remap.has(t))
        .map(([s, t, m]) => [remap.get(s)!, remap.get(t)!, m]);
      const loopsPayload = ranked.slice(0, 4).map(([a, b]) => ({
        cycle: attractors[a].nodes.map((n) => titles.get(ids[n]) ?? "?"),
        pct: +(100 * b / N).toFixed(1),
      }));
      cachePut(res, mck, { nodes: meshNodes, edges: meshEdges, loops: loopsPayload });
      return;
    }
    if (url.pathname === "/api/export") {
      // CSV downloads for the lab's export links
      const rank = (q.get("rank") ?? "strict1").replace(/[^a-z0-9]+/gi, "");
      const what = q.get("what") ?? "distances";
      let csv = "";
      if (what === "distances") {
        const p = path.join(wikiDir, `distances-r${rank}.csv`);
        if (!fs.existsSync(p)) { res.writeHead(404); res.end("no distances csv — run analyze first"); return; }
        csv = fs.readFileSync(p, "utf8");
      } else {
        const st = readSafe(path.join(wikiDir, `stats-r${rank}.json`));
        if (!st) { res.writeHead(404); res.end("no stats — run analyze first"); return; }
        const j = JSON.parse(st);
        if (what === "indegree") {
          csv = "title,inDegree\n" + j.topInDegree.map((r: { title: string; inDegree: number }) => `${JSON.stringify(r.title)},${r.inDegree}`).join("\n");
        } else if (what === "attractors") {
          csv = "cycle,basin,pct\n" + j.topAttractors.map((a: { cycle: string[]; basin: number; pct: number }) => `${JSON.stringify(a.cycle.join(" -> "))},${a.basin},${a.pct}`).join("\n");
        } else { res.writeHead(400); res.end("what must be distances|indegree|attractors"); return; }
      }
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${wiki}-${what}-${rank}.csv"`,
      });
      res.end(csv);
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
  console.log(`  article view  → http://localhost:${PORT}/       (scrollytelling · split / full-width)`);
  console.log(`  lab dashboard → http://localhost:${PORT}/lab`);
  console.log(`  wikis configured: ${wikis.length}, with data: ${available.length} (${available.map((w) => w.id).join(", ") || "none"})`);
});


