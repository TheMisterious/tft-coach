// Trait breakpoint checker — flags "one unit away from the next tier" sustained across rounds.

import type { MatchSnapshot, DecisionPoint, RoundSnapshot, MetaData } from '../../shared/types';
import { boardChampionIds } from '../../ledger/merge';
import { getAugmentTraitBonus } from '../../enrichment/meta-lookup';

const CONSECUTIVE_THRESHOLD = 3;

export function checkTraitBreakpoints(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const consecutiveMap: Record<string, number> = {};

  for (const round of match.rounds) {
    if (round.type !== 'PVP') continue;

    const champIds   = boardChampionIds(round.board);
    const traitCounts = countTraits(champIds, meta, round.augmentsPicked);

    // Track which traits were "one away" this round so we can reset the rest.
    const oneAwayThisRound = new Set<string>();

    for (const { trait, count } of traitCounts) {
      const tiers   = getBreakpoints(trait, meta);
      if (tiers.length === 0) continue;

      const nextTier = tiers.find(t => t > count);
      if (nextTier === undefined) continue;

      const unitsAway = nextTier - count;
      if (unitsAway !== 1) {
        consecutiveMap[trait] = 0;
        continue;
      }

      oneAwayThisRound.add(trait);
      consecutiveMap[trait] = (consecutiveMap[trait] ?? 0) + 1;

      if (consecutiveMap[trait] >= CONSECUTIVE_THRESHOLD) {
        // Find a cheap unit that would complete the trait.
        const fillerName = findCheapFiller(trait, champIds, meta);
        const fillerHint = fillerName ? ` (e.g. ${fillerName})` : '';

        points.push({
          ruleId:   'TRAIT_001',
          round:    round.label,
          category: 'traits',
          severity: 'minor',
          observed:  `${trait} at ${count}/${nextTier} for ${consecutiveMap[trait]} consecutive PvP rounds`,
          recommended: `Adding one more ${trait} unit${fillerHint} would activate the ${nextTier}-tier bonus`,
          reasonMetrics: { trait, current: count, nextTier, rounds: consecutiveMap[trait] },
          coaching_text: byContext(round, {
            low:  `You've been one unit short of ${trait} ${nextTier} for ${consecutiveMap[trait]} rounds and you're already low on HP — missing this breakpoint is costing you fight wins that are directly accelerating your elimination. Pick up the cheapest ${trait} unit${fillerHint} from the next shop even if it sits on bench.`,
            mid:  `${trait} has been stuck at ${count}/${nextTier} for ${consecutiveMap[trait]} consecutive fights. One additional unit${fillerHint} activates the ${nextTier}-tier bonus for every remaining fight — at ${round.health} HP the power swing is worth the bench slot.`,
            high: `${trait} has been one unit short of the ${nextTier}-tier for ${consecutiveMap[trait]} rounds. You have the HP to absorb losses, but completing the breakpoint now is free efficiency — scout for the cheapest ${trait} unit${fillerHint} and pick it up when shop permits.`,
          }),
        });
        consecutiveMap[trait] = 0;
      }
    }

    // Reset any traits that weren't one-away this round.
    for (const trait of Object.keys(consecutiveMap)) {
      if (!oneAwayThisRound.has(trait)) consecutiveMap[trait] = 0;
    }
  }

  return points;
}

// Board units contribute the base count; a picked augment can add to it (e.g. an
// augment granting "count as an extra Duelist") without a unit occupying a slot.
function countTraits(
  champIds: string[],
  meta: MetaData,
  pickedAugments: string[]
): Array<{ trait: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const id of champIds) {
    const champ = meta.champions[id];
    if (!champ) continue;
    for (const trait of champ.traits) {
      counts[trait] = (counts[trait] ?? 0) + 1;
    }
  }
  // Augment bonuses can introduce a trait with zero units on board (e.g. an
  // augment granting "count as 1 Duelist"), so seed every breakpoint-tracked
  // trait at 0 before adding bonuses, not just traits already present.
  for (const { trait } of meta.traitBreakpoints) {
    const bonus = getAugmentTraitBonus(trait, pickedAugments, meta);
    if (bonus === 0) continue;
    counts[trait] = (counts[trait] ?? 0) + bonus;
  }
  return Object.entries(counts).map(([trait, count]) => ({ trait, count }));
}

function getBreakpoints(trait: string, meta: MetaData): number[] {
  return meta.traitBreakpoints.find(tb => tb.trait === trait)?.tiers ?? [];
}

// Finds the lowest-tier unit that has the needed trait and is not already on board.
function findCheapFiller(trait: string, currentIds: string[], meta: MetaData): string | null {
  const onBoard = new Set(currentIds);
  let best: { name: string; tier: number } | null = null;
  for (const [id, champ] of Object.entries(meta.champions)) {
    if (onBoard.has(id)) continue;
    if (!champ.traits.includes(trait)) continue;
    if (!best || champ.tier < best.tier) best = { name: champ.name, tier: champ.tier };
  }
  return best?.name ?? null;
}

function byContext(round: RoundSnapshot, t: { low: string; mid: string; high: string }): string {
  if (round.health <= 40) return t.low;
  if (round.health >= 70) return t.high;
  return t.mid;
}
