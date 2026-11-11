# coachv

An [Overwolf](https://www.overwolf.com/) app that watches your Teamfight Tactics
match locally and, once it ends, produces a round-by-round coaching report —
what happened, when, and the usual answer. No telemetry, no account, no
sign-in. Coaching runs entirely on your machine from Overwolf's Game Events
Provider; the app calls no authenticated Riot API. The only outbound network
calls are to Riot's public Data Dragon/Community Dragon CDNs for
champion/item data, and to Overwolf's ad service for the desktop window's ad.

> Not endorsed by Riot Games. TFT and Teamfight Tactics are trademarks of Riot
> Games, Inc.

## What it does

Overwolf's Game Events Provider (GEP) streams raw TFT match state (health,
gold, board, shop, augments, ...) while you play. coachv:

1. **Captures** that raw event stream into a ledger (`src/capture/`, `src/ledger/`).
2. **Reconstructs** it into a round-by-round snapshot of the match.
3. **Runs a deterministic rule engine** (`src/coach/checkers/*.ts`) over every
   round — econ, HP, leveling, rolling, streaks, items, board state,
   positioning, traits, comp, augments, and set-specific mechanics — each
   checker describing one specific, well-defined situation. Every rule is
   audited against real placements (`scripts/rule-audit.ts` →
   `data/core/rule-evidence.json`); the report leads with the ones that hold
   up, and the text states what happened and the usual answer, not a verdict
   (`tests/coaching-prose.test.ts` enforces the wording).
4. **Reads the whole picture** around those rules: the other seven players
   across the match (`src/coach/lobby-map.ts` — HP and level each round,
   their results, the boards of theirs the game sent, which of your units
   they fielded, whether you scouted them), every planning round as one spot
   (`src/coach/decision-windows.ts` — losses left, bank, level against the
   lobby, pairs, the last three fights, contest, what you did there and the
   usual lines from that spot with their conditions), and your usual game
   over your last 20 recorded matches (`src/profile/style.ts`) so the report
   can say where this one differed.
5. **Resolves** raw IDs (`TFT17_Teemo`, `TFT_Item_RabadonsDeathcap`, ...) to
   friendly names and builds a compact brief.
6. **Renders** the report in the desktop window. In game, the only thing shown
   is a "report ready" notification once the match is over.

The reconstruction keeps more of a round than its end state: every shop the
game sent (one per roll), what was bought, the boards looked at before the
fight (`match_info.board_spectate` in the planning phase), the item choices
offered and taken, and every player's result. Rules written on those feeds
are candidates (status `candidate` in `data/core/rules.core.json`) until
matches recorded after they were written confirm them.

