# gaming-wiki-analysis

**Live article:** https://antonygarand.github.io/gaming-wiki-analysis/

> **Slopline.** Everything in this repository — the scraper, the analysis, the numbers, the prose and the
> visuals — is currently vibe-coded with an AI assistant and has **not** gone through a thorough human
> review. Treat every figure and every claim as unverified until this notice is removed.
>
> **Status:** article, charts and build are a working draft. Prose is written for OSRS; every number in it is
> bound to the data files at render time, so regenerating the data never leaves a stale figure behind.
> GitHub Pages serves `dist/` from `main`.

First-link network analysis for gaming wikis — the ["Getting to Philosophy"](https://en.wikipedia.org/wiki/Wikipedia:Getting_to_Philosophy) experiment applied to game knowledge bases.

Follow the first link of any article, then that article's first link, forever. On Wikipedia, 97% of articles eventually reach *Philosophy*. On gaming wikis, they reach... something else. This toolkit finds out what, and builds an interactive lab to explore it.

## Quick start

```bash
npm install

# fetch + extract + analyze one wiki (respects rate limits)
npx tsx scripts/pipeline.ts --wiki=minecraft

# or all configured wikis
npx tsx scripts/pipeline.ts --all

# bake the article into dist/ (pure file copy, no server needed)
npm run build:static

# preview it
npm run serve:static        # → http://localhost:8080  (/ = article, /mesh/ = full-page walk field)

# the lab dashboard + article over the live analysis output
npm run lab                 # → http://localhost:8787  (/ = article, /lab = dashboard, /mesh = full-page mesh field)
```

The article (`scripts/article.html`) is fully static. It reads, per wiki, `titles.json`, one
`succ-r<rank>.json` successor table per link rank, `stats-r<rank>.json` and `summary.json`, and
computes everything else client-side: loops, basins, the drainage-map layout, chain walks, search.
`scripts/walkfield.js` is the engine behind the hero and the map. The exact file contract is in
[`docs/data-pipeline-brief.md`](docs/data-pipeline-brief.md).

The wiki drainage map (`scripts/walkfield.html`) ships in the same build at `dist/mesh/` — the
article's drainage map as its own full page. It is static too: it reads the same successor tables
and builds the graph client-side, so it renders identically on GitHub Pages. Served by the lab
server at `/mesh` it uses the live output via `/api/walktable` instead.

If your `output/` folders still hold the old `chains-r*.json` tables, run
`npm run convert:legacy -- --src=<dir>` once to produce the successor tables.

## Available wikis

Run `npm run wikis` to list. Currently configured:

| ID | Wiki | Origin |
|---|---|---|
| osrs | Old School RuneScape | oldschool.runescape.wiki |
| rs3 | RuneScape | runescape.wiki |
| rsc | RuneScape Classic | classic.runescape.wiki |
| minecraft | Minecraft | minecraft.wiki |
| gta | GTA | gta.wiki |
| overwatch | Overwatch | overwatch.weirdgloop.org |
| fortnite | Fortnite | fortnite.weirdgloop.org |
| valheim | Valheim | valheim.weirdgloop.org |
| vampiresurvivors | Vampire Survivors | vampire.survivors.wiki |
| balatro | Balatro | balatrowiki.org |
| hytale | Hytale | hytalewiki.org |
| subnautica | Subnautica | wiki.subnautica.com |
| terraria | Terraria | terraria.wiki.gg |
| factorio | Factorio | wiki.factorio.com |
| tarkov | Escape from Tarkov | escapefromtarkov.fandom.com |

Add more by editing `wikis.json` — any MediaWiki instance works.

## The rules (same as Wikipedia)

Following the chain consists of:
1. Clicking the **first non-parenthesized, non-italicized** link in the article body — links landing on disambiguation pages ("X may refer to…") or date pages ("28 April") are also skipped, and self-links don't count (MediaWiki renders them as bold text)
2. Ignoring infobox links, external links, and red links (a red link is skipped, not followed — the walk takes the next eligible link)
3. Skipping namespace pages (File:, Category:, …) and interwiki/language links (`fr:`, `pt-br:`, …)
4. Stopping when a **loop** occurs, or a page with no clickable links

Pages whose entire body is generated (transcluded guide tables, template-built
listings) fall back to *everything that renders*. For those pages only, the
pipeline also fetches the templates they invoke and inlines the self-contained
**prose** ones — templates whose links are written out in their body, with no
`{{{parameters}}}`, no navbox/infobox chrome — so a page whose lead paragraphs
come from e.g. `{{Treasure Trails Guide Anagrams Intro}}` walks into the link a
reader would actually click first.

## What you get

For each wiki and each link rank (1st, 2nd, 3rd, 5th, last, random — all strict: parenthesised and italicised links never count):

- **Convergence** — % of articles whose chain falls into a loop
- **Attractor cycles** — the wiki's "philosophy" equivalents, with basin sizes
- **Distance histogram** — bell curve of hops-to-loop
- **Roads into the top attractor** — which entry edges carry the most traffic
- **First-link targets** — most linked-at articles by chosen link
- **Through traffic** — how many chains pass through each article
- **Decay curve** — how collective agreement degrades at higher link ranks
- **Interactive constellation** — force-directed graph of the network

## Data locations

```
output/
├── <wiki>/
│   ├── wiki.sqlite          # raw page dumps (text, aliases, revisions) + fetched templates
│   ├── links.sqlite         # parsed link tables (ordered, with paren/italic flags)
│   ├── titles.json          # node id → title (shared by every rank)
│   ├── succ-r<rank>.json    # { succ[], term[] } successor table per rank
│   ├── stats-r<rank>.json   # per-rank statistics
│   ├── summary.json         # cross-rank summary
│   └── *.csv                # exportable datasets
dist/                        # static site: index.html + walkfield.js + data/
```

## Per-wiki tuning (wikis.json)

Optional fields on a wiki entry:

- `excludeTitle` — regex (JS literal style `"/re/flags"` or bare) dropping matching
  titles from the corpus entirely: not counted, not valid targets. Used for
  Factorio's translation subpages (`Time/zh`) and Vampire Survivors' `Updates/` posts.
- `linkTemplates` — extra templates whose first positional parameter renders as a
  link (e.g. Minecraft's `BlockLink`/`ItemLink` family, Terraria's `item`/`npc`),
  added to the default Weird Gloop set (`plink`, `scp`, `gep`, …).

## Polite scraping

- **Hard-capped at 1 request/second** — every request is serialized through one
  throttle chain (modeled on the parsed-osrs wiki-scraper's `WikiRequestService`);
  `RATE_LIMIT_MS` can only slow it down, never speed it up
- Identifies itself with a descriptive User-Agent
- Pauses on 429/5xx responses with Retry-After-aware exponential backoff
- Only fetches mainspace content pages (no images, no user pages), plus the
  handful of template pages needed by fallback pages (batched, 50/request)
- All data stored locally; nothing re-fetched unless missing

## Baseline scraper & seeding (osrs, rs3)

The HTTP layer is modeled on the parsed-osrs
[wiki-scraper](../osrs-cloud-wiki-scraper/wiki-scraper) — its dumps of the
OSRS and RS3 wikis (wikitext, revisions, redirects) can seed this project's
corpora with **zero** API requests:

```bash
npx tsx scripts/import-from-scraper.ts --wiki=osrs
npx tsx scripts/import-from-scraper.ts --wiki=rs3   # run after the background pipeline finishes
```

The merge is idempotent: pages missing here are inserted, newer baseline
revisions update the row, and redirects are union-merged; the next
`npm run extract` picks up changed revisions incrementally.

## Adding a new wiki

1. Add an entry to `wikis.json`:
   ```json
   { "id": "mygame", "name": "My Game Wiki", "origin": "https://mygame.wiki", "description": "..." }
   ```
2. Run the pipeline:
   ```bash
   npx tsx scripts/pipeline.ts --wiki=mygame
   ```

Any MediaWiki instance with a public `api.php` endpoint works.

## License

MIT
