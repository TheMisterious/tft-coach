// Match context — situational signals computed once per match and shared
// across checkers, so a checker can ask "what kind of game is this" instead
// of judging every round against one fixed standard-curve assumption.
//
// Concretely this replaces silent hedges like "flag this... unless the
// player was running a reroll comp" (which several checkers used to write in
// their coaching text without ever checking) with an actual detection pass.

import type { MatchSnapshot, MetaData, MatchContext, CompArchetype, BoardState } from '../shared/types';
import { isNonChampionToken, boardUnits } from '../ledger/merge';

export const NEUTRAL_CONTEXT: MatchContext = {
  isRerollComp: false,
  matchedComp: undefined,
  hpCrisisRounds: new Set(),
  activeComp: new Set(),
  isFastTempo: false,
};

export function buildMatchContext(match: MatchSnapshot, meta: MetaData): MatchContext {
  const activeComp = computeActiveComp(match);
  const matchedComp = detectRerollComp(match, meta, activeComp);

  return {
    isRerollComp: !!matchedComp,
    matchedComp,
    hpCrisisRounds: computeHpCrisisRounds(match),
    activeComp,
    isFastTempo: computeIsFastTempo(match),
  };
}

// Plurality-vote active comp — unit names on board in >50% of PvP rounds
// *since that unit's first appearance*, not the whole match. Exported so
// checkers/comp.ts's bench-clutter check shares this exact definition of
// "comp" instead of recomputing its own copy.
//
// FIXED (2026-08-02, real match report: a comp pivot at 4-1 brought in Nami
// as the real carry, but she was on board nearly every round from 4-1
// onward and still never counted as "committed" — she was present in 10 of
// the match's 21 total PvP rounds, just under the 50% bar): the original
// version measured every unit's presence against the *whole* match's PvP
// round count, a denominator that includes rounds before a pivoted-in
// champion was even recruited. No genuinely-committed late-pivot carry can
// ever clear a 50%-of-everything bar. Measuring against the rounds since
// each unit's own first appearance instead (Nami: 10/10 = 100% of her
// window) correctly recognizes "played every round since you got her" as
// commitment, regardless of when in the match that was. Units present since
// round one are unaffected — their window already was the whole match.
export function computeActiveComp(match: MatchSnapshot): Set<string> {
  const pvpRounds = match.rounds.filter(r => r.type === 'PVP');
  if (pvpRounds.length === 0) return new Set();

  const firstSeenIdx = new Map<string, number>();
  const presenceCount: Record<string, number> = {};
  pvpRounds.forEach((round, i) => {
    for (const cell of boardUnits(round.board)) {
      if (!firstSeenIdx.has(cell.name)) firstSeenIdx.set(cell.name, i);
      presenceCount[cell.name] = (presenceCount[cell.name] ?? 0) + 1;
    }
  });

  const committed = new Set<string>();
  for (const [name, count] of Object.entries(presenceCount)) {
    const windowLen = pvpRounds.length - firstSeenIdx.get(name)!;
    if (count > windowLen * 0.5) committed.add(name);
  }
  return committed;
}

// Cumulative real damage per champion across every PVP round's battle_stats
// (match_info.battle_stats — same real per-fight telemetry positioning.ts's
// checkRepeatedOpponentCarry and feature-vector.ts's opponentCarryKey already
// trust as ground truth for "who is the carry" on the OPPONENT's board).
// merge.ts's identifyCarry uses this as its own-board equivalent — see the
// 2026-08-02 fix note there for why static role tags and cost weren't enough.
export function computeCarryDamage(match: MatchSnapshot): Map<string, number> {
  const damage = new Map<string, number>();
  for (const round of match.rounds) {
    if (round.type !== 'PVP' || !round.battleStats?.own?.length) continue;
    for (const stats of round.battleStats.own) {
      // Spell-effect/pet tokens (Shen's clone, summons) can deal real
      // recorded damage under their own token name — excluded so a clone
      // can never outrank the real champion it's cloning as "the carry".
      if (isNonChampionToken(stats.name)) continue;
      damage.set(stats.name, (damage.get(stats.name) ?? 0) + stats.totalDamage);
    }
  }
  return damage;
}

