// Match context — situational signals computed once per match and shared
// across checkers, so a checker can ask "what kind of game is this" instead
// of judging every round against one fixed standard-curve assumption.
//
// Concretely this replaces silent hedges like "flag this... unless the
// player was running a reroll comp" (which several checkers used to write in
// their coaching text without ever checking) with an actual detection pass.

import type { MatchSnapshot, MetaData, MatchContext, CompArchetype } from '../shared/types';

export const NEUTRAL_CONTEXT: MatchContext = {
  isRerollComp: false,
  matchedComp: undefined,
  hpCrisisRounds: new Set(),
  activeComp: new Set(),
};

export function buildMatchContext(match: MatchSnapshot, meta: MetaData): MatchContext {
  const activeComp = computeActiveComp(match);
  const matchedComp = detectRerollComp(match, meta, activeComp);

  return {
    isRerollComp: !!matchedComp,
    matchedComp,
    hpCrisisRounds: computeHpCrisisRounds(match),
    activeComp,
  };
}

// Plurality-vote active comp — unit names on board in >50% of PvP rounds.
// (Mirrors the logic checkers/comp.ts uses for bench-clutter detection;
// hoisted here so archetype detection can reuse the same notion of "comp".)
function computeActiveComp(match: MatchSnapshot): Set<string> {
  const nameFreq: Record<string, number> = {};
  for (const round of match.rounds) {
    if (round.type !== 'PVP') continue;
    for (const cell of Object.values(round.board)) {
      if (!cell?.name || cell.name === '0') continue;
      nameFreq[cell.name] = (nameFreq[cell.name] ?? 0) + 1;
    }
  }
  const pvpCount = match.rounds.filter(r => r.type === 'PVP').length;
  if (pvpCount === 0) return new Set();
  return new Set(
    Object.entries(nameFreq)
      .filter(([, count]) => count > pvpCount * 0.5)
      .map(([name]) => name)
  );
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
