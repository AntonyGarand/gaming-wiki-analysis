# Data pipeline brief

Paste this into a fresh session working on `scripts/fetch-wiki.ts`, `scripts/extract-links.ts`,
`scripts/analyze.ts` and `scripts/lab-server.ts`. The article front end (`scripts/article.html`,
`scripts/walkfield.js`, `scripts/build-static.ts`) is owned separately and consumes the
output contract at the bottom. Do not edit those three files.

---

## Prompt

You are fixing the first-link walk pipeline in this repo. Read `README.md` first; the rules it
states are the spec. The current implementation violates several of them, and some wikis'
numbers are artefacts of those violations. Work through the items below in order, keep
each as its own commit, and re-run `analyze.ts` on every wiki at the end.

### 1. Extract the walk into one shared module

Successor selection and attractor detection are copy-pasted into `analyze.ts`,
`lab-server.ts` (twice: `computeGraph` and the `/api/mesh` handler) and the lab server's
`/api/chain` handler is a fourth, slightly different variant. Create `scripts/lib/walk.ts`
exporting:

- `loadCorpus(wikiId)` → `{ ids, titles, idToIdx, linksByPage, skipTargets }`
- `successorsFor(corpus, rank)` → `{ succ: Int32Array, term: Uint8Array }`
- `analyzeFunctionalGraph(succ)` → `{ attractor, dist, loops, inDeg }`
- `walkFrom(succ, start)` → `{ chain: number[], fate, cycleSize }`

Every consumer imports from there. Nothing else in the repo should contain its own
"eligible links" filter after this.

### 2. Fix the walk rules (all in `lib/walk.ts`)

a. **Red links are skipped, not terminal.** A link whose target does not resolve is
   removed from the eligible list, so the walk takes the next eligible link. Today a null
   target ends the chain. This single bug makes 43% of Hytale die at the redlink
   "Gamemode" and 40% of Tarkov die at "Weapons". Keep the `unresolvable` counter in
   stats, but it should now count pages where *every* candidate was unresolvable.

b. **Self-links are not links.** MediaWiki renders `[[Granite]]` on the Granite page as bold
   text. Remove links whose resolved target is the page itself before ranking. OSRS currently
   has 93 one-node "loops" caused by this.

c. **Links whose target is a disambiguation or date page stay skipped** (existing
   behaviour, keep it).

d. **The `random` rank runs several seeds.** Keep the per-page seeded RNG so results are
   reproducible, but run seeds 0..4 and emit the mean and standard deviation of convergence
   and top-attractor share. Pick seed 0 as the one whose successor table is written out.
   The lab server's `/api/chain` must use the same seeded choice as `analyze.ts` for the
   random rank; today it calls `Math.random()` per hop and disagrees with the stats.

### 3. Fix the corpus

a. **Language subpages.** Factorio keeps translations as mainspace subpages
   (`Time/zh`, `Lab/fr`, `Materials and recipes/uk`). Add an optional
   `excludeTitle` regex per wiki in `wikis.json` and set it for Factorio to
   `/\/(zh|zh-tw|fr|de|ru|ja|ko|es|pt|pt-br|it|nl|pl|uk|cs|sv|tr|hu)$/`. Excluded pages are
   dropped from the corpus entirely (not counted in N, not valid targets).

b. **News and patch subpages.** Vampire Survivors routes 22% of its chains into
   `Updates/...` posts. Add `excludeTitle: "^Updates/"` for it. Check the dead-end terminals
   list for every wiki in `stats-rstrict1.json` after the run and add exclusions where a
   non-article namespace is leaking into mainspace.

c. **Per-wiki link templates.** `LINK_TEMPLATES` in `extract-links.ts` is OSRS-specific.
   Move it to an optional `linkTemplates` array in `wikis.json`, keep the OSRS list as the
   default, and add the obvious ones for Minecraft (`BlockLink`, `ItemLink`, `EntityLink`,
   `EnvLink`, `BiomeLink`), Terraria (`item`, `npc`), and Tarkov (anything that renders a
   link; inspect a few pages). The test: Minecraft's `noLinks` count in stats should drop
   noticeably from 3,970.

