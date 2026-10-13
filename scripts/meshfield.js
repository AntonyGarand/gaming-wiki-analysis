/* meshfield.js — an abstract mesh that grows itself. starts empty, walks real
 * articles (random start → /api/chain at the chosen rank), and reveals each hop
 * as it navigates: new nodes materialise where the walk lands, edges draw the
 * link it followed, revisited articles close loops. served by lab-server at
 * /meshfield.js.
 * deps (globals at call time): hueAt(t), api(path), reduced
 * usage: const m = createMeshField(canvas, container, { explore?: true });
 *        m.update(wiki, rank, nodeCount); m.loops(); m.stats();
 */
function createMeshField(canvas, container, opts) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
  const mouse = { x: -9999, y: -9999 };
  let visible = true, running = true, hoverIdx = -1;
  let nodes = [], edges = [], loopsMeta = [];
  let outEdges = new Map(), succEdge = new Map(), cycleSet = new Set(), byTitle = new Map();
  let pulses = [], nodeFlash = new Float32Array(0), edgeHeat = new Float32Array(0), lit = new Float32Array(0);
  let ripples = [], lastRunner = 0;
  let meshKey = "", loading = false;
  // growth state
  let targetN = 150, growing = false, growGen = 0, growers = [];
  let loopsSeen = new Map(), walksDone = 0, fruitless = 0;
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const MAIN_COL = hueAt(0.05), SIB_COL = hueAt(0.9);
  const view = opts.explore ? { x: 0, y: 0, k: 1 } : null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function region() {
    return {
      rx0: W < 900 ? 0.04 * W : 0.32 * W, rx1: 0.97 * W,
      ry0: 0.06 * H, ry1: 0.94 * H,
    };
  }
  function layout() {
    const r = container.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!nodes.length) return;
    const { rx0, rx1, ry0, ry1 } = region();
    for (const n of nodes) { n.px = rx0 + n.ux * (rx1 - rx0); n.py = ry0 + n.uy * (ry1 - ry0); n.rx = n.px; n.ry = n.py; }
    for (const e of edges) {
      e.x0 = nodes[e.s].px; e.y0 = nodes[e.s].py;
      e.x1 = nodes[e.t].px; e.y1 = nodes[e.t].py;
      e.dur = Math.min(1.4, Math.max(0.35, Math.hypot(e.x1 - e.x0, e.y1 - e.y0) / 340));
    }
    if (reduced) drawStatic();
  }

  // ---- incremental layout: relax the current mesh around new arrivals ----
  function forceRelax(iters) {
    const N = nodes.length;
    if (N < 2) return;
    const k = Math.min(W, H) * Math.max(0.05, Math.min(0.16, 1.1 / Math.sqrt(targetN)));
    const k2 = k * k;
    const { rx0, rx1, ry0, ry1 } = region();
    const fx = new Float64Array(N), fy = new Float64Array(N);
    for (let iter = 0; iter < iters; iter++) {
      fx.fill(0); fy.fill(0);
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        let dx = nodes[i].px - nodes[j].px, dy = nodes[i].py - nodes[j].py;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = 1; dy = 1; d2 = 2; }
        const d = Math.sqrt(d2);
        const f = k2 / d2;
        const ux = dx / d, uy = dy / d;
        fx[i] += ux * f; fy[i] += uy * f;
        fx[j] -= ux * f; fy[j] -= uy * f;
      }
      for (const e of edges) {
        const a = nodes[e.s], b = nodes[e.t];
        const dx = b.px - a.px, dy = b.py - a.py;
        const d = Math.hypot(dx, dy) || 1;
        const f = ((d * d) / k) * 0.55;
        const ux = dx / d, uy = dy / d;
        fx[e.s] += ux * f; fy[e.s] += uy * f;
        fx[e.t] -= ux * f; fy[e.t] -= uy * f;
      }
      for (let i = 0; i < N; i++) {
        const cx = (rx0 + rx1) / 2, cy = (ry0 + ry1) / 2;
        fx[i] += (cx - nodes[i].px) * 0.05;
        fy[i] += (cy - nodes[i].py) * 0.05;
        nodes[i].px = Math.max(rx0, Math.min(rx1, nodes[i].px + Math.max(-7, Math.min(7, fx[i]))));
        nodes[i].py = Math.max(ry0, Math.min(ry1, nodes[i].py + Math.max(-7, Math.min(7, fy[i]))));
      }
    }
    // keep unit coords in sync so resizes remap grown nodes too
    for (const n of nodes) {
      n.ux = (n.px - rx0) / (rx1 - rx0 || 1);
      n.uy = (n.py - ry0) / (ry1 - ry0 || 1);
    }
    for (const e of edges) {
      e.x0 = nodes[e.s].px; e.y0 = nodes[e.s].py;
      e.x1 = nodes[e.t].px; e.y1 = nodes[e.t].py;
    }
  }

  // ---- growth engine ----
  function reset() {
    nodes = []; edges = []; loopsMeta = []; growers = [];
    outEdges = new Map(); succEdge = new Map(); cycleSet = new Set(); byTitle = new Map();
    edgeKeys.clear();
    pulses = []; ripples = [];
    nodeFlash = new Float32Array(0); edgeHeat = new Float32Array(0); lit = new Float32Array(0);
    loopsSeen = new Map(); walksDone = 0; fruitless = 0;
    hoverIdx = -1;
    layout();
  }
  async function ensure(wiki, rank, n = 150) {
    const key = `${wiki}|${rank}|${n}`;
    if (meshKey === key && (growing || nodes.length || loading)) return;
    meshKey = key;
    reset();
    targetN = Math.max(20, Math.min(600, n));
    growing = true;
    const gen = ++growGen;
    const concurrent = targetN > 250 ? 3 : 2;
    const interval = Math.max(260, Math.min(700, 90000 / targetN));
    while (growing && growGen === gen && nodes.length < targetN && fruitless < 30) {
      if (growers.length < concurrent) {
        try {
          const r = await api(`/api/random?wiki=${wiki}`);
          if (growGen !== gen || !growing) break;
          const c = await api(`/api/chain?wiki=${wiki}&rank=${rank}&title=${encodeURIComponent(r.title)}`);
          if (growGen !== gen || !growing) break;
          if (c.chain && c.chain.length > 1) growers.push({ titles: c.chain, fate: c.fate, cycleSize: c.cycleSize || 0, idx: 0, wait: 0, added: 0 });
        } catch { await sleep(1500); }
      }
      await sleep(interval);
    }
    if (growGen === gen) growing = false;
  }

  function addNode(title, ax, ay, anchor) {
    const { rx0, rx1, ry0, ry1 } = region();
    const n = {
      title, cyc: false, px: Math.max(rx0, Math.min(rx1, ax)), py: Math.max(ry0, Math.min(ry1, ay)),
      born: performance.now(),
    };
    // rendered position: a new article glides out of the link it arrived on,
    // rather than teleporting to its final resting place
    if (anchor) { n.rx = anchor.rx; n.ry = anchor.ry; }
    else { n.rx = n.px; n.ry = n.py; }
    n.ux = (n.px - rx0) / (rx1 - rx0 || 1);
    n.uy = (n.py - ry0) / (ry1 - ry0 || 1);
    n.ax = n.rx; n.ay = n.ry;
    n.w1 = Math.PI * 2 / (30000 + ((nodes.length * 7919) % 7) * 5000);
    n.w2 = Math.PI * 2 / (34000 + ((nodes.length * 104729) % 5) * 7000);
    n.p1 = ((nodes.length * 2654435761) % 1000) / 1000 * Math.PI * 2;
    n.p2 = ((nodes.length * 40503) % 997) / 997 * Math.PI * 2;
    n.amp = 0.7 + (((nodes.length * 31) % 10) / 10) * 0.6;
    byTitle.set(title, n);
    nodes.push(n);
    // regrow typed arrays
    const nf = new Float32Array(nodes.length); nf.set(nodeFlash); nodeFlash = nf;
    const lt = new Float32Array(nodes.length); lt.set(lit); lit = lt;
    return n;
  }
  function addEdge(a, b, main) {
    const key = a.title + "\u0000" + b.title;
    if (edgeKeys.has(key)) return edgeKeys.get(key);
    const e = { s: nodes.indexOf(a), t: nodes.indexOf(b), main };
    // seed endpoints from RENDERED positions: physics positions would draw the
    // full path one frame early, flashing the destination before the node glides
    e.x0 = a.ax; e.y0 = a.ay; e.x1 = b.ax; e.y1 = b.ay;
    e.dur = Math.min(1.4, Math.max(0.35, Math.hypot(b.px - a.px, b.py - a.py) / 340));
    edges.push(e);
    const i = edges.length - 1;
    edgeKeys.set(key, i);
    if (!outEdges.has(e.s)) outEdges.set(e.s, []);
    outEdges.get(e.s).push(i);
    if (main && !succEdge.has(e.s)) succEdge.set(e.s, i);
    const eh = new Float32Array(edges.length); eh.set(edgeHeat); edgeHeat = eh;
    return i;
  }
  const edgeKeys = new Map();

  function advanceGrowers(dt) {
    for (let g = growers.length - 1; g >= 0; g--) {
      const gr = growers[g];
      if (gr.wait > 0) { gr.wait -= dt; continue; }
      const title = gr.titles[gr.idx];
      let node = byTitle.get(title);
      const byTitleHad = !!node;
      const prev = gr.idx > 0 ? byTitle.get(gr.titles[gr.idx - 1]) : null;
      if (!node) {
        // materialise where the walk lands: near the previous article, or —
        // for a walk's first article — near a random mesh node so new walks
        // grow out of the mesh instead of flashing in at random spots
        let ax, ay, anchorNode = prev;
        if (prev) {
          const a = Math.random() * Math.PI * 2;
          const dist = Math.min(W, H) * Math.max(0.05, Math.min(0.12, 1.1 / Math.sqrt(targetN))) * (0.7 + Math.random() * 0.7);
          ax = prev.px + Math.cos(a) * dist; ay = prev.py + Math.sin(a) * dist;
        } else if (nodes.length) {
          const seed = nodes[(Math.random() * nodes.length) | 0];
          const a = Math.random() * Math.PI * 2;
          const dist = Math.min(W, H) * Math.max(0.05, Math.min(0.12, 1.1 / Math.sqrt(targetN))) * (0.8 + Math.random() * 0.6);
          ax = seed.px + Math.cos(a) * dist; ay = seed.py + Math.sin(a) * dist;
          anchorNode = seed;
        } else {
          const { rx0, rx1, ry0, ry1 } = region();
          ax = rx0 + Math.random() * (rx1 - rx0); ay = ry0 + Math.random() * (ry1 - ry0);
        }
        node = addNode(title, ax, ay, anchorNode);
        gr.added++;
        forceRelax(3);
      }
      if (prev) {
        const ei = addEdge(prev, node, true);
        edgeHeat[ei] = 1;
        // the hop pulse travels fixed source→destination coordinates, so it's
        // visible even while the edge itself is still stretching out
        if (pulses.length < 40) {
          const hop = { at: nodes.indexOf(prev), e: ei, t: 0, alpha: 1, cycleHops: 0, hops: 0, dying: 0, boost: 1, hop: 1 };
          hop.path = [prev.ax, prev.ay, node.px, node.py];
          pulses.push(hop);
          if (!byTitleHad) node.holdUntil = performance.now() + Math.min(1.4, Math.max(0.35, Math.hypot(hop.path[2] - hop.path[0], hop.path[3] - hop.path[1]) / 340)) * 1000;
        }
      }
      const ni = nodes.indexOf(node);
      if (byTitleHad) nodeFlash[ni] = 1; // revisits flash in place; new nodes flash when the hop lands
      gr.idx++;
      if (gr.idx >= gr.titles.length) {
        finishGrower(gr);
        growers.splice(g, 1);
        continue;
      }
      gr.wait = 0.55;
    }
  }
  function finishGrower(gr) {
    walksDone++;
    if (gr.added === 0) fruitless++; else fruitless = 0;
    if (gr.fate === "cycle" && gr.cycleSize > 0) {
      const tail = gr.titles.slice(-gr.cycleSize);
      tail.forEach((t) => {
        const n = byTitle.get(t);
        if (n && !n.cyc) { n.cyc = true; cycleSet.add(nodes.indexOf(n)); }
      });
      const key = tail.join("|");
      loopsSeen.set(key, (loopsSeen.get(key) ?? 0) + 1);
      loopsMeta = [...loopsSeen.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k2, count]) => ({ cycle: k2.split("|"), pct: +(100 * count / Math.max(1, walksDone)).toFixed(1) }));
    }
    if (reduced) drawStatic();
  }

  // apply the drift: rendered positions ease toward their physics targets, then
  // meander; edge endpoints follow. this is what makes new arrivals glide.
  function driftFrame(dt, now) {
    const ease = 1 - Math.exp(-dt * 3.2);
    const a0 = Math.min(W, H) * 0.014;
    for (const n of nodes) {
      if (!(n.holdUntil && now < n.holdUntil)) { // held nodes wait at their anchor for the hop pulse
        n.rx += (n.px - n.rx) * ease;
        n.ry += (n.py - n.ry) * ease;
      }
      n.ax = n.rx + Math.sin(now * n.w1 + n.p1) * a0 * n.amp;
      n.ay = n.ry + Math.cos(now * n.w2 + n.p2) * a0 * n.amp;
    }
    for (const e of edges) {
      e.x0 = nodes[e.s].ax; e.y0 = nodes[e.s].ay;
      e.x1 = nodes[e.t].ax; e.y1 = nodes[e.t].ay;
    }
  }

  function spawnPulse() {
    const starts = [...outEdges.keys()];
    if (!starts.length) return;
    const at = starts[(Math.random() * starts.length) | 0];
    const main = succEdge.get(at);
    const e = main !== undefined ? main : outEdges.get(at)[0];
    pulses.push({ at, e, t: 0, alpha: 0, cycleHops: 0, hops: 0, dying: 0 });
  }
  // loop runners — pulses that only ever follow first links around a cycle,
  // tracing the attractor loops as closed, continuously-travelled polygons
  function spawnRunner() {
    const cyc = [...cycleSet].filter((i) => succEdge.has(i));
    if (!cyc.length) return;
    const at = cyc[(Math.random() * cyc.length) | 0];
    pulses.push({ at, e: succEdge.get(at), t: 0, alpha: 1, cycleHops: 0, hops: 0, dying: 0, runner: 1, boost: 1 });
  }
  function pickNext(at, runner) {
    const outs = outEdges.get(at);
    if (!outs || !outs.length) return -1;
    const main = succEdge.get(at);
    // loops are sticky: on a cycle (or as a runner) always take the first link;
    // elsewhere, mostly follow first links…
    if (main !== undefined && (runner || cycleSet.has(at) || Math.random() < 0.6)) return main;
    return outs[(Math.random() * outs.length) | 0]; // …but sometimes wander to a sibling
  }
  function edgePoint(e, t) {
    return [e.x0 + (e.x1 - e.x0) * t, e.y0 + (e.y1 - e.y0) * t];
  }
  function drawStatic() {
    if (!nodes.length) return;
    ctx.globalCompositeOperation = "multiply";
    for (const e of edges) {
      ctx.strokeStyle = "#201b14"; ctx.globalAlpha = e.main ? 0.16 : 0.07; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(e.x0, e.y0); ctx.lineTo(e.x1, e.y1); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      ctx.fillStyle = "#201b14"; ctx.globalAlpha = n.cyc ? 0.5 : 0.3;
      ctx.fillRect(n.ax - 0.8, n.ay - 0.8, 1.6, 1.6);
    }
    ctx.font = "10px 'Space Mono', monospace"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    let k = 0;
    nodes.forEach((n) => {
      if (!n.cyc || k >= 6) return;
      k++;
      ctx.globalAlpha = 0.75;
      const label = trunc(n.title, 18);
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(248,244,234,0.85)";
      ctx.strokeText(label, n.ax, n.ay - 7);
      ctx.fillStyle = "#201b14"; ctx.fillText(label, n.ax, n.ay - 7);
    });
    ctx.globalAlpha = 1;
  }

  layout();
  window.addEventListener("resize", () => { layout(); });
  container.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
    if (view) { mouse.x = (mouse.x - view.x) / view.k; mouse.y = (mouse.y - view.y) / view.k; }
    hoverIdx = -1; let best = view ? 900 / view.k : 900;
    for (let i = 0; i < nodes.length; i++) {
      const d = (nodes[i].ax - mouse.x) ** 2 + (nodes[i].ay - mouse.y) ** 2;
      if (d < best) { best = d; hoverIdx = i; }
    }
    container.style.cursor = hoverIdx >= 0 ? "pointer" : opts.explore ? "grab" : "";
  });
  container.addEventListener("pointerleave", () => { mouse.x = -9999; mouse.y = -9999; hoverIdx = -1; container.style.cursor = ""; });
  // click a node: it flashes, and one pulse fires along this page's first link
  container.addEventListener("pointerdown", (e) => {
    if (!nodes.length) return;
    const r0 = canvas.getBoundingClientRect();
    let mx = e.clientX - r0.left, my = e.clientY - r0.top;
    if (view) { mx = (mx - view.x) / view.k; my = (my - view.y) / view.k; }
    let hit = -1, best = view ? 196 / view.k : 196;
    for (let i = 0; i < nodes.length; i++) {
      const d = (nodes[i].ax - mx) ** 2 + (nodes[i].ay - my) ** 2;
      if (d < best) { best = d; hit = i; }
    }
    if (hit < 0) return;
    e.preventDefault();
    nodeFlash[hit] = 1.6;
    const main = succEdge.get(hit);
    if (main !== undefined) pulses.push({ at: hit, e: main, t: 0, alpha: 1, cycleHops: 0, hops: 0, dying: 0, boost: 1 });
  });
  if (view) {
    // explore mode: drag empty space to pan, wheel to zoom toward the cursor
    let dragging = null;
    container.addEventListener("pointerdown", (e) => {
      if (nodes.length) {
        const r0 = canvas.getBoundingClientRect();
        let mx = e.clientX - r0.left, my = e.clientY - r0.top;
        if (view) { mx = (mx - view.x) / view.k; my = (my - view.y) / view.k; }
        let hit = -1, best = 196 / view.k;
        for (let i = 0; i < nodes.length; i++) {
          const d = (nodes[i].ax - mx) ** 2 + (nodes[i].ay - my) ** 2;
          if (d < best) { best = d; hit = i; }
        }
        if (hit >= 0) return; // clicks are handled above; only pan on empty space
      }
      const r = canvas.getBoundingClientRect();
      dragging = { x: e.clientX - r.left, y: e.clientY - r.top, vx: view.x, vy: view.y };
      container.setPointerCapture(e.pointerId);
      container.style.cursor = "grabbing";
    });
    container.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      view.x = dragging.vx + (e.clientX - r.left - dragging.x);
      view.y = dragging.vy + (e.clientY - r.top - dragging.y);
    });
    container.addEventListener("pointerup", () => { dragging = null; container.style.cursor = "grab"; });
    container.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k2 = Math.min(6, Math.max(0.4, view.k * Math.exp(-e.deltaY * 0.0012)));
      view.x = mx - (mx - view.x) * (k2 / view.k);
      view.y = my - (my - view.y) * (k2 / view.k);
      view.k = k2;
    }, { passive: false });
  }
  new IntersectionObserver((en) => { visible = en[0].isIntersecting; }, { threshold: 0.02 }).observe(container);
  document.addEventListener("visibilitychange", () => { running = !document.hidden; if (running) requestAnimationFrame(tick); });
  // if anything ever kills the animation loop, restart it within a second and a half
  setInterval(() => {
    if (running && visible && performance.now() - lastTickAt > 1500) requestAnimationFrame(tick);
  }, 1500);
  canvas.addEventListener("contextlost", (e) => e.preventDefault());
  canvas.addEventListener("contextrestored", () => { layout(); });

  let lastTickAt = 0, tickErr = null;
  function tick() {
    if (!running) return;
    requestAnimationFrame(tick);
    if (!visible) return;
    const now = performance.now();
    lastTickAt = now;
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    try {
      tickInner(dt, now);
    } catch (err) {
      // never let one bad frame kill the field — restore canvas state and carry on
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // also resets any pan/zoom transform
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      if (!tickErr) { tickErr = err; console.error("meshfield:", err); }
    }
  }
  function tickInner(dt, now) {
    if (nodes.length) driftFrame(dt, now);
    if (growers.length) advanceGrowers(dt);

    if (edges.length && pulses.length < 20 && now - lastSpawn > 240 + Math.random() * 300) {
      spawnPulse(); lastSpawn = now;
    }
    if (edges.length && now - lastRunner > 2600 && pulses.filter((p) => p.runner).length < 6) {
      spawnRunner(); lastRunner = now;
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      if (p.dying) {
        p.alpha -= dt * 1.6; // no revival: the ramp below only applies to the living
        if (p.alpha <= 0) pulses.splice(i, 1);
        continue;
      }
      p.alpha = Math.min(1, p.alpha + dt * 3);
      const e = edges[p.e];
      if (!e) { pulses.splice(i, 1); continue; } // stale edge — drop it, never throw
      p.t += dt / e.dur;
      if (p.t >= 1) {
        nodeFlash[e.t] = 1; edgeHeat[p.e] = 1;
        p.hops++;
        if (e.main && cycleSet.has(e.t)) p.cycleHops++;
        if (p.hop) { p.dying = 1; p.at = e.t; continue; } // growth hops are one-shot: land, flash, fade
        const next = pickNext(e.t, p.runner);
        if (next < 0 || p.cycleHops > (p.runner ? 6 : 4) || (!p.runner && p.hops > 10)) { p.dying = 1; p.at = e.t; continue; }
        p.at = e.t; p.e = next; p.t = 0;
      }
    }
    for (let i = 0; i < nodeFlash.length; i++) if (nodeFlash[i] > 0) nodeFlash[i] = Math.max(0, nodeFlash[i] - dt * 0.45);
    for (let i = 0; i < edgeHeat.length; i++) if (edgeHeat[i] > 0) edgeHeat[i] = Math.max(0, edgeHeat[i] - dt * 0.9);
    for (let i = 0; i < lit.length; i++) if (lit[i] > 0) lit[i] = Math.max(0, lit[i] - dt);
    for (let i = ripples.length - 1; i >= 0; i--) {
      ripples[i].t += dt;
      if (ripples[i].t > 0.9) ripples.splice(i, 1);
    }

    ctx.globalCompositeOperation = "source-over";
    // trail fade. NB: the mesh's ink richness is an equilibrium between
    // per-frame multiply accumulation and this partial fade — a full-strength
    // wash resets the equilibrium and makes the whole mesh visibly flash,
    // so residue must be handled at the draw-call level, not here.
    ctx.fillStyle = "rgba(248,244,234,0.30)";
    ctx.fillRect(0, 0, W, H);
    if (view) { ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.k, view.k); }
    ctx.globalCompositeOperation = "multiply";
    // edges — straight ink at rest; traffic warms them rust (first links) or
    // plum (siblings), and they always cool back to blank
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i], heat = edgeHeat[i];
      ctx.strokeStyle = "#201b14";
      ctx.globalAlpha = (e.main ? 0.15 : 0.045) + heat * 0.35;
      ctx.lineWidth = e.main ? 1.2 : 1;
      ctx.beginPath(); ctx.moveTo(e.x0, e.y0); ctx.lineTo(e.x1, e.y1); ctx.stroke();
      if (heat > 0.02) {
        ctx.strokeStyle = e.main ? MAIN_COL : SIB_COL;
        ctx.globalAlpha = heat * 0.5;
        ctx.beginPath(); ctx.moveTo(e.x0, e.y0); ctx.lineTo(e.x1, e.y1); ctx.stroke();
      }
    }
    // nodes — uniform specks; the pattern lives in the movement, not the dots.
    // newborns fade in.
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], f = nodeFlash[i], l2 = Math.min(1, lit[i]);
      const born = Math.min(1, (now - n.born) / 700);
      ctx.fillStyle = "#201b14";
      ctx.globalAlpha = Math.max(0, Math.min(1, ((n.cyc ? 0.42 : 0.28) + f * 0.6 + l2 * 0.25) * born));
      const sz = 1.6 + f * 1.2 + l2 * 1.1 + (i === hoverIdx ? 0.8 : 0);
      ctx.fillRect(n.ax - sz / 2, n.ay - sz / 2, sz, sz);
      if (l2 > 0.03) { // a clicked node breathes a small halo while it stays lit
        const hr = 5 + Math.sin(now / 90) * 1.5 + l2 * 2;
        ctx.strokeStyle = "#201b14"; ctx.globalAlpha = l2 * 0.5; ctx.lineWidth = 1;
        ctx.strokeRect(n.ax - hr, n.ay - hr, hr * 2, hr * 2);
      }
    }
    // pulses — heads and straight trails (boosted ones are growth hops and loop runners)
    for (const p of pulses) {
      const e = edges[p.e];
      if (!e) continue;
      const col = e.main ? MAIN_COL : SIB_COL;
      const boost = p.boost ? 1.6 : 1;
      ctx.strokeStyle = col; ctx.lineWidth = 1.2 * boost;
      const t0 = Math.max(0, p.t - (p.boost ? 0.5 : 0.32));
      ctx.globalAlpha = Math.max(0, Math.min(1, (p.boost ? 0.8 : 0.5) * p.alpha));
      let ax, ay, hx, hy;
      if (p.path) { // growth hop: fixed source→destination, immune to edge stretching
        ax = p.path[0] + (p.path[2] - p.path[0]) * t0; ay = p.path[1] + (p.path[3] - p.path[1]) * t0;
        hx = p.path[0] + (p.path[2] - p.path[0]) * p.t; hy = p.path[1] + (p.path[3] - p.path[1]) * p.t;
      } else {
        [ax, ay] = edgePoint(e, t0); [hx, hy] = edgePoint(e, p.t);
      }
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = col; ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));
      ctx.beginPath(); ctx.arc(hx, hy, 1.8 * boost, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = "multiply";
    }
    // names — only where traffic passes through (or under the cursor).
    // collision-aware: brightest label wins, overlapping neighbours are
    // suppressed instead of stacking into illegible garbage
    ctx.globalCompositeOperation = "source-over";
    ctx.font = "10px 'Space Mono', monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    for (const rp of ripples) {
      if (rp.t < 0) continue;
      const rr = 6 + rp.t * 120;
      ctx.globalAlpha = Math.max(0, 1 - rp.t / 0.9) * 0.45;
      ctx.strokeStyle = "#201b14"; ctx.lineWidth = 1;
      ctx.strokeRect(rp.x - rr, rp.y - rr, rr * 2, rr * 2);
    }
    const candidates = [];
    for (let i = 0; i < nodes.length; i++) {
      const a = Math.max(nodeFlash[i], i === hoverIdx ? 0.9 : 0, Math.min(1, lit[i]));
      if (a < 0.04) continue;
      const n = nodes[i];
      candidates.push({ a, n, label: (!outEdges.has(i) ? trunc(n.title, 18) + " ✝" : trunc(n.title, 18)) });
    }
    candidates.sort((x, y) => y.a - x.a); // brightest first: hover/fresh landings keep their names
    const placed = [];
    for (const c of candidates) {
      const w = ctx.measureText(c.label).width;
      const x = c.n.ax, y = c.n.ay - 7;
      const rect = { x: x - w / 2 - 2, y: y - 10, w: w + 4, h: 13 };
      let clash = false;
      for (const r of placed) {
        if (rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y) { clash = true; break; }
      }
      if (clash) continue; // a brighter neighbour already owns this spot
      placed.push(rect);
      ctx.globalAlpha = c.a;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(248,244,234,0.85)";
      ctx.strokeText(c.label, x, y);
      ctx.fillStyle = "#201b14";
      ctx.fillText(c.label, x, y);
    }
    if (view) ctx.restore();
    ctx.globalAlpha = 1;
  }

  let lastT = 0, lastSpawn = 0;
  if (reduced) {
    drawStatic();
  } else {
    requestAnimationFrame(tick);
  }
  return {
    update: ensure,
    loops: () => loopsMeta,
    stats: () => ({ nodes: nodes.length, target: targetN, growing }),
  };
}
