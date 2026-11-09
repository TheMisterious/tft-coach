# coachv

An [Overwolf](https://www.overwolf.com/) app that watches your Teamfight Tactics
match locally and, once it ends, produces a round-by-round coaching report —
what went wrong, when, and what to do instead. No telemetry. Coaching runs
entirely on your machine — the only outbound network calls are to Riot's own
Data Dragon/Community Dragon CDNs for champion/item data, and, if you choose
to sign in with Riot, to the small coachv backend that handles that sign-in
(see [Linking a Riot account](#linking-a-riot-account-optional) below).

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
targets TFT (`game_ids: [21570]`, see `public/manifest.json`) and launches
automatically when the game starts.

**Testing without playing a real match:** two Overwolf sample tools are
useful for local development —
[`gep-sim`](https://github.com/overwolf/gep-sim) fires synthetic GEP events
without a running game, and
[`ow-events-recorder`](https://github.com/overwolf/ow-events-recorder) records
a real session to a `.erp` file you can replay later. Neither is part of this
repo.

## Linking a Riot account (optional)

Round-by-round coaching works fully offline with no setup. Linking a Riot
account adds two extra things GEP can never see on its own: your current
ranked tier/LP shown in the desktop window's status bar, and a background
check that compares Riot's own record of your placement against what this
app captured, flagging a mismatch if the two ever disagree.

This does **not** replace GEP or change how coaching reports are generated —
Riot's match API only returns a match's *final* result (placement, augments,
final board), never the round-by-round timeline the rule engine reasons
about.

**Setup (player):** click the ⚙ (gear) icon in the desktop window's status
bar, then **Sign in with Riot**. Riot's own sign-in page opens in your
browser; when you finish, coachv comes back to the front, signed in. Pick
the server you play on (`na1`, `euw1`, `kr`, `vn2`, ...) in the same panel.

**How it works:** Riot Sign On (RSO). The player never types a key or a
password into coachv. The sign-in runs through `server/rso-worker`, a
Cloudflare Worker that holds the RSO client secret and the production API
key, neither of which may ship inside the app. It returns a session bound to
the signed-in account, and the app uses that session for the two reads it
needs: rank, and the latest match's placement. See
[server/rso-worker/README.md](server/rso-worker/README.md) to deploy it, and
build the app with `COACHV_BACKEND_URL` set to its origin. Without it the
sign-in button is disabled and everything else works as before.

App side: `src/enrichment/riot-sign-in.ts` (start/finish the sign-in),
`src/enrichment/coachv-backend.ts` (backend calls), and the `coachv://` URL
scheme in `public/manifest.json`. Earlier builds asked players to paste a
personal API key; any such key still in local storage is deleted on load.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Production build to `dist/` |
| `npm run dev` | Development build with watch |
| `npm test` | Run the vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | Type-check only (`tsc --noEmit`) |
| `npm run fetch:ddragon` | Refresh champion/item/augment names + champion tile icons from Riot Data Dragon + Community Dragon |
| `npm run fetch:riot-meta` | Derive a set's champion roles, carry BiS and reroll comps from top players' Riot match records (needs `RIOT_API_KEY`; `--cached` re-derives offline) |
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

- **Most rules are unproven.** Of 45 rules, only `HP_002` and `HP_003` are
  confirmed on held-out games (74 recorded matches, one player; the smallest
  effect that sample can detect is about 1.6 placements). The rest show as
  observations, and category letter grades are shown only for the categories
  whose grades track placement (econ, HP, board). More recorded games are what
  moves this — re-run `scripts/rule-audit.ts` as they accumulate.
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
