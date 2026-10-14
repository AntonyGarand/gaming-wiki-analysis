/**
 * lib/walk.ts — the one true implementation of the first-link walk.
 *
 * Everything that needs to know "which link does this page lead to?" loads the
 * corpus and successor table from here: analyze.ts, lab-server.ts (graph, mesh
 * and chain endpoints). The walk rules live in successorsFor(); the README's
 * "The rules (same as Wikipedia)" section is the spec for those rules.
 *
 * Node ids are indices into the corpus (0..N-1), ordered by page id.
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const WIKIS = JSON.parse(fs.readFileSync(path.join(ROOT, "wikis.json"), "utf8")).wikis;

/** terminal codes stored in term[] */
export const TERM = { OK: 0, NO_LINKS: 1, TOO_FEW: 2, UNRESOLVED: 3 } as const;
/** attractor[i] value for pages whose walk dies instead of looping */
export const DEAD = -2;

export interface CorpusLink {
  rank: number;      // 1-based order of appearance in the article body
  target: number;    // corpus node index, or -1 when the link does not resolve
  paren: boolean;    // inside parentheses
  italic: boolean;   // italicised
}

export interface Corpus {
  ids: number[];                       // page ids, ORDER BY id (index = node id)
  titles: string[];                    // titles[i] belongs to ids[i]
  idToIdx: Map<number, number>;
  linksByPage: Map<number, CorpusLink[]>; // keyed by page id
  skipTargets: Set<number>;            // node indices links may not land on
}

// ---------------------------------------------------------------------------
// corpus loading (cached per process — the dump files are immutable while
// the server runs)
// ---------------------------------------------------------------------------
const corpusCache = new Map<string, Promise<Corpus>>();

export function loadCorpus(wikiId: string): Promise<Corpus> {
  const hit = corpusCache.get(wikiId);
  if (hit) return hit;
  const p = buildCorpus(wikiId).catch((e) => { corpusCache.delete(wikiId); throw e; });
  corpusCache.set(wikiId, p);
  return p;
}

// date pages ("28 April", "April 28", "17 March 2019") are update-history
// indexes, not explanations — links that land on them are skipped
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_TITLE_RE = new RegExp(
  `^((0?[1-9]|[12]\\d|3[01]) (${MONTHS})|(${MONTHS}) (0?[1-9]|[12]\\d|3[01]))(,? \\d{4})?$`, "i"
);
const YEAR_RE = /^(1[0-9]{3}|20[0-9]{2})$/; // bare years are update timelines

