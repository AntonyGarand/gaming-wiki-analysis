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
    // upstream(i): how many articles' walks pass through i (i included). Loop nodes see their whole basin;
    // everything else is a reverse flood from i over the first-link edges. Built lazily, memoised.
    let rStart = null, rList = null;
    const upMemo = new Map();
    function buildReverse() {
      rStart = new Int32Array(N + 1);
      for (let i = 0; i < N; i++) if (S[i] >= 0) rStart[S[i] + 1]++;
      for (let i = 0; i < N; i++) rStart[i + 1] += rStart[i];
      rList = new Int32Array(rStart[N]);
      const fill = rStart.slice(0, N);
      for (let i = 0; i < N; i++) if (S[i] >= 0) rList[fill[S[i]]++] = i;
    }
    function upstream(i) {
      if (attractor[i] >= 0 && depth[i] === 0) return loops[attractor[i]].basin;
      if (upMemo.has(i)) return upMemo.get(i);
      if (!rStart) buildReverse();
      const seen = new Uint8Array(N); const stack = [i]; seen[i] = 1; let count = 0;
      while (stack.length) {
        const n = stack.pop(); count++;
        for (let k = rStart[n]; k < rStart[n + 1]; k++) { const p = rList[k]; if (!seen[p]) { seen[p] = 1; stack.push(p); } }
      }
      upMemo.set(i, count);
      return count;
    }
    return { N, titles, succ: S, term: T, attractor, depth, terminal, loops, inDeg, dead, walk, upstream };
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
      walkers: 320, speed: 90, explore: true, labels: 6, maxLabels: 28, edgeAlpha: 0.09,
      wheel: "always",            // "always" | "modifier" (ctrl/⌘ + wheel, so the page can still scroll)
      reduced: false, onHover: null, onClick: null, urlFor: null, onView: null,
      touchAction: "none",        // "pan-y" lets a touch page scroll over the field; pinch/drag then only work fullscreen
    }, opts || {});
    const base = document.createElement("canvas"), live = document.createElement("canvas"), cacheC = document.createElement("canvas");
    for (const c of [base, live]) { c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;"; container.appendChild(c); }
    container.style.touchAction = opts.touchAction;
    const bctx = base.getContext("2d"), lctx = live.getContext("2d"), cctx = cacheC.getContext("2d");
    let W = 0, H = 0, dpr = 1;
    // pixel budget: retina sharpness on a panel, fewer pixels to push on a fullscreen canvas.
    // 8.3MP ≈ one 4K frame: panels and 1080p-at-2x render at native dpr; only
    // larger viewports clamp — dropping below native dpr makes the compositor
    // upscale the bitmap, which reads as the whole field going soft
    const pickDpr = () => Math.max(1, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8.3e6 / Math.max(1, W * H))));
    let g = null, L = null, colorOf = null;
    const colorOfFor = (gr) => (i) => {
      const a = gr.attractor[i];
      return a < 0 ? WALK_COLORS.dead : a < WALK_COLORS.loops.length ? WALK_COLORS.loops[a] : WALK_COLORS.other;
    };
    // morphing a rank switch re-renders the whole field every frame; past this
    // node count a snapshot crossfade stands in instead (rs3-class wikis)
    const MORPH_MAX_N = opts.morphMaxNodes ?? 40000;
    const view = { k: 1, tx: 0, ty: 0 };
    let cacheView = null, anim = null, lastView = null, morph = null; // rank-switch morph state (stepMorph)
    let baseStale = false, lastInteract = 0;   // interaction in progress: redraw from the cached bitmap
    const SETTLE_MS = 140;
    // The base layer (every edge, dot and label) is too expensive to re-render
    // per frame, so pans/zooms replay a cached bitmap. The cache is CACHE_PAD
    // larger than the canvas on every side, which keeps short drags crisp — and
    // once a drag eats into that runway (RUNWAY_USED of it), the frame loop
    // re-renders at the current view, but never more often than REBASE_MS, so a
    // long pan costs a few heavier frames per second instead of one per frame.
    const CACHE_PAD = 0.35, REBASE_MS = 180, RUNWAY_USED = 0.25;
    let cacheOX = 0, cacheOY = 0, cacheW = 0, cacheH = 0; // device px: cache size + viewport offset inside it
    let lastBaseDraw = 0;
    let walkers = [], hover = -1, hoverChain = null, visible = true, running = !opts.reduced;
    let lastT = 0, baseDirty = true, grid = null, gridCell = 18;
    const mouse = { x: -1e9, y: -1e9 };
    const MIN_K = 0.5, MAX_K = 40;

    function resize() {
      const r = container.getBoundingClientRect();
      // round the CSS size and pin it: a fractional rect (width:100% of an odd
      // viewport, 125%/150% Windows scaling) against a rounded backing store
      // leaves the canvas resampled by the compositor — soft ink everywhere
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      dpr = pickDpr();
      for (const c of [base, live]) {
        c.style.width = W + "px"; c.style.height = H + "px";
        c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      }
      dpr = base.width / W; // exact achieved scale, so every setTransform(dpr,…) lands on device pixels
      cacheOX = Math.round(W * dpr * CACHE_PAD); cacheOY = Math.round(H * dpr * CACHE_PAD);
      cacheW = base.width + 2 * cacheOX; cacheH = base.height + 2 * cacheOY;
      cacheC.width = cacheW; cacheC.height = cacheH;
      cacheView = null;
      morph = null; // a resize invalidates the morph's from/to coordinates — snap to the relayout
      if (g) { L = layoutWalkGraph(g, W, H, opts.layout); buildGrid(); respawnAll(); }
      view.k = 1; view.tx = 0; view.ty = 0; anim = null;
      baseDirty = true;
      if (!running) kickOnce();
    }
    function setGraph(graph, animOpts) {
      const prevG = g, prevColor = colorOf;
      const sameUniverse = !!prevG && prevG !== graph && (
        prevG.titles === graph.titles ||                            // static hosts share one titles array per wiki
        (!!(animOpts && animOpts.animate) && prevG.N === graph.N)   // live hosts vouch the wiki didn't change
      );
      const canAnimate = sameUniverse && !opts.reduced && W > 1 && H > 1;
      if (canAnimate && graph.N > MORPH_MAX_N) crossfadeOldBase(); // too big to morph — blend a snapshot instead
      g = graph;
      colorOf = colorOfFor(graph);
      hover = -1; hoverChain = null;
      if (canAnimate && graph.N <= MORPH_MAX_N) {
        // morph: same titles per wiki, so every node glides to its new layout
        // position while the old ink dissolves and the new ink condenses
        const Ln = layoutWalkGraph(g, W, H, opts.layout);
        morph = {
          x0: L.x, y0: L.y,                               // frozen once L is swapped below (retargets pick up mid-flight positions)
          x1: Float32Array.from(Ln.x), y1: Float32Array.from(Ln.y),
          succ0: prevG.succ, colorOf0: prevColor || colorOf, g0: prevG,
          centers0: morph ? null : L.centers,             // retargeting mid-morph: the old labels have already dissolved
          t0: performance.now(), dur: opts.morphMs ?? 850, frames: 0, ms: 0,
          keep: [], out: [], inn: [],
          px: graph.N > 20000 ? Math.min(dpr, 0.75) : Math.min(dpr, 1), // raster scale for the flight
        };
        // the morph rasterises at reduced device pixels — a field in flight hides
        // the softness, and the landing render restores full sharpness
        { const bw = Math.max(1, Math.round(W * morph.px)); if (base.width !== bw) base.width = bw;
          const bh = Math.max(1, Math.round(H * morph.px)); if (base.height !== bh) base.height = bh; }
        for (let i = 0; i < graph.N; i++) {
          if (morph.succ0[i] === g.succ[i] && morph.colorOf0(i) === colorOf(i)) morph.keep.push(i);
          else { morph.out.push(i); morph.inn.push(i); }  // changed edge or colour: old fades out, new fades in
        }
        L = Ln;
        if (view.k !== 1 || view.tx !== 0 || view.ty !== 0)
          anim = { from: { ...view }, to: { k: 1, tx: 0, ty: 0 }, t0: morph.t0, dur: morph.dur }; // ride the view home with the morph
        cacheView = null; baseDirty = false; baseStale = false; // the morph owns the base layer until it lands
        if (!running) kickOnce();
        return;
      }
      morph = null;
      { const bw = Math.round(W * dpr); if (base.width !== bw) base.width = bw;   // a cancelled morph may have shrunk it
        const bh = Math.round(H * dpr); if (base.height !== bh) base.height = bh; }
      view.k = 1; view.tx = 0; view.ty = 0; anim = null;
      L = layoutWalkGraph(g, W, H, opts.layout);
      buildGrid(); respawnAll();
      baseDirty = true;
      if (!running) kickOnce();
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
      const reach = Math.max(1, Math.ceil(maxD / gridCell));
      const cx = (wx / gridCell) | 0, cy = (wy / gridCell) | 0;
      let best = maxD * maxD, hit = -1;
      for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
        const a = grid.get((cx + dx) + "," + (cy + dy)); if (!a) continue;
        for (const i of a) { const d = (L.x[i] - wx) ** 2 + (L.y[i] - wy) ** 2; if (d < best) { best = d; hit = i; } }
      }
      return hit;
    }
    const toScreen = (wx, wy) => [wx * view.k + view.tx, wy * view.k + view.ty];
    const toWorld = (sx, sy) => [(sx - view.tx) / view.k, (sy - view.ty) / view.k];

    // ---- view control (zoom toward a screen point, animated) ----
    function clampView(v) {
      v.k = Math.min(MAX_K, Math.max(MIN_K, v.k));
      // keep the picture on screen: at least a third of the canvas must stay covered
      const minX = -W * v.k + W / 3, maxX = W * 2 / 3, minY = -H * v.k + H / 3, maxY = H * 2 / 3;
      v.tx = Math.min(maxX, Math.max(minX, v.tx)); v.ty = Math.min(maxY, Math.max(minY, v.ty));
      return v;
    }
    function touch() { baseStale = true; lastInteract = performance.now(); kickOnce(); }
    function zoomAt(factor, sx, sy, animate) {
      const from = anim ? anim.to : { ...view };
      const k2 = Math.min(MAX_K, Math.max(MIN_K, from.k * factor));
      const to = clampView({ k: k2, tx: sx - (sx - from.tx) * (k2 / from.k), ty: sy - (sy - from.ty) * (k2 / from.k) });
      if (animate === false || opts.reduced) { Object.assign(view, to); anim = null; touch(); }
      else anim = { from: { ...view }, to, t0: performance.now(), dur: 260 };
      kickOnce(); if (opts.onView) opts.onView(view);
    }
    function panBy(dx, dy) { clampView(view); view.tx += dx; view.ty += dy; clampView(view); anim = null; touch(); }
    function resetView(animate) {
      const to = { k: 1, tx: 0, ty: 0 };
      if (animate === false || opts.reduced) { Object.assign(view, to); anim = null; baseDirty = true; }
      else anim = { from: { ...view }, to, t0: performance.now(), dur: 320 };
      kickOnce();
    }
    function stepAnim(now) {
      if (!anim) return false;
      const t = Math.min(1, (now - anim.t0) / anim.dur), e = 1 - Math.pow(1 - t, 3);
      view.k = anim.from.k + (anim.to.k - anim.from.k) * e;
      view.tx = anim.from.tx + (anim.to.tx - anim.from.tx) * e;
      view.ty = anim.from.ty + (anim.to.ty - anim.from.ty) * e;
      if (t >= 1) { anim = null; baseDirty = true; }
      return true;
    }

    function spawn(w) {
      let i = (Math.random() * g.N) | 0, tries = 0;
      while (g.succ[i] < 0 && tries++ < 8) i = (Math.random() * g.N) | 0;
      w.node = i; w.next = g.succ[i]; w.t = 0; w.alpha = 0; w.loopHops = 0; w.dying = false;
      w.len = w.next >= 0 ? Math.max(1, Math.hypot(L.x[w.next] - L.x[i], L.y[w.next] - L.y[i])) : 1;
      w.col = colorOf(i);
      w.px = L.x[i]; w.py = L.y[i];
    }
    function respawnAll() {
      walkers = [];
      // more canvas, more walkers (fullscreen gets a denser flow)
      const n = opts.reduced ? 0 : Math.round(Math.min(1200, Math.max(80, opts.walkers * (W * H) / (700 * 520))));
      for (let k = 0; k < n; k++) { const w = {}; spawn(w); w.t = Math.random(); walkers.push(w); }
    }

    function drawBase() {
      baseDirty = false;
      lastBaseDraw = performance.now();
      // render into the padded cache bitmap, then blit the viewport slice to
      // the screen — the padding is what lets short pans replay cached ink
      // instead of running off its edge
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, cacheW, cacheH);
      if (!g) { bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, base.width, base.height); return; }
      cctx.setTransform(dpr, 0, 0, dpr, cacheOX, cacheOY);
      cctx.translate(view.tx, view.ty); cctx.scale(view.k, view.k);
      const { x, y } = L;
      const k = view.k;
      // visible world rect (with margin) — skip everything else when zoomed in.
      // the margin matches CACHE_PAD: exactly the area the cache can still show
      // after a pan, so no point rasterising (or culling) beyond it
      const mx = (W / k) * CACHE_PAD, my = (H / k) * CACHE_PAD;
      const vx0 = -view.tx / k - mx, vy0 = -view.ty / k - my, vx1 = (W - view.tx) / k + mx, vy1 = (H - view.ty) / k + my;
      const vis = (i) => x[i] >= vx0 && x[i] <= vx1 && y[i] >= vy0 && y[i] <= vy1;
      const buckets = new Map();
      for (let i = 0; i < g.N; i++) {
        const s = g.succ[i]; if (s < 0 || s === i) continue;
        if (k > 1.5 && !vis(i) && !vis(s)) continue;
        const c = colorOf(i); let p = buckets.get(c); if (!p) { p = new Path2D(); buckets.set(c, p); }
        p.moveTo(x[i], y[i]); p.lineTo(x[s], y[s]);
      }
      cctx.lineWidth = (k > 4 ? 1.1 : k > 1.5 ? 0.85 : 0.7) / k;
      cctx.globalAlpha = Math.min(0.35, opts.edgeAlpha * (1 + Math.log2(Math.max(1, k)) * 0.45));
      for (const [c, p] of buckets) { cctx.strokeStyle = c; cctx.stroke(p); }
      cctx.globalAlpha = 0.55;
      const sz = (k > 4 ? 2.6 : k > 1.5 ? 1.8 : 1.3) / k;
      const dots = new Map();
      for (let i = 0; i < g.N; i++) { if (k > 1.5 && !vis(i)) continue; const c = colorOf(i); let p = dots.get(c); if (!p) { p = new Path2D(); dots.set(c, p); } p.rect(x[i] - sz / 2, y[i] - sz / 2, sz, sz); }
      for (const [c, p] of dots) { cctx.fillStyle = c; cctx.fill(p); }
      cctx.globalAlpha = 0.9; cctx.lineWidth = Math.max(0.6, 1 / k);
      for (const l of g.loops.slice(0, 60)) {
        cctx.strokeStyle = l.id < WALK_COLORS.loops.length ? WALK_COLORS.loops[l.id] : WALK_COLORS.other;
        for (const n of l.nodes) { if (!vis(n)) continue; cctx.beginPath(); cctx.arc(x[n], y[n], Math.max(1.6, 2.6 / k), 0, TAU); cctx.stroke(); }
      }

      // labels — territories first (bigger ones always, smaller ones as they grow on screen),
      // then individual articles once zoomed in far enough. bounds are the
      // padded cache, so labels a pan away are already in place when they
      // slide into view
      const CW = cacheW / dpr, CH = cacheH / dpr;
      // labels are placed with toScreen(), which already bakes in tx/ty/k —
      // drop the world transform before drawing them, or the pan applies
      // twice and the zoom squares, drifting labels off their nodes
      cctx.setTransform(dpr, 0, 0, dpr, cacheOX, cacheOY);
      const placed = [];
      paintCenterLabels(cctx, g, L.centers, CW, CH, 1, placed);
      const fits = labelFits(CW, CH, placed);
      if (k >= 3) {
        // article names: the most linked-to articles on screen, up to a budget that grows with zoom
        const budget = Math.min(160, Math.round(10 * k));
        const minIn = k >= 14 ? 0 : k >= 8 ? 1 : 3;
        const cand = [];
        for (let i = 0; i < g.N; i++) if (vis(i) && (g.inDeg[i] >= minIn || (g.depth[i] === 0 && g.attractor[i] >= 0))) cand.push(i);
        cand.sort((a, b) => g.inDeg[b] - g.inDeg[a]);
        cctx.font = "9.5px 'Space Mono', monospace"; cctx.textBaseline = "bottom"; cctx.textAlign = "left";
        let n = 0;
        for (const i of cand) {
          if (n >= budget) break;
          const [sx, sy] = toScreen(x[i], y[i]);
          const t = g.titles[i]; const text = t.length > 30 ? t.slice(0, 29) + "…" : t;
          const tw = cctx.measureText(text).width;
          const r = { x: sx + 4, y: sy - 14, w: tw + 4, h: 13 };
          if (!fits(r)) continue;
          placed.push(r); n++;
          cctx.lineWidth = 3; cctx.strokeStyle = "rgba(248,244,234,0.85)"; cctx.strokeText(text, sx + 5, sy - 3);
          cctx.fillStyle = g.depth[i] === 0 && g.attractor[i] >= 0 ? colorOf(i) : "#5f574a"; cctx.fillText(text, sx + 5, sy - 3);
        }
      }
      // blit the viewport slice of the cache on screen; keep the padded bitmap
      // for cheap replays while a pan/zoom is under way
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, base.width, base.height);
      bctx.drawImage(cacheC, cacheOX, cacheOY, base.width, base.height, 0, 0, base.width, base.height);
      cacheView = { ...view };
    }
    function drawBaseFromCache() {
      if (!cacheView) return drawBase();
      const s = view.k / cacheView.k;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.clearRect(0, 0, W, H);
      // the cache's viewport slice sits cacheOX/cacheOY into its padded bitmap
      const ox = cacheOX / dpr, oy = cacheOY / dpr;
      bctx.translate(view.tx - (cacheView.tx + ox) * s, view.ty - (cacheView.ty + oy) * s); bctx.scale(s / dpr, s / dpr);
      bctx.drawImage(cacheC, 0, 0);
    }
    // does the padded cache still cover the viewport? returns false once a
    // pan/zoom has eaten RUNWAY_USED of the over-drawn margin, so the
    // re-render lands while most of the runway is still held in reserve
    function cacheCoversView() {
      if (!cacheView) return false;
      const kc = cacheView.k, keep = 1 - RUNWAY_USED;
      const ox = cacheOX / dpr, oy = cacheOY / dpr;         // CSS-px margin baked into the cache
      const px = (ox * keep) / kc, py = (oy * keep) / kc;    // held in reserve, in world units
      return (-view.tx) / view.k >= (-ox - cacheView.tx) / kc + px
        && (W - view.tx) / view.k <= (cacheW / dpr - ox - cacheView.tx) / kc - px
        && (-view.ty) / view.k >= (-oy - cacheView.ty) / kc + py
        && (H - view.ty) / view.k <= (cacheH / dpr - oy - cacheView.ty) / kc - py;
    }

    /* ---- rank morph --------------------------------------------------
     * While a morph runs it owns the base layer: each frame interpolates every
     * node between its old and new layout position, then draws three ink
     * passes straight to the canvas — edges+dots that survive the rank change
     * at full strength, the old topology fading out, the new one fading in.
     * No padded cache and no per-article labels: those come back with the full
     * render when the morph lands. Territory labels dissolve early and the new
     * set arrives at the end, so the map is never mislabelled mid-flight. */
    function stepMorph(now) {
      if (!morph) return false;
      const t = Math.min(1, (now - morph.t0) / morph.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in-out cubic
      const x = L.x, y = L.y, x0 = morph.x0, y0 = morph.y0, x1 = morph.x1, y1 = morph.y1;
      for (let i = 0; i < g.N; i++) { x[i] = x0[i] + (x1[i] - x0[i]) * e; y[i] = y0[i] + (y1[i] - y0[i]) * e; }
      const tDraw = performance.now();
      drawMorphInk(e, t);
      morph.frames++; morph.ms += performance.now() - tDraw;
      if (t >= 1) {
        x.set(x1); y.set(y1);
        const nodes = g.N, frames = morph.frames, ms = morph.ms;
        morph = null;
        buildGrid();
        { const bw = Math.round(W * dpr); if (base.width !== bw) base.width = bw; // full sharpness for the landing render
          const bh = Math.round(H * dpr); if (base.height !== bh) base.height = bh; }
        cacheView = null; baseStale = false; baseDirty = true; // the full render brings labels back
        console.info("walkfield morph: " + nodes.toLocaleString() + " nodes, " + (ms / Math.max(1, frames)).toFixed(1) + " ms/frame over " + frames + " frames");
      }
      return true;
    }
    function drawMorphInk(e, t) {
      const x = L.x, y = L.y, k = view.k, px = morph.px;
      bctx.setTransform(px, 0, 0, px, 0, 0);
      bctx.clearRect(0, 0, W, H);
      bctx.translate(view.tx, view.ty); bctx.scale(k, k);
      const m = 8 / k;
      const vx0 = -view.tx / k - m, vy0 = -view.ty / k - m, vx1 = (W - view.tx) / k + m, vy1 = (H - view.ty) / k + m;
      const vis = (i) => k <= 1.5 || (x[i] >= vx0 && x[i] <= vx1 && y[i] >= vy0 && y[i] <= vy1);
      const edgeA = Math.min(0.35, opts.edgeAlpha * (1 + Math.log2(Math.max(1, k)) * 0.45));
      bctx.lineWidth = (k > 4 ? 1.1 : k > 1.5 ? 0.85 : 0.7) / k;
      const edges = (list, S, col, alpha) => {
        if (alpha <= 0.004) return;
        const buckets = new Map();
        for (let n = 0; n < list.length; n++) {
          const i = list[n], s = S[i]; if (s < 0 || s === i) continue;
          if (k > 1.5 && !vis(i) && !vis(s)) continue;
          const c = col(i); let p = buckets.get(c); if (!p) { p = new Path2D(); buckets.set(c, p); }
          p.moveTo(x[i], y[i]); p.lineTo(x[s], y[s]);
        }
        bctx.globalAlpha = alpha;
        for (const entry of buckets) { bctx.strokeStyle = entry[0]; bctx.stroke(entry[1]); }
      };
      const dots = (list, col, alpha) => {
        if (alpha <= 0.004) return;
        const sz = (k > 4 ? 2.6 : k > 1.5 ? 1.8 : 1.3) / k;
        const buckets = new Map();
        for (let n = 0; n < list.length; n++) {
          const i = list[n];
          if (k > 1.5 && !vis(i)) continue;
          const c = col(i); let p = buckets.get(c); if (!p) { p = new Path2D(); buckets.set(c, p); }
          p.rect(x[i] - sz / 2, y[i] - sz / 2, sz, sz);
        }
        bctx.globalAlpha = alpha;
        for (const entry of buckets) { bctx.fillStyle = entry[0]; bctx.fill(entry[1]); }
      };
      edges(morph.keep, g.succ, colorOf, edgeA);
      edges(morph.out, morph.succ0, morph.colorOf0, edgeA * (1 - e));
      edges(morph.inn, g.succ, colorOf, edgeA * e);
      dots(morph.keep, colorOf, 0.55);
      dots(morph.out, morph.colorOf0, 0.55 * (1 - e));
      dots(morph.inn, colorOf, 0.55 * e);
      const rings = (gr, alpha) => {
        if (alpha <= 0.004) return;
        bctx.globalAlpha = alpha; bctx.lineWidth = Math.max(0.6, 1 / k);
        for (const l of gr.loops.slice(0, 60)) {
          bctx.strokeStyle = l.id < WALK_COLORS.loops.length ? WALK_COLORS.loops[l.id] : WALK_COLORS.other;
          for (const nd of l.nodes) { if (!vis(nd)) continue; bctx.beginPath(); bctx.arc(x[nd], y[nd], Math.max(1.6, 2.6 / k), 0, TAU); bctx.stroke(); }
        }
      };
      rings(morph.g0, 0.9 * (1 - e));
      rings(g, 0.9 * e);
      bctx.globalAlpha = 1;
      // territory labels: the old set dissolves in the first stretch, the new one arrives at the end
      bctx.setTransform(px, 0, 0, px, 0, 0);
      const a0 = morph.centers0 ? Math.max(0, 1 - t / 0.3) : 0;
      if (a0 > 0.01) paintCenterLabels(bctx, morph.g0, morph.centers0, W, H, a0, []);
      const a1 = Math.min(1, Math.max(0, (t - 0.7) / 0.3));
      if (a1 > 0.01) paintCenterLabels(bctx, g, L.centers, W, H, a1, []);
    }
    /* snapshot crossfade for wikis too big to morph: the old frame becomes a
     * canvas laid over the new render, and a CSS opacity transition blends it
     * away — zero per-frame JS */
    const fadeEls = new Set();
    function crossfadeOldBase() {
      const dur = opts.xfadeMs ?? 260;
      const snap = document.createElement("canvas");
      snap.width = base.width; snap.height = base.height;
      snap.getContext("2d").drawImage(base, 0, 0);
      snap.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;opacity:1;transition:opacity " + dur + "ms ease;";
      container.insertBefore(snap, live);
      fadeEls.add(snap);
      const kill = () => { snap.remove(); fadeEls.delete(snap); };
      snap.addEventListener("transitionend", kill, { once: true });
      setTimeout(kill, dur + 500);
      requestAnimationFrame(() => requestAnimationFrame(() => { snap.style.opacity = "0"; }));
    }
    /* territory labels — shared by the cached base render and the morph */
    function labelFits(boundW, boundH, placed) {
      return (r) => !(r.x < 0 || r.x + r.w > boundW || r.y < 0 || r.y + r.h > boundH) && !placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
    }
    function paintCenterLabels(ctx, gr, centers, boundW, boundH, alpha, placed) {
      const fits = labelFits(boundW, boundH, placed);
      ctx.globalAlpha = alpha; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = "600 10.5px 'Space Mono', monospace";
      let shown = 0;
      for (let ci = 0; ci < centers.length && shown < opts.maxLabels; ci++) {
        const c = centers[ci];
        const rs = c.r * view.k;
        if (ci >= opts.labels && rs < 16) continue;
        if (c.loop < 0 && (ci > 6 || rs < 22)) continue;
        const [sx, sy] = toScreen(c.x, c.y);
        if (sx < -rs || sx > boundW + rs || sy < -rs || sy > boundH + rs) continue;
        const label = c.loop >= 0 ? gr.loops[c.loop].nodes.map((n) => gr.titles[n]).join(" → ") : gr.titles[c.root] + " ✝";
        const text = label.length > 44 ? label.slice(0, 43) + "…" : label;
        const tw = ctx.measureText(text).width;
        let ly = null;
        for (const cand of [sy - rs - 9, sy + rs + 9, sy]) { const r = { x: sx - tw / 2 - 3, y: cand - 8, w: tw + 6, h: 16 }; if (fits(r)) { placed.push(r); ly = cand; break; } }
        if (ly === null) continue;
        ctx.lineWidth = 4; ctx.strokeStyle = "rgba(248,244,234,0.9)"; ctx.strokeText(text, sx, ly);
        ctx.fillStyle = c.loop >= 0 ? (c.loop < WALK_COLORS.loops.length ? WALK_COLORS.loops[c.loop] : WALK_COLORS.other) : WALK_COLORS.dead;
        ctx.fillText(text, sx, ly);
        shown++;
      }
      ctx.globalAlpha = 1;
    }

    function frame(now) {
      const animating = stepAnim(now);
      const morphing = stepMorph(now); // draws the base layer itself while a rank morph runs
      const interacting = baseStale && now - lastInteract < SETTLE_MS;
      if (morphing) { /* the morph owns the base layer this frame */ }
      else if (animating) drawBaseFromCache();
      else if (interacting) {
        // mid pan/zoom: replay the cache while it still covers the viewport;
        // once the drag starts eating into its runway, re-render at the current
        // view — throttled to REBASE_MS, so a long drag costs a few heavier
        // frames per second instead of one per frame
        if (now - lastBaseDraw >= REBASE_MS && !cacheCoversView()) { drawBase(); baseStale = false; }
        else drawBaseFromCache();
      }
      else if (baseDirty || baseStale) { drawBase(); baseStale = false; }
      const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016); lastT = now;
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // trails are screen-space residue: they only make sense while the view holds still.
      // any pan/zoom since the last frame wipes them instead of fading them in place.
      const moved = morphing || !lastView || lastView.k !== view.k || lastView.tx !== view.tx || lastView.ty !== view.ty;
      lastView = { k: view.k, tx: view.tx, ty: view.ty };
      if (running && !animating && !moved) {
        lctx.globalCompositeOperation = "destination-out";
        lctx.fillStyle = "rgba(0,0,0,0.16)"; lctx.fillRect(0, 0, W, H);
      } else lctx.clearRect(0, 0, W, H);
      lctx.globalCompositeOperation = "source-over";
      if (!g) return;
      lctx.translate(view.tx, view.ty); lctx.scale(view.k, view.k);
      if (running && !animating) {
        const sp = opts.speed / Math.sqrt(view.k);
        lctx.lineCap = "round";
        const batches = new Map(); // one stroke per colour × alpha level, instead of one per walker
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
          const lvl = Math.min(3, (w.alpha * 4) | 0);
          const key = w.col + lvl;
          let p = batches.get(key); if (!p) { p = { col: w.col, a: (lvl + 1) / 4, path: new Path2D() }; batches.set(key, p); }
          p.path.moveTo(w.px, w.py); p.path.lineTo(nx, ny);
          w.px = nx; w.py = ny;
        }
        lctx.lineWidth = 1.4 / Math.sqrt(view.k);
        for (const p of batches.values()) { lctx.strokeStyle = p.col; lctx.globalAlpha = 0.85 * p.a; lctx.stroke(p.path); }
      }
      if (hoverChain) {
        const ch = hoverChain.chain;
        lctx.globalAlpha = 0.95; lctx.lineWidth = 1.8 / Math.sqrt(view.k); lctx.strokeStyle = WALK_COLORS.ink;
        lctx.beginPath(); lctx.moveTo(L.x[ch[0]], L.y[ch[0]]);
        for (let i = 1; i < ch.length; i++) lctx.lineTo(L.x[ch[i]], L.y[ch[i]]);
        if (hoverChain.fate === "cycle") lctx.lineTo(L.x[ch[ch.length - hoverChain.cycleSize]], L.y[ch[ch.length - hoverChain.cycleSize]]);
        lctx.stroke();
        lctx.fillStyle = WALK_COLORS.ink;
        for (const n of ch) { lctx.beginPath(); lctx.arc(L.x[n], L.y[n], 2.2 / Math.sqrt(view.k), 0, TAU); lctx.fill(); }
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lctx.font = "10px 'Space Mono', monospace"; lctx.textAlign = "left"; lctx.textBaseline = "bottom";
        const picks = new Set([0, ch.length - 1]);
        if (hoverChain.fate === "cycle") for (let i = ch.length - hoverChain.cycleSize; i < ch.length; i++) picks.add(i);
        if (ch.length > 4) picks.add(Math.floor(ch.length / 2));
        if (view.k >= 3) for (let i = 0; i < ch.length; i++) picks.add(i);
        const placed = [];
        for (const i of [...picks].sort((a, b) => a - b)) {
          const [sx, sy] = toScreen(L.x[ch[i]], L.y[ch[i]]);
          if (sx < -200 || sx > W + 50 || sy < -30 || sy > H + 30) continue;
          const t = g.titles[ch[i]]; const text = (i === 0 ? "▶ " : "") + (t.length > 34 ? t.slice(0, 33) + "…" : t);
          const wpx = lctx.measureText(text).width;
          let ly = sy - 5;
          for (const r of placed) if (Math.abs(r.y - ly) < 13 && sx < r.x + r.w + 6 && sx + wpx > r.x - 6) ly = r.y - 13;
          placed.push({ x: sx, y: ly, w: wpx });
          lctx.lineWidth = 3.5; lctx.strokeStyle = "rgba(248,244,234,0.92)"; lctx.strokeText(text, sx + 5, ly);
          lctx.fillStyle = i === 0 ? WALK_COLORS.ink : (hoverChain.fate === "cycle" && i >= ch.length - hoverChain.cycleSize ? colorOf(ch[i]) : "#5f574a");
          lctx.fillText(text, sx + 5, ly);
        }
      }
      lctx.globalAlpha = 1;
      if (animating || baseStale || morphing) kickOnce();
    }
    let raf = 0;
    function tick(now) {
      raf = 0;
      if (!visible || document.hidden) return;
      frame(now);
      if ((running || morph) && !raf) raf = requestAnimationFrame(tick);
    }
    function kick() { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick); }
    function kickOnce() { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick); }

    // ---- interaction: hover, click, drag-pan, wheel-zoom, pinch, double-click ----
    const pointers = new Map();
    let drag = null, downAt = null, pinch = null, lastTap = 0, tapFresh = false;
    function updateHover() {
      if (!g || morph) return; // nearest-node lookup is stale until the morph rebuilds the grid
      const [wx, wy] = toWorld(mouse.x, mouse.y);
      const hit = nearest(wx, wy, 9 / view.k);
      if (hit !== hover) {
        hover = hit; hoverChain = hit >= 0 ? g.walk(hit) : null;
        container.style.cursor = hit >= 0 ? "pointer" : (opts.explore ? "grab" : "");
        if (opts.onHover) opts.onHover(hit, hoverChain);
        kickOnce();
      }
    }
    container.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      container.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k, tx: view.tx, ty: view.ty, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        drag = null; return;
      }
      downAt = { x: e.clientX, y: e.clientY };
      const r = container.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
      if (e.pointerType === "touch") { const before = hover; updateHover(); tapFresh = hover >= 0 && hover !== before; } else tapFresh = false;
      if (opts.explore && hover < 0) { drag = { x: mouse.x, y: mouse.y, tx: view.tx, ty: view.ty }; container.style.cursor = "grabbing"; anim = null; }
    });
    container.addEventListener("pointermove", (e) => {
      const r = container.getBoundingClientRect();
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
        const k2 = Math.min(MAX_K, Math.max(MIN_K, pinch.k * (d / Math.max(1, pinch.d))));
        const sx = pinch.mx - r.left, sy = pinch.my - r.top;
        view.k = k2; view.tx = sx - (sx - pinch.tx) * (k2 / pinch.k) + (mx - sx); view.ty = sy - (sy - pinch.ty) * (k2 / pinch.k) + (my - sy);
        clampView(view); touch(); return;
      }
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
      if (drag) {
        view.tx = drag.tx + (mouse.x - drag.x); view.ty = drag.ty + (mouse.y - drag.y);
        clampView(view); touch(); return;
      }
      if (e.pointerType !== "touch") updateHover();
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      const moved = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
      const wasDrag = !!drag;
      drag = null; downAt = null; container.style.cursor = hover >= 0 ? "pointer" : (opts.explore ? "grab" : "");
      if (e.type !== "pointerup" || moved || pinch) return;
      const now = performance.now();
      if (now - lastTap < 320 && hover < 0) { lastTap = 0; zoomAt(1.9, mouse.x, mouse.y); return; } // double-tap/double-click: zoom in
      lastTap = now;
      if (hover >= 0 && !wasDrag && !tapFresh) { // on touch, the first tap traces the walk and the second opens it
        if (opts.onClick) opts.onClick(hover, hoverChain);
        else if (opts.urlFor) window.open(opts.urlFor(g.titles[hover]), "_blank", "noopener");
      }
    };
    container.addEventListener("pointerup", endPointer);
    container.addEventListener("pointercancel", endPointer);
    container.addEventListener("pointerleave", () => { if (!drag && !pinch) { mouse.x = -1e9; mouse.y = -1e9; hover = -1; hoverChain = null; container.style.cursor = ""; if (opts.onHover) opts.onHover(-1, null); kickOnce(); } });
    container.addEventListener("wheel", (e) => {
      if (!opts.explore) return;
      if (opts.wheel === "modifier" && !(e.ctrlKey || e.metaKey) && !document.fullscreenElement) return; // let the page scroll
      e.preventDefault();
      const r = container.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)); // trackpad pinch arrives as ctrl+wheel
      zoomAt(f, e.clientX - r.left, e.clientY - r.top, false);
    }, { passive: false });
    container.addEventListener("dblclick", (e) => { e.preventDefault(); });

    new IntersectionObserver((en) => { visible = en[0].isIntersecting; if (visible) kick(); }, { threshold: 0.02 }).observe(container);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
    const ro = new ResizeObserver(() => { resize(); kick(); });
    ro.observe(container);
    resize();
    kick();

    return {
      setGraph,
      pause() { running = false; },
      setTouchAction(v) { container.style.touchAction = v; },
      resume() { running = !opts.reduced; kick(); },
      focus(i) { hover = i; hoverChain = i >= 0 ? g.walk(i) : null; if (opts.onHover) opts.onHover(hover, hoverChain); kickOnce(); },
      zoomBy(f) { zoomAt(f, W / 2, H / 2); },
      zoomToNode(i, k) {
        if (!g || i < 0) return;
        const kk = Math.min(MAX_K, Math.max(MIN_K, k ?? 6));
        anim = { from: { ...view }, to: clampView({ k: kk, tx: W / 2 - L.x[i] * kk, ty: H / 2 - L.y[i] * kk }), t0: performance.now(), dur: 420 };
        kickOnce();
      },
      resetView,
      setWheel(mode) { opts.wheel = mode; },
      view: () => ({ ...view }),
      layout: () => L,
      graph: () => g,
      destroy() { ro.disconnect(); running = false; morph = null; fadeEls.forEach((f) => f.remove()); fadeEls.clear(); base.remove(); live.remove(); },
    };
  }

  window.WALK_COLORS = WALK_COLORS;
  window.buildWalkGraph = buildWalkGraph;
  window.layoutWalkGraph = layoutWalkGraph;
  window.createWalkField = createWalkField;
})();