There is currently no LLM in the loop — `src/coach/report-generator.ts` is a
deterministic template filler over the rule engine's output. The name is a
holdover from an earlier design; see [Architecture](#architecture) below.

## Compliance

This app is built around what Riot's policies (via Overwolf) actually allow:

- **No live scouting, opponent tracking, or in-game prescriptions.** Coaching
  only happens after the match ends, which Riot explicitly permits.
- **No augment win rates are ever displayed**, in the app or in coaching text.
- **Nothing live in game.** The only in-game element is a short "report
  ready" notification after the match.
- **Ads only in the desktop window:** one 728x90 Overwolf ad at the bottom,
  removed while the window is minimized. Never in game.

If you fork this: keep these rules. They're the difference between "allowed
post-match analysis" and "the kind of live-assist tool Riot bans."

## Architecture

```
GEP events → ledger (raw) → round snapshots → rule engine → brief → report → UI
             src/capture/    src/ledger/       src/coach/    src/coach/  src/ui/
                                                checkers/     brief-builder.ts
```

Ledger to report runs in `src/background/pipeline.ts`, which has no Overwolf
or storage calls: the app (`src/background/main.ts`) and the test harness
(`tests/replay-harness.ts`) both run it.

All set-specific game knowledge (champions, traits, comps, item BiS, econ
benchmarks) lives in `data/sets/set{N}/*.json` — never hardcoded in
TypeScript. Swapping to a new TFT set means adding a new `data/sets/set{N}/`
folder, not touching checker logic. Rules are split into two tiers:

- `data/core/rules.core.json` — set-agnostic mechanics (economy, streaks,
  item mechanics) that don't change set to set.
- `data/sets/set{N}/rules.season.json` — balance-sensitive thresholds (level
  timings, HP curves, this set's unique mechanics) that need re-review after
  patches. `src/coach/rules-loader.ts` reads every set's file (a new set adds
  its file there). `npm run check:patch` flags when the newest set's file
  hasn't been reviewed since the last Data Dragon patch.

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
targets TFT (`game_ids: [28164]`, see `public/manifest.json`) and launches
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
| `npm run fetch:riot-meta` | Development-time only: derive a set's champion roles, carry BiS and reroll comps from top players' Riot match records into `data/sets/` (needs `RIOT_API_KEY`; `--cached` re-derives offline). The shipped app never calls the Riot API |
| `npm run data:augment-effects` | Re-derive `augment-effects.json` from Data Dragon augment text |
| `npm run fetch:metatft` | Optional, off by default — see script header |
| `npm run check:patch` | Warns if the newest set's `rules.season.json` hasn't been reviewed since the latest patch (pass a set id for another) |

## Testing

`tests/coach.regression.test.ts` replays real recorded matches
(`tests/goldens/*.jsonl`) through the full pipeline and checks it runs
without throwing, doesn't hallucinate champion names, and produces a sane
placement. **Golden files aren't committed** — a real match ledger contains
every player in your lobby's Riot ID (summoner name + tag line) captured from
the roster, not just your own, and publishing someone else's identifiers
without consent isn't OK. Drop your own recorded matches into
`tests/goldens/` locally (see that test file's header for how to record one);
every golden-based test skips if its file is missing, so a fresh clone passes.
`tests/pipeline.test.ts` and `tests/set18-gep-shapes.test.ts` cover the same
pipeline on hand-written ledgers.

`tests/replay-harness.ts` is also usable standalone for debugging a single
match:

```bash
npx ts-node tests/replay-harness.ts tests/goldens/your-match.jsonl
```

## Known limitations

- **Most rules are unproven.** Of 49 rules, only `HP_002` and `HP_003` are
  confirmed on held-out games (77 recorded matches, one player; the smallest
  effect that sample can detect is about 1.5 placements). The rest show as
  observations, and category letter grades are shown only for the categories
  whose grades track placement (econ, HP, board). Seven rules are candidates
  that wait for matches recorded after they were written: `ECON_005`,
  `ROLL_006` (2026-10-14), `BOARD_004` (2026-11-09), and `SHOP_001`,
  `SCOUT_001`, `LOBBY_003`, `ITEM_006` (2026-11-11). More recorded games are
  what moves this — re-run `scripts/rule-audit.ts` as they accumulate.
- **The lobby, decision-window and style reads are not audited.** They
  describe the match (facts and conditional lines) rather than flag it, so
  the audit has nothing to window on. Their wording follows the same
  standard as the rules: observations and the usual answer, never a verdict.
- **Scouting is read from `board_spectate`,** which the Set 17 recordings
  send about once a second and the Set 18 recordings send far less often.
  A match that never sent it gets no scouting reading at all.
- **Champion prevalence** (`riot-meta.source.json`, read as
  `MetaData.metaUnits`) exists only for sets that have been through
  `npm run fetch:riot-meta`; Set 17 has none. Re-running it also fills the
  new `topFour` tally per champion.
- **Set 18 (the live set)** runs on carried-over thresholds. Its
  `rules.season.json` holds Set 17's season rules minus the Realm of the Gods
  ones, and none has been re-verified against Set 18 balance
  (`patch_meta.verified_ddragon_version` is null). It has no econ benchmarks,
  so `ECON_004` never fires, and no reroll comps: `fetch:riot-meta` found none
  that met its thresholds in 400 Challenger/Master matches. Without them,
  `ECON_003` cannot tell a Set 18 reroll line from early rolling.
  `riot-meta.source.json` was written before the patch label was recorded, so
  re-run `npm run fetch:riot-meta` to fill it in.
- **Champion roles:** 23 of 74 Set 18 champions are `flex` (rarely itemised
  by top players, by `fetch:riot-meta`'s fixed thresholds), and 56 of 66 Set
  17 champions still have the placeholder `role: 'flex'`. This weakens
  `POSITION_002` (frontline check) and `ITEM_002` (damage-on-tank check) for
  those units. Curate from real game knowledge, not invented values.
- **`SET17_002`** (Evelynn HP-risk check) has no confirmed source for the
  actual HP cost of a god offering — GEP exposes the offering's internal
  title id but not a numeric cost. See the comment in `src/ledger/rounds.ts`.
- Augment categorization (`data/sets/set{N}/augments.json`) only covers
  economy/combat/items/units buckets classified from official text. About 100
  Set 17 augments and 43 of 249 Set 18 augments are intentionally unclassified
  (generic random rewards that don't fit one bucket).
- No LLM narration despite the module name history mentioned above — reports
  are deterministic template text, not generated prose.

## License

MIT — see [LICENSE](LICENSE).
