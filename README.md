# gaming_wikipedia_parsing

First-link network analysis for gaming wikis — the ["Getting to Philosophy"](https://en.wikipedia.org/wiki/Wikipedia:Getting_to_Philosophy) experiment applied to game knowledge bases.

Follow the first link of any article, then that article's first link, forever. On Wikipedia, 97% of articles eventually reach *Philosophy*. On gaming wikis, they reach... something else. This toolkit finds out what, and builds an interactive lab to explore it.

## Quick start

```bash
npm install

# fetch a single wiki (respects rate limits)
npx tsx scripts/pipeline.ts --wiki=minecraft

# fetch ALL configured wikis at once
npx tsx scripts/pipeline.ts --all

# or just the fetch step for all wikis
npx tsx scripts/fetch-wiki.ts --all

# or step by step for a single wiki
npx tsx scripts/fetch-wiki.ts --wiki=terraria
npx tsx scripts/extract-links.ts --wiki=terraria
npx tsx scripts/analyze.ts --wiki=terraria

# launch the interactive dashboard
npx tsx scripts/lab-server.ts
```

## Available wikis

Run `npm run wikis` to list. Currently configured:

| ID | Wiki | Origin |
|---|---|---|
| osrs | Old School RuneScape | oldschool.runescape.wiki |
| rs3 | RuneScape 3 | runescape.wiki |
| minecraft | Minecraft | minecraft.wiki |
| terraria | Terraria | terraria.wiki.gg |
| stardew | Stardew Valley | stardewvalleywiki.com |
| factorio | Factorio | wiki.factorio.com |
| poe | Path of Exile | poewiki.net |
| hollowknight | Hollow Knight | hollowknight.wiki |
| tarkov | Escape from Tarkov | escapefromtarkov.fandom.com |
| celeste | Celeste | celeste.boo |

Add more by editing `wikis.json` — any MediaWiki instance works.

## The rules (same as Wikipedia)

Following the chain consists of:
1. Clicking the **first non-parenthesized, non-italicized** link in the article body
2. Ignoring infobox links, external links, and red links
3. Skipping namespace pages (File:, Category:, etc.)
4. Stopping when a **loop** occurs, or a page with **no links**, or an unresolvable target

## What you get

For each wiki and each link rank (1st strict, 1st raw, 2nd, 3rd, 5th, last, random):

- **Convergence** — % of articles whose chain falls into a loop
- **Attractor cycles** — the wiki's "philosophy" equivalents, with basin sizes
- **Distance histogram** — bell curve of hops-to-loop
- **Roads into the top attractor** — which entry edges carry the most traffic
- **Degree centrality** — most linked-at articles
- **Betweenness centrality** — bridges of the network
- **Decay curve** — how collective agreement degrades at higher link ranks
- **Interactive constellation** — force-directed graph of the network

## Data locations

```
output/
├── <wiki>/
│   ├── wiki.sqlite       # raw page dumps (text, aliases, revisions)
│   ├── links.sqlite      # parsed link tables (ordered, with paren/italic flags)
│   ├── stats-*.json      # per-rank statistics
│   ├── summary.json      # cross-rank decay summary
│   ├── graph-*.json      # interactive graph data
│   └── *.csv             # exportable datasets
```

## Polite scraping

- Default **1 request/second** rate limit (configurable via `RATE_LIMIT_MS`)
- Identifies itself with a descriptive User-Agent
- Pauses on 429/5xx responses with exponential backoff
- Only fetches mainspace content pages (no images, no user pages)
- All data stored locally; nothing re-fetched unless missing

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
