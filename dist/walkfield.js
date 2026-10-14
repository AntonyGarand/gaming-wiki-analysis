/* walkfield.js — the whole wiki as a drainage map.
 *
 * Input is the compact successor table (titles[], succ[], term[]) for one wiki
 * at one link rank. From that alone it:
 *   1. finds every loop and which loop each article drains into (buildWalkGraph)
 *   2. lays out *every* article as a radial tree around its loop, loops packed
 *      by basin size so the big whirlpools dominate the picture (layoutWalkGraph)
 *   3. renders a static ink layer (edges + specks) and animates walkers that
 *      follow first links until they fall into a loop (createWalkField)
 *
 * No network, no library. Globals exported: buildWalkGraph, layoutWalkGraph,
 * createWalkField, WALK_COLORS.
 */
(function () {
  "use strict";

  const WALK_COLORS = {
    loops: ["#bc4b27", "#6d3b7e", "#b8862b", "#2f6f73", "#8a4a5e", "#4f6b3a"],
    other: "#5f574a",
    dead: "#9a9183",
    ink: "#201b14",
    paper: "#f8f4ea",
  };
  const TAU = Math.PI * 2;

  /* ------------------------------------------------------------------ *
   * 1. graph analysis
   * ------------------------------------------------------------------ */
  function buildWalkGraph(titles, succ, term) {
    const N = titles.length;
    const S = succ instanceof Int32Array ? succ : Int32Array.from(succ);
    const T = term ? (term instanceof Uint8Array ? term : Uint8Array.from(term)) : new Uint8Array(N);
    const attractor = new Int32Array(N).fill(-1); // loop id, or -1 if the chain dies
    const depth = new Int32Array(N).fill(-1);     // hops to loop entry / to the terminal
    const terminal = new Int32Array(N).fill(-1);  // dead chains: node where they die
    const mark = new Int32Array(N).fill(-1);
    const loops = [];
    let walkId = 0;
    const path = [];
    for (let s = 0; s < N; s++) {
      if (mark[s] !== -1) continue;
      walkId++;
      path.length = 0;
      let cur = s;
      for (;;) {
        if (mark[cur] === walkId) {
          // closed a new loop inside this walk
          const at = path.indexOf(cur);
          const nodes = path.slice(at);
          const id = loops.push({ id: loops.length, nodes, basin: 0 }) - 1;
          for (const n of nodes) { attractor[n] = id; depth[n] = 0; }
          for (let p = at - 1; p >= 0; p--) { attractor[path[p]] = id; depth[path[p]] = at - p; }
          break;
        }
        if (mark[cur] !== -1) {
          // joined something already classified
          const a = attractor[cur], base = depth[cur], t = terminal[cur];
          for (let p = path.length - 1; p >= 0; p--) { attractor[path[p]] = a; depth[path[p]] = base + (path.length - p); terminal[path[p]] = t; }
          break;
        }
        mark[cur] = walkId; path.push(cur);
        const nx = S[cur];
        if (nx < 0) {
          for (let p = 0; p < path.length; p++) { attractor[path[p]] = -1; depth[path[p]] = path.length - 1 - p; terminal[path[p]] = cur; }
          break;
        }
        cur = nx;
      }
    }
    const inDeg = new Int32Array(N);
    for (let i = 0; i < N; i++) if (S[i] >= 0) inDeg[S[i]]++;
    for (let i = 0; i < N; i++) if (attractor[i] >= 0) loops[attractor[i]].basin++;
    // start each loop at its most-entered node so names read the same everywhere
    for (const l of loops) {
      let best = 0;
      for (let k = 1; k < l.nodes.length; k++) if (inDeg[l.nodes[k]] > inDeg[l.nodes[best]]) best = k;
      if (best) l.nodes = l.nodes.slice(best).concat(l.nodes.slice(0, best));
    }
    loops.sort((a, b) => b.basin - a.basin || a.nodes.length - b.nodes.length);
    const rank = new Int32Array(loops.length);
    loops.forEach((l, i) => { rank[l.id] = i; l.id = i; });
    for (let i = 0; i < N; i++) if (attractor[i] >= 0) attractor[i] = rank[attractor[i]];
    let dead = 0;
    for (let i = 0; i < N; i++) if (attractor[i] < 0) dead++;

    function walk(start) {
      const chain = [start];
      const seen = new Set([start]);
      let cur = start;
      for (;;) {
        const nx = S[cur];
        if (nx < 0) {
          const code = T[cur];
          const reason = code === 2 ? "not enough eligible links at this rank" : code === 3 ? "every candidate was a red link" : "no eligible links";
          return { chain, fate: "dead", cycleSize: 0, hops: chain.length - 1, reason, terminal: cur };
        }
        if (seen.has(nx)) {
          const first = chain.indexOf(nx);
          return { chain, fate: "cycle", cycleSize: chain.length - first, hops: first, reason: "", loop: attractor[nx] };
        }
        seen.add(nx); chain.push(nx); cur = nx;
        if (chain.length > 400) return { chain, fate: "dead", cycleSize: 0, hops: chain.length - 1, reason: "walk too long", terminal: cur };
      }
    }
    return { N, titles, succ: S, term: T, attractor, depth, terminal, loops, inDeg, dead, walk };
  }

  /* ------------------------------------------------------------------ *
   * 2. layout — territories packed by size, radial trees inside
   * ------------------------------------------------------------------ */
  function layoutWalkGraph(g, W, H, opts) {
    opts = opts || {};
    const { N, succ, attractor, depth, terminal, loops } = g;
    const minDead = opts.minDeadTerritory ?? 3;
    const minLoop = opts.minLoopTerritory ?? 2;

    // children lists (CSR) — predecessors, excluding edges that close a loop
    const childCount = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) { const s = succ[i]; if (s >= 0 && depth[i] > 0) childCount[s + 1]++; }
    for (let i = 0; i < N; i++) childCount[i + 1] += childCount[i];
    const childAt = new Int32Array(N);
    const fill = childCount.slice(0, N);
    for (let i = 0; i < N; i++) { const s = succ[i]; if (s >= 0 && depth[i] > 0) childAt[fill[s]++] = i; }

    // subtree sizes (nodes processed from deepest up)
    const size = new Int32Array(N).fill(1);
    const order = new Int32Array(N); for (let i = 0; i < N; i++) order[i] = i;
    order.sort((a, b) => depth[b] - depth[a]);
    for (let k = 0; k < N; k++) { const i = order[k]; const s = succ[i]; if (s >= 0 && depth[i] > 0) size[s] += size[i]; }

    // territories: loops (by basin) and dead terminals (by chains dying there)
    const terr = [];           // { roots:[], total, R, cx, cy, loop, maxDepth }
    const terrOf = new Int32Array(N).fill(-1);
    for (const l of loops) {
      if (l.basin < minLoop) continue;
      terr.push({ roots: l.nodes, total: l.basin, loop: l.id });
    }
    const deadRoots = [];
    for (let i = 0; i < N; i++) if (attractor[i] < 0 && terminal[i] === i) deadRoots.push(i);
    for (const r of deadRoots) if (size[r] >= minDead) terr.push({ roots: [r], total: size[r], loop: -1 });
    terr.sort((a, b) => b.total - a.total);
    terr.forEach((t, ti) => {
      let md = 0;
      // mark territory membership + depth via DFS from roots
      const stack = t.roots.slice();
      for (const r of t.roots) terrOf[r] = ti;
      while (stack.length) {
        const v = stack.pop();
        if (depth[v] > md) md = depth[v];
        for (let c = childCount[v]; c < childCount[v + 1]; c++) { const ch = childAt[c]; terrOf[ch] = ti; stack.push(ch); }
      }
      t.maxDepth = md;
    });

    // radii: area ∝ members, with a floor so tiny territories stay visible
    const area = Math.min(W, H) * Math.min(W, H) * (opts.fill ?? 0.62);
    const sum = terr.reduce((a, t) => a + Math.max(t.total, 4), 0);
    const unit = Math.sqrt(area / Math.PI / Math.max(1, sum));
    for (const t of terr) t.R = Math.max(6, unit * Math.sqrt(Math.max(t.total, 4)) * (t.loop >= 0 ? 1 : 0.8));

    // pack on a sunflower spiral, largest first
    const placed = [];
    const pad = Math.max(3, unit * 0.6);
    for (const t of terr) {
      if (!placed.length) { t.cx = 0; t.cy = 0; placed.push(t); continue; }
      const step = Math.max(2, t.R * 0.35);
      let n = 0, ok = false;
      while (!ok && n < 6000) {
        const r = step * Math.sqrt(n), a = n * 2.399963;
        const x = r * Math.cos(a), y = r * Math.sin(a);
        ok = true;
        for (const p of placed) {
          const dx = p.cx - x, dy = p.cy - y, need = p.R + t.R + pad;
          if (dx * dx + dy * dy < need * need) { ok = false; break; }
        }
        if (ok) { t.cx = x; t.cy = y; placed.push(t); }
        n++;
      }
      if (!ok) { t.cx = (Math.random() - 0.5) * W; t.cy = (Math.random() - 0.5) * H; placed.push(t); }
    }

    // radial trees inside each territory
    const x = new Float32Array(N), y = new Float32Array(N);
    const jitter = (i) => ((i * 2654435761) >>> 0) / 4294967296 - 0.5;
    const stack = [];
    for (const t of terr) {
      const roots = t.roots;
      const total = roots.reduce((a, r) => a + size[r], 0);
      const core = t.loop >= 0 ? Math.min(t.R * 0.22, 4 + 2.2 * roots.length) : 0;
      const gap = t.maxDepth > 0 ? (t.R - core) / t.maxDepth : 0;
      let a0 = -Math.PI / 2 + jitter(t.roots[0]) * TAU;
      for (const r of roots) {
        const w = TAU * (size[r] / Math.max(1, total));
        const am = a0 + w / 2;
        x[r] = t.cx + Math.cos(am) * core; y[r] = t.cy + Math.sin(am) * core;
        stack.push(r, a0, w, 1);
        a0 += w;
      }
      while (stack.length) {
        const d = stack.pop(), w = stack.pop(), a = stack.pop(), v = stack.pop();
        const c0 = childCount[v], c1 = childCount[v + 1];
        if (c0 === c1) continue;
        const kids = childAt.subarray(c0, c1);
        if (kids.length > 1) kids.sort((p, q) => size[q] - size[p]);
        const inner = size[v] - 1;
        let off = a;
        for (let k = 0; k < kids.length; k++) {
          const ch = kids[k];
          const cw = w * (size[ch] / Math.max(1, inner));
          const ca = off + cw / 2; off += cw;
          const rad = core + d * gap * (1 + 0.28 * jitter(ch));
          x[ch] = t.cx + Math.cos(ca) * rad; y[ch] = t.cy + Math.sin(ca) * rad;
          stack.push(ch, off - cw, cw, d + 1);
        }
      }
    }

    // dust: everything in no territory (tiny loops, lonely dead chains) rings the outside
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const t of terr) { minX = Math.min(minX, t.cx - t.R); maxX = Math.max(maxX, t.cx + t.R); minY = Math.min(minY, t.cy - t.R); maxY = Math.max(maxY, t.cy + t.R); }
    if (!terr.length) { minX = -1; maxX = 1; minY = -1; maxY = 1; }
    const ccx = (minX + maxX) / 2, ccy = (minY + maxY) / 2;
    const ring = Math.max(maxX - minX, maxY - minY) / 2 * 1.04;
    let dust = 0;
    for (let i = 0; i < N; i++) {
      if (terrOf[i] >= 0) continue;
      dust++;
      const root = attractor[i] >= 0 ? loops[attractor[i]].nodes[0] : terminal[i];
      const a = jitter(root * 7 + 1) * TAU + jitter(i * 3 + 11) * 0.05;
      const rr = ring * (1.02 + 0.05 * depth[i] + 0.04 * (jitter(i * 13 + 5) + 0.5));
      x[i] = ccx + Math.cos(a) * rr; y[i] = ccy + Math.sin(a) * rr;
    }

    // fit to canvas — on the territories only; the dust ring may run past the edge
    minX = Infinity; maxX = -Infinity; minY = Infinity; maxY = -Infinity;
    for (let i = 0; i < N; i++) { if (terrOf[i] < 0) continue; if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i]; if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i]; }
    if (!isFinite(minX)) { minX = -1; maxX = 1; minY = -1; maxY = 1; }
    const padPx = opts.padding ?? 18;
    const sx = (W - 2 * padPx) / Math.max(1, maxX - minX), sy = (H - 2 * padPx) / Math.max(1, maxY - minY);
    const s = Math.min(sx, sy);
    const ox = (W - (maxX - minX) * s) / 2 - minX * s, oy = (H - (maxY - minY) * s) / 2 - minY * s;
    for (let i = 0; i < N; i++) { x[i] = x[i] * s + ox; y[i] = y[i] * s + oy; }
    const centers = terr.map((t) => ({ x: t.cx * s + ox, y: t.cy * s + oy, r: t.R * s, loop: t.loop, total: t.total, root: t.roots[0] }));
    return { x, y, centers, size, dust, terrOf };
  }

  /* ------------------------------------------------------------------ *
   * 3. renderer
   * ------------------------------------------------------------------ */
  function createWalkField(container, opts) {
    opts = Object.assign({
      walkers: 320, speed: 90, explore: false, labels: 6, edgeAlpha: 0.09,
      reduced: false, onHover: null, onClick: null, urlFor: null,
    }, opts || {});
    const base = document.createElement("canvas"), live = document.createElement("canvas");
    for (const c of [base, live]) { c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;"; container.appendChild(c); }
    const bctx = base.getContext("2d"), lctx = live.getContext("2d");
    let W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
    let g = null, L = null, colorOf = null;
    const view = { k: 1, tx: 0, ty: 0 };
    let walkers = [], hover = -1, hoverChain = null, visible = true, running = !opts.reduced;
    let lastT = 0, baseDirty = true, grid = null, gridCell = 18;
    const mouse = { x: -1e9, y: -1e9 };

    function resize() {
      const r = container.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      for (const c of [base, live]) { c.width = W * dpr; c.height = H * dpr; }
      if (g) { L = layoutWalkGraph(g, W, H, opts.layout); buildGrid(); respawnAll(); }
      baseDirty = true;
      if (!running) frame(performance.now());
    }
    function setGraph(graph) {
      g = graph;
      colorOf = (i) => {
        const a = g.attractor[i];
        return a < 0 ? WALK_COLORS.dead : a < WALK_COLORS.loops.length ? WALK_COLORS.loops[a] : WALK_COLORS.other;
      };
      view.k = 1; view.tx = 0; view.ty = 0;
      L = layoutWalkGraph(g, W, H, opts.layout);
      buildGrid(); respawnAll();
      baseDirty = true; hover = -1; hoverChain = null;
      if (!running) frame(performance.now());
    }
    function buildGrid() {
      grid = new Map();
      for (let i = 0; i < g.N; i++) {
        const key = ((L.x[i] / gridCell) | 0) + "," + ((L.y[i] / gridCell) | 0);
        let a = grid.get(key); if (!a) { a = []; grid.set(key, a); } a.push(i);
      }
    }
    function nearest(wx, wy, maxD) {
      if (!grid) return -1;
      const cx = (wx / gridCell) | 0, cy = (wy / gridCell) | 0;
      let best = maxD * maxD, hit = -1;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const a = grid.get((cx + dx) + "," + (cy + dy)); if (!a) continue;
        for (const i of a) { const d = (L.x[i] - wx) ** 2 + (L.y[i] - wy) ** 2; if (d < best) { best = d; hit = i; } }
      }
      return hit;
    }
    // world <-> screen
    const toScreen = (wx, wy) => [wx * view.k + view.tx, wy * view.k + view.ty];
    const toWorld = (sx, sy) => [(sx - view.tx) / view.k, (sy - view.ty) / view.k];

    function spawn(w) {
      // start anywhere; big basins get more walkers simply because they have more articles
      let i = (Math.random() * g.N) | 0, tries = 0;
      while (g.succ[i] < 0 && tries++ < 8) i = (Math.random() * g.N) | 0;
      w.node = i; w.next = g.succ[i]; w.t = 0; w.alpha = 0; w.loopHops = 0; w.dying = false;
      w.len = w.next >= 0 ? Math.max(1, Math.hypot(L.x[w.next] - L.x[i], L.y[w.next] - L.y[i])) : 1;
      w.col = colorOf(i);
      w.px = L.x[i]; w.py = L.y[i];
    }
    function respawnAll() {
      walkers = [];
      const n = opts.reduced ? 0 : opts.walkers;
      for (let k = 0; k < n; k++) { const w = {}; spawn(w); w.t = Math.random(); walkers.push(w); }
    }

    function drawBase() {
      baseDirty = false;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.clearRect(0, 0, W, H);
      if (!g) return;
      bctx.translate(view.tx, view.ty); bctx.scale(view.k, view.k);
      const { x, y } = L;
      // edges, batched per colour so the canvas does few strokes
      const buckets = new Map();
      for (let i = 0; i < g.N; i++) {
        const s = g.succ[i]; if (s < 0 || s === i) continue;
        const c = colorOf(i); let p = buckets.get(c); if (!p) { p = new Path2D(); buckets.set(c, p); }
        p.moveTo(x[i], y[i]); p.lineTo(x[s], y[s]);
      }
      bctx.lineWidth = Math.max(0.35, 0.7 / view.k);
      bctx.globalAlpha = opts.edgeAlpha;
      for (const [c, p] of buckets) { bctx.strokeStyle = c; bctx.stroke(p); }
      // specks
      bctx.globalAlpha = 0.55;
      const sz = Math.max(0.8, 1.3 / view.k);
      const dots = new Map();
      for (let i = 0; i < g.N; i++) { const c = colorOf(i); let p = dots.get(c); if (!p) { p = new Path2D(); dots.set(c, p); } p.rect(x[i] - sz / 2, y[i] - sz / 2, sz, sz); }
      for (const [c, p] of dots) { bctx.fillStyle = c; bctx.fill(p); }
      // loop nodes: a small ring
      bctx.globalAlpha = 0.9; bctx.lineWidth = Math.max(0.6, 1 / view.k);
      for (const l of g.loops.slice(0, 40)) {
        bctx.strokeStyle = l.id < WALK_COLORS.loops.length ? WALK_COLORS.loops[l.id] : WALK_COLORS.other;
        for (const n of l.nodes) { bctx.beginPath(); bctx.arc(x[n], y[n], Math.max(1.6, 2.6 / view.k), 0, TAU); bctx.stroke(); }
      }
      // labels for the biggest territories
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.globalAlpha = 1;
      bctx.font = "600 10.5px 'Space Mono', monospace"; bctx.textAlign = "center"; bctx.textBaseline = "middle";
      let shown = 0;
      const placed = [];
      for (const c of L.centers) {
        if (shown >= opts.labels) break;
        if (c.loop < 0 && shown > 2) continue;
        const [sx, sy] = toScreen(c.x, c.y);
        if (sx < 0 || sx > W || sy < 0 || sy > H) continue;
        const label = c.loop >= 0 ? g.loops[c.loop].nodes.map((n) => g.titles[n]).join(" → ") : g.titles[c.root] + " ✝";
        const text = label.length > 44 ? label.slice(0, 43) + "…" : label;
        const tw = bctx.measureText(text).width;
        // try above, then below, then centred; skip if it would overlap an existing label
        let ok = false, ly = 0;
        for (const cand of [sy - c.r * view.k - 9, sy + c.r * view.k + 9, sy]) {
          const r = { x: sx - tw / 2 - 3, y: cand - 8, w: tw + 6, h: 16 };
          if (r.x < 0 || r.x + r.w > W || r.y < 0 || r.y + r.h > H) continue;
          if (placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y)) continue;
          placed.push(r); ly = cand; ok = true; break;
        }
        if (!ok) continue;
        bctx.lineWidth = 4; bctx.strokeStyle = "rgba(248,244,234,0.9)"; bctx.strokeText(text, sx, ly);
        bctx.fillStyle = c.loop >= 0 ? (c.loop < WALK_COLORS.loops.length ? WALK_COLORS.loops[c.loop] : WALK_COLORS.other) : WALK_COLORS.dead;
        bctx.fillText(text, sx, ly);
        shown++;
      }
    }

    function frame(now) {
      if (baseDirty) drawBase();
      const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016); lastT = now;
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (running) {
        lctx.globalCompositeOperation = "destination-out";
        lctx.fillStyle = "rgba(0,0,0,0.16)"; lctx.fillRect(0, 0, W, H);
      } else lctx.clearRect(0, 0, W, H);
      lctx.globalCompositeOperation = "source-over";
      if (!g) return;
      lctx.translate(view.tx, view.ty); lctx.scale(view.k, view.k);
      if (running) {
        const sp = opts.speed;
        lctx.lineCap = "round";
        for (const w of walkers) {
          if (w.dying) { w.alpha -= dt * 2.2; if (w.alpha <= 0) spawn(w); continue; }
          w.alpha = Math.min(1, w.alpha + dt * 2);
          if (w.next < 0) { w.dying = true; continue; }
          w.t += (dt * sp) / w.len;
          if (w.t >= 1) {
            w.node = w.next; w.next = g.succ[w.node]; w.t = 0;
            if (g.depth[w.node] === 0 && g.attractor[w.node] >= 0) {
              w.loopHops++;
              const L2 = g.loops[g.attractor[w.node]].nodes.length;
              if (w.loopHops > L2 * 2 + 1) { w.dying = true; }
            }
            if (w.next < 0) { w.dying = true; }
            w.len = w.next >= 0 ? Math.max(1, Math.hypot(L.x[w.next] - L.x[w.node], L.y[w.next] - L.y[w.node])) : 1;
            w.px = L.x[w.node]; w.py = L.y[w.node];
            continue;
          }
          const nx = L.x[w.node] + (L.x[w.next] - L.x[w.node]) * w.t, ny = L.y[w.node] + (L.y[w.next] - L.y[w.node]) * w.t;
          lctx.strokeStyle = w.col; lctx.globalAlpha = 0.85 * w.alpha; lctx.lineWidth = 1.4 / view.k;
          lctx.beginPath(); lctx.moveTo(w.px, w.py); lctx.lineTo(nx, ny); lctx.stroke();
          w.px = nx; w.py = ny;
        }
      }
      // hovered chain
      if (hoverChain) {
        const ch = hoverChain.chain;
        lctx.globalAlpha = 0.95; lctx.lineWidth = 1.8 / view.k; lctx.strokeStyle = WALK_COLORS.ink;
        lctx.beginPath(); lctx.moveTo(L.x[ch[0]], L.y[ch[0]]);
        for (let i = 1; i < ch.length; i++) lctx.lineTo(L.x[ch[i]], L.y[ch[i]]);
        if (hoverChain.fate === "cycle") lctx.lineTo(L.x[ch[ch.length - hoverChain.cycleSize]], L.y[ch[ch.length - hoverChain.cycleSize]]);
        lctx.stroke();
        lctx.fillStyle = WALK_COLORS.ink;
        for (const n of ch) { lctx.beginPath(); lctx.arc(L.x[n], L.y[n], 2.2 / view.k, 0, TAU); lctx.fill(); }
        // labels along the chain (start, a few waypoints, loop)
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lctx.font = "10px 'Space Mono', monospace"; lctx.textAlign = "left"; lctx.textBaseline = "bottom";
        const picks = new Set([0, ch.length - 1]);
        if (hoverChain.fate === "cycle") for (let i = ch.length - hoverChain.cycleSize; i < ch.length; i++) picks.add(i);
        if (ch.length > 4) picks.add(Math.floor(ch.length / 2));
        const placed = [];
        for (const i of [...picks].sort((a, b) => a - b)) {
          const [sx, sy] = toScreen(L.x[ch[i]], L.y[ch[i]]);
          const t = g.titles[ch[i]]; const text = (i === 0 ? "▶ " : "") + (t.length > 34 ? t.slice(0, 33) + "…" : t);
          const wpx = lctx.measureText(text).width;
          let ly = sy - 5;
          for (const r of placed) if (Math.abs(r.y - ly) < 13 && sx < r.x + r.w + 6 && sx + wpx > r.x - 6) ly = r.y - 13;
          placed.push({ x: sx, y: ly, w: wpx });
          lctx.lineWidth = 3.5; lctx.strokeStyle = "rgba(248,244,234,0.92)"; lctx.strokeText(text, sx + 5, ly);
          lctx.fillStyle = i === 0 ? WALK_COLORS.ink : (hoverChain.fate === "cycle" && i >= ch.length - hoverChain.cycleSize ? (colorOf(ch[i])) : "#5f574a");
          lctx.fillText(text, sx + 5, ly);
        }
      }
      lctx.globalAlpha = 1;
    }
    let raf = 0;
    function tick(now) {
      raf = 0;
      if (!visible || document.hidden) return;
      frame(now);
      if (running) raf = requestAnimationFrame(tick);
    }
    function kick() { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick); }

    // interaction
    container.addEventListener("pointermove", (e) => {
      const r = container.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
      if (drag) {
        view.tx = drag.tx + (mouse.x - drag.x); view.ty = drag.ty + (mouse.y - drag.y);
        baseDirty = true; if (!running) kickOnce(); return;
      }
      if (!g) return;
      const [wx, wy] = toWorld(mouse.x, mouse.y);
      const hit = nearest(wx, wy, 9 / view.k);
      if (hit !== hover) {
        hover = hit; hoverChain = hit >= 0 ? g.walk(hit) : null;
        container.style.cursor = hit >= 0 ? "pointer" : (opts.explore ? "grab" : "");
        if (opts.onHover) opts.onHover(hit, hoverChain);
        if (!running) kickOnce();
      }
    });
    container.addEventListener("pointerleave", () => { hover = -1; hoverChain = null; container.style.cursor = ""; if (opts.onHover) opts.onHover(-1, null); if (!running) kickOnce(); });
    let drag = null, downAt = null;
    container.addEventListener("pointerdown", (e) => {
      downAt = { x: e.clientX, y: e.clientY };
      if (opts.explore && hover < 0) { drag = { x: mouse.x, y: mouse.y, tx: view.tx, ty: view.ty }; container.setPointerCapture(e.pointerId); container.style.cursor = "grabbing"; }
    });
    container.addEventListener("pointerup", (e) => {
      const moved = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
      drag = null; downAt = null; container.style.cursor = hover >= 0 ? "pointer" : (opts.explore ? "grab" : "");
      if (!moved && hover >= 0) {
        if (opts.onClick) opts.onClick(hover, hoverChain);
        else if (opts.urlFor) window.open(opts.urlFor(g.titles[hover]), "_blank", "noopener");
      }
    });
    if (opts.explore) {
      container.addEventListener("wheel", (e) => {
        e.preventDefault();
        const k2 = Math.min(12, Math.max(0.5, view.k * Math.exp(-e.deltaY * 0.0014)));
        view.tx = mouse.x - (mouse.x - view.tx) * (k2 / view.k); view.ty = mouse.y - (mouse.y - view.ty) * (k2 / view.k);
        view.k = k2; baseDirty = true; if (!running) kickOnce();
      }, { passive: false });
    }
    function kickOnce() { if (!raf) raf = requestAnimationFrame((t) => { raf = 0; frame(t); }); }

    new IntersectionObserver((en) => { visible = en[0].isIntersecting; if (visible) kick(); }, { threshold: 0.02 }).observe(container);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
    const ro = new ResizeObserver(() => { resize(); kick(); });
    ro.observe(container);
    resize();
    kick();

    return {
      setGraph,
      pause() { running = false; },
      resume() { running = !opts.reduced; kick(); },
      focus(i) { hover = i; hoverChain = i >= 0 ? g.walk(i) : null; kickOnce(); },
      resetView() { view.k = 1; view.tx = 0; view.ty = 0; baseDirty = true; kickOnce(); },
      layout: () => L,
      graph: () => g,
      destroy() { ro.disconnect(); running = false; base.remove(); live.remove(); },
    };
  }

  window.WALK_COLORS = WALK_COLORS;
  window.buildWalkGraph = buildWalkGraph;
  window.layoutWalkGraph = layoutWalkGraph;
  window.createWalkField = createWalkField;
})();
