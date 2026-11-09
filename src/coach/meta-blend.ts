// Blends AggregateMetaTable (crowd data; nothing produces it since the
// in-app crawler was removed on 2026-11-09, so it is normally absent)
// into coaching output — deliberately never a tier-list judgment. See
// MetaContext's doc comment in shared/types.ts for the full reasoning; the
// short version: comp/champion standing is always neutral reference info,
// and the ONLY place an implied "you had a better option" claim is allowed
// is when RoundSnapshot.shop (real per-round captured champion offers) shows
// the player was actually offered something they never touched — never
// invented from trait-set composition guessing, and never applied to
// augments at all (GEP doesn't capture declined augment options, so no
// augment equivalent of missedChampion exists).

import type { MatchSnapshot, MetaData, MetaContext } from '../shared/types';
import { getAugmentName, getChampionName } from '../enrichment/meta-lookup';
import { traitSetKey } from './match-context';

const MIN_SAMPLES = 15;       // same bar src/profile/trend-model.ts uses before trusting a stat
const MISSED_MARGIN = 1.0;    // placements — how much better the alternative must average
const MIN_OFFER_COUNT = 3;    // shop offers required before "passed on it" is a real pattern, not noise

// Takes `finalTraits` directly rather than a whole MatchContext/MatchPlan:
// plan-builder.ts's buildMatchPlan computes finalTraits itself and calls this
// before its own MatchPlan object exists (metaContext becomes a field ON that
// object), so there's no already-built plan/context to hand in at that point.
export function buildMetaContext(
  match: MatchSnapshot,
  finalTraits: string[],
  meta: MetaData
): MetaContext | undefined {
  const table = meta.metaTierTable;
  if (!table) return undefined;

  const compStanding = computeCompStanding(finalTraits, table);
  const missedChampion = computeMissedChampion(match, table, meta);

  if (!compStanding && !missedChampion) return undefined;
  return { compStanding, missedChampion };
}

function computeCompStanding(
  finalTraits: string[],
  table: NonNullable<MetaData['metaTierTable']>
): MetaContext['compStanding'] {
  if (finalTraits.length === 0) return undefined;

  const key = traitSetKey(finalTraits);
  const bucket = table.traitCombos[key];
  if (!bucket || bucket.samples < MIN_SAMPLES) return undefined;

  return { avgPlacement: bucket.avgPlacement, samples: bucket.samples };
}

function computeMissedChampion(
  match: MatchSnapshot,
  table: NonNullable<MetaData['metaTierTable']>,
  meta: MetaData
): MetaContext['missedChampion'] {
  const ownedEver = new Set<string>();
  for (const round of match.rounds) {
    for (const cell of [...Object.values(round.board), ...Object.values(round.bench)]) {
      if (cell?.name && cell.name !== '0') ownedEver.add(cell.name);
    }
  }

  const shopCounts: Record<string, number> = {};
  for (const round of match.rounds) {
    for (const champId of round.shop) {
      if (!champId || champId === '0' || ownedEver.has(champId)) continue;
      shopCounts[champId] = (shopCounts[champId] ?? 0) + 1;
    }
  }

  let best: { name: string; avgPlacement: number; offeredCount: number; margin: number } | undefined;
  for (const [champId, offeredCount] of Object.entries(shopCounts)) {
    if (offeredCount < MIN_OFFER_COUNT) continue;
    const bucket = table.champions[champId];
    if (!bucket || bucket.samples < MIN_SAMPLES) continue;

    const margin = match.finalPlacement - bucket.avgPlacement;
    if (margin < MISSED_MARGIN) continue;
    if (!best || margin > best.margin) {
      best = { name: getChampionName(champId, meta), avgPlacement: bucket.avgPlacement, offeredCount, margin };
    }
  }

  return best ? { name: best.name, avgPlacement: best.avgPlacement, offeredCount: best.offeredCount } : undefined;
}

// Short, always-safe-to-concatenate informational clause for a picked
// augment — same pattern as plan-builder.ts's pivotContextClause. Never
// phrased as a missed alternative (augment offers aren't capturable by GEP
// at all — see checkers/augments.ts's header comment), purely reference info.
export function metaAugmentClause(meta: MetaData, augmentId: string): string {
  const bucket = meta.metaTierTable?.augments[augmentId];
  if (!bucket || bucket.samples < MIN_SAMPLES) return '';
  const name = getAugmentName(augmentId, meta);
  return ` For reference, ${name} has averaged ${bucket.avgPlacement.toFixed(1)} place across ${bucket.samples} recent high-elo games.`;
}
