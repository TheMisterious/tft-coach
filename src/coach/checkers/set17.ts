// SET17_001: God alignment — no god chosen twice across rounds 2-4, 3-4, 4-4
// SET17_002: Evelynn HP risk — accepted HP-cost offering below 40 HP
// SET17_003: God alignment locked out — not aligned after 3-4 with one pick left

import type { MatchSnapshot, DecisionPoint } from '../../shared/types';

const GOD_ROUNDS = new Set(['2-4', '3-4', '4-4']);
const EVELYNN    = 'Evelynn';
const PENGU      = 'Pengu';

export function checkSet17(match: MatchSnapshot): DecisionPoint[] {
  if (match.setId !== 'set17') return [];
  if (match.godPicks.length === 0) return []; // GEP data unavailable — skip silently

  return [
    ...checkGodAlignment(match),
    ...checkEvelynnHpRisk(match),
    ...checkAlignmentLockedOut(match),
  ];
}

// SET17_001
function checkGodAlignment(match: MatchSnapshot): DecisionPoint[] {
  // Only evaluate once all three god rounds have occurred.
  const godRoundsDone = match.godPicks.filter(p => GOD_ROUNDS.has(p.round));
  if (godRoundsDone.length < 3) return [];

  const counts: Record<string, number> = {};
  for (const { god } of godRoundsDone) {
    if (god === PENGU) continue; // Pengu picks don't count toward alignment
    counts[god] = (counts[god] ?? 0) + 1;
  }

  const maxCount = Math.max(0, ...Object.values(counts));
  if (maxCount >= 2) return []; // aligned — no issue

  const picksFormatted = godRoundsDone.map(p => `${p.round}: ${p.god}`).join(', ');

  return [{
    ruleId:   'SET17_001',
    round:    '4-4',
    category: 'set_mechanic',
    severity: 'critical',
    observed: `No God alignment achieved — three different gods chosen: ${picksFormatted}`,
    recommended: 'Picking the same God at least twice unlocks the God Blessing at round 4-7 — the game\'s biggest mid-game power spike',
    reasonMetrics: { maxCount, picks: godRoundsDone.length },
    coaching_text: `You chose a different God at each of the three God rounds (${picksFormatted}) and never aligned with any god. Alignment — picking the same god twice — unlocks the God Blessing at round 4-7, which is the single highest-impact mid-game event in Set 17. Even when a different god's offering looks appealing in the moment, the compounding value of the Blessing almost always outweighs the immediate gain from switching.`,
  }];
}

// SET17_002
function checkEvelynnHpRisk(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  for (const round of match.rounds) {
    if (!GOD_ROUNDS.has(round.label)) continue;
    if (round.godChosen !== EVELYNN) continue;
    if (!round.godOfferingHpCost || round.godOfferingHpCost <= 0) continue;
    if (round.health >= 40) continue;

    points.push({
      ruleId:   'SET17_002',
      round:    round.label,
      category: 'set_mechanic',
      severity: 'critical',
      observed: `Chose an Evelynn offering (-${round.godOfferingHpCost} HP) at ${round.health} HP`,
      recommended: 'Below 40 HP, Evelynn HP-cost offerings are too dangerous — choose a safer offering or a different God',
      reasonMetrics: { hp: round.health, hpCost: round.godOfferingHpCost },
      coaching_text: `At ${round.health} HP you accepted an Evelynn offering that costs ${round.godOfferingHpCost} HP. Stage 4 fights deal 7–18 damage per loss — at ${round.health - round.godOfferingHpCost} HP after the offering, one bad fight can eliminate you. Evelynn is designed for players who are ahead on HP and can afford to trade it for power. At sub-40 HP, the risk-reward is inverted.`,
    });
  }
  return points;
}

// SET17_003 — warning fired after 3-4 if still not aligned (4-4 is last chance)
function checkAlignmentLockedOut(match: MatchSnapshot): DecisionPoint[] {
  // Only fire if we have both 2-4 and 3-4 picks but not yet 4-4.
  const after34 = match.godPicks.filter(p => p.round === '2-4' || p.round === '3-4');
  const has44   = match.godPicks.some(p => p.round === '4-4');
  if (after34.length < 2 || has44) return []; // not in the warning window

  const counts: Record<string, number> = {};
  for (const { god } of after34) {
    if (god === PENGU) continue;
    counts[god] = (counts[god] ?? 0) + 1;
  }

  const maxCount = Math.max(0, ...Object.values(counts));
  if (maxCount >= 2) return []; // already aligned

  // Best alignment candidate (the god picked most, or any if tied).
  const bestGod = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'the same God';
  const picksFormatted = after34.map(p => `${p.round}: ${p.god}`).join(', ');

  return [{
    ruleId:   'SET17_003',
    round:    '4-4',
    category: 'set_mechanic',
    severity: 'moderate',
    observed: `Not aligned after stage 3-4 — picks so far: ${picksFormatted}`,
    recommended: `At round 4-4 (your last chance), pick ${bestGod} to achieve alignment and unlock the 4-7 Blessing`,
    reasonMetrics: { maxCount, picksAfter34: after34.length },
    coaching_text: `After two God rounds (${picksFormatted}) you still haven't picked the same god twice. Round 4-4 is your absolute last chance to align — choose ${bestGod} at that round to unlock the God Blessing at 4-7. If you switch gods again at 4-4, you forfeit the Blessing entirely for this game.`,
  }];
}