// A trait becomes "active" once the board meets its lowest breakpoint tier.
// Exported so plan-builder.ts's per-round comp trajectory shares one
// definition of "what traits are active on this board" — plan-builder.ts
// previously had its own private copy of exactly this logic
// (activeTraitsForRound), moved here unchanged.
export function computeActiveTraitSet(board: BoardState, meta: MetaData): Set<string> {
  const counts: Record<string, number> = {};
  for (const cell of boardUnits(board)) {
    const traits = meta.champions[cell.name]?.traits ?? [];
    for (const trait of traits) counts[trait] = (counts[trait] ?? 0) + 1;
  }

  const active = new Set<string>();
  for (const bp of meta.traitBreakpoints) {
    const lowestTier = bp.tiers[0];
    if (lowestTier !== undefined && (counts[bp.trait] ?? 0) >= lowestTier) {
      active.add(bp.trait);
    }
  }
  return active;
}

// Canonical sort-order key for a trait set, so "TraitA + TraitB" and
// "TraitB + TraitA" (a Set's insertion order isn't meaningful) resolve to the
// same lookup key — the key AggregateMetaTable's traitCombos bucket was
// built with, and the one meta-blend.ts looks a match's own final trait set
// up by.
export function traitSetKey(traits: Set<string> | string[]): string {
  return [...traits].sort().join(',');
}

// A "reroll" archetype match requires the active comp to overlap a curated
// reroll comp's primary carries AND at least one of those carries to have
// reached 2-star by stage 3 — the signature of committing to a reroll line
// early, rather than just happening to play cheap units.
function detectRerollComp(
  match: MatchSnapshot,
  meta: MetaData,
  activeComp: Set<string>
): { id: string; name: string } | undefined {
  const rerollComps = (meta.comps ?? []).filter((c: CompArchetype) => c.type === 'reroll');
  if (rerollComps.length === 0) return undefined;

  const stage3Round = match.rounds.find(r => r.label.startsWith('3-'));
  if (!stage3Round) return undefined;

  for (const comp of rerollComps) {
    const overlap = comp.primary_carry_ids.filter(id => activeComp.has(id));
    if (overlap.length === 0) continue;

    const twoStarByStage3 = overlap.some(id =>
      Object.values(stage3Round.board).some(c => c?.name === id && c.level >= 2)
    );
    if (twoStarByStage3) return { id: comp.id, name: comp.name };
  }
  return undefined;
}

// A level-timing signal only — deliberately not tied to any named comp
// archetype (see MatchContext.isFastTempo doc comment for why). Reuses the
// exact checkpoints checkers/leveling.ts's LEVEL_003/LEVEL_005 already treat
// as "fast" (level 8 by 4-2, level 9 by 5-2), so this can't introduce a new,
// unverified threshold — it's the same one already used elsewhere.
function computeIsFastTempo(match: MatchSnapshot): boolean {
  const at42 = match.rounds.find(r => r.label === '4-2');
  const at52 = match.rounds.find(r => r.label === '5-2');
  if (at42 && at42.level >= 8) return true;
  if (at52 && at52.level >= 9) return true;
  return false;
}

// Rounds at stage 3+ where health dropped below 40 — the same crisis
// threshold checkers/rolling.ts (ROLL_002) and checkers/hp.ts (HP_002) treat
// as "board strength, not econ, should be the priority."
function computeHpCrisisRounds(match: MatchSnapshot): Set<string> {
  const rounds = new Set<string>();
  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-').map(Number);
    if (stageStr >= 3 && round.health < 40) rounds.add(round.label);
  }
  return rounds;
}