async function buildCorpus(wikiId: string): Promise<Corpus> {
  const wikiDir = path.join(ROOT, "output", wikiId);
  const db = createClient({ url: `file:${path.join(wikiDir, "links.sqlite")}` });
  try {
    const pagesRes = await db.execute("SELECT id, title FROM page ORDER BY id");
    const ids = pagesRes.rows.map((r) => Number(r.id));
    const titles = pagesRes.rows.map((r) => String(r.title));
    const idToIdx = new Map<number, number>(ids.map((id, i) => [id, i]));
    const N = ids.length;

    const linksByPage = new Map<number, CorpusLink[]>();
    {
      // keyset pagination over (page_id, rank): a plain `page_id > last` LIMIT
      // batch silently drops the trailing links of any page straddling the
      // batch boundary
      let lastPid = -1, lastRank = -1;
      for (;;) {
        const res = await db.execute({
          sql: "SELECT page_id, rank, target_id, paren, italic FROM link WHERE (page_id > ? OR (page_id = ? AND rank > ?)) ORDER BY page_id, rank LIMIT 20000",
          args: [lastPid, lastPid, lastRank],
        });
        if (res.rows.length === 0) break;
        for (const r of res.rows) {
          const pid = Number(r.page_id);
          lastPid = pid; lastRank = Number(r.rank);
          let arr = linksByPage.get(pid);
          if (!arr) { arr = []; linksByPage.set(pid, arr); }
          const target = r.target_id === null ? -1 : (idToIdx.get(Number(r.target_id)) ?? -1);
          arr.push({ rank: lastRank, target, paren: Number(r.paren) === 1, italic: Number(r.italic) === 1 });
        }
        if (res.rows.length < 20000) break;
      }
    }

    // links may not land on disambiguation or date pages (README rule 1)
    const skipTargets = new Set<number>();
    const wikiDbPath = path.join(wikiDir, "wiki.sqlite");
    if (fs.existsSync(wikiDbPath)) {
      const wdb = createClient({ url: `file:${wikiDbPath}` });
      try {
        const r = await wdb.execute(
          "SELECT id FROM page WHERE namespace = 0 AND ((instr(lower(substr(text,1,400)), 'may refer to:') > 0 OR instr(lower(substr(text,1,400)), '{{disambig') > 0) OR title LIKE '% (disambiguation)')"
        );
        for (const row of r.rows) {
          const idx = idToIdx.get(Number(row.id));
          if (idx !== undefined) skipTargets.add(idx);
        }
      } finally { wdb.close(); }
    }
    for (let i = 0; i < N; i++) {
      if (DATE_TITLE_RE.test(titles[i]) || YEAR_RE.test(titles[i])) skipTargets.add(i);
    }

    return { ids, titles, idToIdx, linksByPage, skipTargets };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// successor selection — the walk rules
// ---------------------------------------------------------------------------

/** deterministic per-page RNG (xorshift), so the random rank is reproducible */
export function rngFor(pageId: number, seed = 0): number {
  let x = (pageId ^ 0x9e3779b9 ^ seed) >>> 0;
  x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
  return x / 4294967296;
}

/**
 * Build the successor table for one rank.
 *
 * Every rank is strict: links inside parentheses or italics never count, and
 * links landing on skipped pages (disambiguation, dates) never count.
 *
 * term[i]: 0 = walk continues, 1 = no eligible links, 2 = fewer than N
 * eligible links, 3 = the chosen link does not resolve.
 */
export function successorsFor(corpus: Corpus, rank: string, seed = 0): { succ: Int32Array; term: Uint8Array } {
  const N = corpus.ids.length;
  const succ = new Int32Array(N).fill(-1);
  const term = new Uint8Array(N);
  const nRank = rank === "strict1" ? 1 : (/^\d+$/.test(rank) ? Number(rank) : null);
  for (let i = 0; i < N; i++) {
    const links = corpus.linksByPage.get(corpus.ids[i]);
    if (!links || links.length === 0) { term[i] = TERM.NO_LINKS; continue; }
    const eligible = links.filter((l) => !l.paren && !l.italic && !(l.target >= 0 && corpus.skipTargets.has(l.target)));
    if (eligible.length === 0) { term[i] = TERM.NO_LINKS; continue; }
    let chosen = -1;
    if (rank === "last") {
      chosen = eligible[eligible.length - 1].target;
    } else if (rank === "random") {
      chosen = eligible[Math.floor(rngFor(corpus.ids[i], seed) * eligible.length)].target;
    } else if (nRank !== null) {
      const at = eligible[nRank - 1];
      if (!at) { term[i] = TERM.TOO_FEW; continue; }
      chosen = at.target;
    } else { term[i] = TERM.NO_LINKS; continue; }
    if (chosen < 0) { term[i] = TERM.UNRESOLVED; continue; }
    succ[i] = chosen;
  }
  return { succ, term };
}

/** plain (non-parenthesised, non-italicised) link count, used in reason strings */
export function plainLinkCount(corpus: Corpus, i: number): number {
  return (corpus.linksByPage.get(corpus.ids[i]) ?? []).filter((l) => !l.paren && !l.italic).length;
}

// ---------------------------------------------------------------------------
// functional-graph analysis
// ---------------------------------------------------------------------------

export interface GraphAnalysis {
  attractor: Int32Array; // loop index per node, or DEAD (-2) for dead-end basins
  dist: Int32Array;      // hops from the node to its attractor (0 on the loop)
  loops: number[][];     // cycle node index lists, in discovery order
  inDeg: Int32Array;     // how many pages' chosen link points at each node
}

export function analyzeFunctionalGraph(succ: Int32Array): GraphAnalysis {
  const N = succ.length;
  const attractor = new Int32Array(N).fill(-1);
  const dist = new Int32Array(N).fill(-1);
  const loops: number[][] = [];
  const inDeg = new Int32Array(N);
  for (let i = 0; i < N; i++) if (succ[i] >= 0) inDeg[succ[i]]++;

  const mark = new Int32Array(N).fill(-1);
  let walkId = 0;
  for (let s = 0; s < N; s++) {
    if (mark[s] !== -1) continue;
    walkId++;
    const path: number[] = [];
    const posInPath = new Map<number, number>();
    let cur = s;
    for (;;) {
      if (mark[cur] === walkId) {
        // closed a new cycle within this walk
        const at = posInPath.get(cur)!;
        const a = loops.push(path.slice(at)) - 1;
        for (const n of loops[a]) { attractor[n] = a; dist[n] = 0; }
        for (let p = at - 1; p >= 0; p--) { attractor[path[p]] = a; dist[path[p]] = at - p; }
        break;
      }
      if (mark[cur] !== -1) {
        // joined a component analysed earlier
        const t2 = attractor[cur];
        const base = t2 === DEAD ? 0 : dist[cur];
        for (let p = path.length - 1; p >= 0; p--) { attractor[path[p]] = t2; dist[path[p]] = base + (path.length - p); }
        break;
      }
      mark[cur] = walkId; posInPath.set(cur, path.length); path.push(cur);
      const nx = succ[cur];
      if (nx === -1) {
        for (let p = 0; p < path.length; p++) { attractor[path[p]] = DEAD; dist[path[p]] = path.length - 1 - p; }
        break;
      }
      cur = nx;
    }
  }
  return { attractor, dist, loops, inDeg };
}

/** predecessor lists over the successor table (reverse edges) */
export function predecessors(succ: Int32Array): Map<number, number[]> {
  const preds = new Map<number, number[]>();
  for (let i = 0; i < succ.length; i++) {
    const s = succ[i];
    if (s < 0) continue;
    let arr = preds.get(s);
    if (!arr) { arr = []; preds.set(s, arr); }
    arr.push(i);
  }
  return preds;
}

// ---------------------------------------------------------------------------
// single-chain walk
// ---------------------------------------------------------------------------

export interface Walk {
  chain: number[];              // node indices visited, starting at start
  fate: "cycle" | "dead";
  cycleSize: number;            // size of the terminal cycle (0 when dead)
  endIdx: number;               // node the walk stopped on (read term[endIdx] for the reason)
}

export function walkFrom(succ: Int32Array, start: number, maxLen = 120): Walk {
  const chain = [start];
  const seen = new Set<number>([start]);
  let cur = start;
  for (;;) {
    if (chain.length >= maxLen) return { chain, fate: "cycle", cycleSize: 1, endIdx: cur };
    const nx = succ[cur];
    if (nx === -1) return { chain, fate: "dead", cycleSize: 0, endIdx: cur };
    if (seen.has(nx)) {
      const firstIdx = chain.indexOf(nx);
      return { chain, fate: "cycle", cycleSize: firstIdx >= 0 ? chain.length - firstIdx : 1, endIdx: nx };
    }
    seen.add(nx);
    chain.push(nx);
    cur = nx;
  }
}