### 4. Fix italics detection

`parseLinks` only treats a link as italic if the apostrophes sit immediately before it, so
a link in the middle of `''This article is about X. For Y, see [[Z]].''` is not detected,
and plain-text hatnotes leak in as first links. Track italic state as a toggle while
scanning the masked text, the same way parenthesis depth already is. Treat `''` as the
italic toggle and `'''` as bold (ignored); `'''''` toggles both.

### 5. Rename the mislabeled metrics

- `topInDegree` measures how many articles' *first link* is this page, not inbound links.
  Rename the key to `topFirstLinkTargets`.
- `topBetweenness` is not betweenness; it is a sum of remaining-path-length over every
  chain that passes through the node. Replace it with plain chain traffic: the number of
  chains that pass through the node (`flow` in the graph code already computes this).
  Rename the key to `topThroughTraffic` with field `chains`.

### 6. Add the fields the article needs

In each `stats-r<rank>.json`:

```jsonc
"eligibleLinks": {
  "histogram": { "0": 542, "1": 1305, "2": 2947, ... },   // pages by eligible-link count (capped at 10+)
  "atLeast": { "1": 98.5, "2": 94.9, "3": 86.7, "5": 65.6 } // % of pages with >= N eligible links
},
"concentration": {
  "top1Pct": 33.27, "top3Pct": 81.35, "top10Pct": 93.2,
  "cycleCount": 187,
  "entropyBits": 2.41            // Shannon entropy of basin shares, loops only
},
"randomSeeds": {                 // random rank only
  "seeds": 5,
  "convergePct": { "mean": 97.9, "sd": 0.3 },
  "topAttractorPct": { "mean": 41.2, "sd": 9.8 }
}
```

In `summary.json`, per rank, add `top3Pct` and `eligiblePct` (pages with ≥ N eligible links;
100 for `last` and `random`).

### 7. Write the compact successor tables

Replace the `chains-r*.json` files (213 MB, every page repeats its whole chain as strings)
with two small files per wiki that the front end walks itself:

- `output/<wiki>/titles.json` → `string[]`, index = node id, written once per wiki.
  Order must match `ids` order and be identical across ranks.
- `output/<wiki>/succ-r<rank>.json` →
  `{ "rank": "strict1", "succ": number[], "term": number[] }` where `succ[i]` is the node
  index of the chosen link or `-1`, and `term[i]` is `0` (has successor), `1` (no eligible
  links), `2` (fewer than N eligible links), `3` (all candidates unresolvable).

`graph-r*.json` and `mesh-r*.json` are no longer needed; the front end computes layouts from
the successor table. `build-static.ts` only copies files now and needs no running server.

### 8. Acceptance checks

Print these after the full run and include them in the PR description:

- Hytale and Tarkov convergence before and after (expect both to rise a lot).
- Factorio corpus size before and after exclusions.
- OSRS: count of one-node loops in `topAttractors` (expect 0).
- Minecraft `noLinks` before and after link templates.
- For every wiki: top 5 dead-end terminals at rank `strict1`, so leaked namespaces are visible.
- `succ-rstrict1.json` for OSRS is under 1 MB.

---

## Output contract consumed by the article

Per wiki, in `output/<wiki>/`:

| file | required | notes |
|---|---|---|
| `titles.json` | yes | `string[]` |
| `succ-r<rank>.json` | yes, one per rank | `{ rank, succ[], term[] }` |
| `stats-r<rank>.json` | yes | existing shape plus the fields in §6; old keys `topInDegree` / `topBetweenness` still accepted |
| `summary.json` | yes | existing shape plus `top3Pct`, `eligiblePct` |

Anything missing renders as a visible `⟨missing⟩` marker in the article rather than a stale number.
