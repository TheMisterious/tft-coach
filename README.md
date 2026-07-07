# TFT Coach

An [Overwolf](https://www.overwolf.com/) app that watches your Teamfight Tactics
match locally and, once it ends, produces a round-by-round coaching report —
what went wrong, when, and what to do instead. Entirely offline: no server,
no account, no telemetry. Everything runs on your machine.

> Not endorsed by Riot Games. TFT and Teamfight Tactics are trademarks of Riot
> Games, Inc.

## What it does

Overwolf's Game Events Provider (GEP) streams raw TFT match state (health,
gold, board, shop, augments, ...) while you play. TFT Coach:

1. **Captures** that raw event stream into a ledger (`src/capture/`, `src/ledger/`).
2. **Reconstructs** it into a round-by-round snapshot of the match.
3. **Runs a deterministic rule engine** (`src/coach/checkers/*.ts`) over every
   round — econ, HP, leveling, rolling, streaks, items, board state,
   positioning, traits, comp, augments, and set-specific mechanics — each
   checker looking for a specific, well-defined mistake.
4. **Resolves** raw IDs (`TFT17_Teemo`, `TFT_Item_RabadonsDeathcap`, ...) to
   friendly names and builds a compact brief.
5. **Renders** a report in a desktop window, with an in-game overlay showing
   static reference info (trait table, item recipes) during the match itself.

There is currently no LLM in the loop — `src/coach/report-generator.ts` is a
deterministic template filler over the rule engine's output. The name is a
holdover from an earlier design; see [Architecture](#architecture) below.

## Compliance

This app is built around what Riot's policies (via Overwolf) actually allow:

- **No live scouting, opponent tracking, or in-game prescriptions.** Coaching
  only happens after the match ends, which Riot explicitly permits.
- **No augment win rates are ever displayed**, in the app or in coaching text.
- **The in-game overlay is static only** — reference tables, not live advice.
- Ads (if ever added) would only appear in the desktop window, never in-game.

If you fork this: keep these rules. They're the difference between "allowed
post-match analysis" and "the kind of live-assist tool Riot bans."

## Architecture

```
GEP events → ledger (raw) → round snapshots → rule engine → brief → report → UI
             src/capture/    src/ledger/       src/coach/    src/coach/  src/ui/
                                                checkers/     brief-builder.ts
```

All set-specific game knowledge (champions, traits, comps, item BiS, econ
benchmarks) lives in `data/sets/set{N}/*.json` — never hardcoded in
TypeScript. Swapping to a new TFT set means adding a new `data/sets/set{N}/`
folder, not touching checker logic. Rules are split into two tiers:

- `data/core/rules.core.json` — set-agnostic mechanics (economy, streaks,
  item mechanics) that don't change set to set.
- `data/sets/set{N}/rules.season.json` — balance-sensitive thresholds (level
  timings, HP curves, this set's unique mechanics) that need re-review after
  patches. `npm run check:patch` flags when this file hasn't been reviewed
  since the last Data Dragon patch.

`src/enrichment/meta-lookup.ts` loads and merges both tiers plus champion/item/
augment name tables, and is the only place friendly names get resolved —
checkers and UI never interpolate raw GEP IDs into coaching text directly.

## Getting started

```bash
npm install
npm run dev      # webpack --watch, outputs to dist/
```

Load `dist/` as an unpacked extension in Overwolf
(Settings → About → Development options → Load unpacked extension). The app
targets TFT (`game_ids: [21570]`, see `public/manifest.json`) and launches
automatically when the game starts.

**Testing without playing a real match:** two Overwolf sample tools are
useful for local development —
[`gep-sim`](https://github.com/overwolf/gep-sim) fires synthetic GEP events
without a running game, and
[`ow-events-recorder`](https://github.com/overwolf/ow-events-recorder) records
a real session to a `.erp` file you can replay later. Neither is part of this
repo.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Production build to `dist/` |
| `npm run dev` | Development build with watch |
| `npm test` | Run the vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | Type-check only (`tsc --noEmit`) |
| `npm run fetch:ddragon` | Refresh champion/item/augment names + champion tile icons from Riot Data Dragon + Community Dragon |
| `npm run fetch:metatft` | Optional, off by default — see script header |
| `npm run check:patch` | Warns if `rules.season.json` hasn't been reviewed since the latest patch |

## Testing

`tests/coach.regression.test.ts` replays real recorded matches
(`tests/goldens/*.jsonl`) through the full pipeline and checks it runs
without throwing, doesn't hallucinate champion names, and produces a sane
placement. **Golden files aren't committed** — a real match ledger contains
every player in your lobby's Riot ID (summoner name + tag line) captured from
the roster, not just your own, and publishing someone else's identifiers
without consent isn't OK. Drop your own recorded matches into
`tests/goldens/` locally (see that test file's header for how to record one);
the suite skips gracefully with a warning if the directory is empty.

`tests/replay-harness.ts` is also usable standalone for debugging a single
match:

```bash
npx ts-node tests/replay-harness.ts tests/goldens/your-match.jsonl
```

## Known limitations

- **57 of 66 Set 17 champions** still have placeholder `role: 'flex'` /
  `traits: []` in `data/sets/set17/champions.json` — only hand-curated
  champions have real data. This silently weakens `POSITION_002` (frontline
  check), `ITEM_002` (damage-on-tank check), and `TRAIT_001` for any
  uncurated champion. Curating the rest from real game knowledge (not
  invented) is the single highest-value contribution right now.
- **`SET17_002`** (Evelynn HP-risk check) has no confirmed source for the
  actual HP cost of a god offering — GEP exposes the offering's internal
  title id but not a numeric cost. See the comment in `src/ledger/rounds.ts`.
- Augment categorization (`data/sets/set17/augments.json`) only covers
  economy/combat/items/units buckets classified from official text — ~100
  real augments are intentionally unclassified (generic random rewards that
  don't fit one bucket).
- No LLM narration despite the module name history mentioned above — reports
  are deterministic template text, not generated prose.

## License

MIT — see [LICENSE](LICENSE).
