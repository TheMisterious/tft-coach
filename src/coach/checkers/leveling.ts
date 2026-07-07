// LEVEL_001: Late level 6 — not at 6 by 3-2
// LEVEL_002: Late level 7 — not at 7 by 4-1
// LEVEL_003: Fast 8 delay — not at 8 by 4-2 despite having the gold
// LEVEL_005: Late level 9 — not at 9 by 5-2 with gold ≥40 and HP ≥30

import type { MatchSnapshot, DecisionPoint, RoundSnapshot } from '../../shared/types';

function byGold(gold: number, t: { rich: string; mid: string; broke: string }): string {
  if (gold >= 40) return t.rich;
  if (gold >= 20) return t.mid;
  return t.broke;
}

export function checkLeveling(match: MatchSnapshot): DecisionPoint[] {
  return [
    ...checkLevel6(match),
    ...checkLevel7(match),
    ...checkLevel8(match),
    ...checkLevel9(match),
    ...checkNakedLevel(match),
  ];
}

function snapAt(match: MatchSnapshot, label: string): RoundSnapshot | undefined {
  return match.rounds.find(r => r.label === label);
}

// LEVEL_001
function checkLevel6(match: MatchSnapshot): DecisionPoint[] {
  const r = snapAt(match, '3-2');
  if (!r || r.level >= 6) return [];
  return [{
    ruleId:   'LEVEL_001',
    round:    '3-2',
    category: 'leveling',
    severity: r.level <= 4 ? 'critical' : 'moderate',
    observed: `Level ${r.level} at 3-2 — standard target is 6`,
    recommended: 'Reach level 6 by round 3-2 to unlock the 6th board slot and better shop odds',
    reasonMetrics: { actual: r.level, target: 6, gold: r.goldEnd },
    coaching_text: byGold(r.goldEnd, {
      rich:  `You were level ${r.level} at 3-2 with ${r.goldEnd}g on hand — there was no gold reason to delay level 6. Level 6 opens a 6th board slot and improves 2-cost odds; skipping the XP buy here was a pure tempo loss.`,
      mid:   `You were level ${r.level} at 3-2 with ${r.goldEnd}g — enough to buy XP toward level 6. Reaching 6 by 3-2 opens your 6th board slot and keeps you on par with the lobby's tempo; staying at ${r.level} costs you a full stage of sub-optimal board size.`,
      broke: `You were level ${r.level} at 3-2 with only ${r.goldEnd}g — the gold was genuinely tight. Still, level 6 is worth prioritising over a single roll; consider econ'ing more aggressively in stage 2 to have XP budget by this checkpoint.`,
    }),
  }];
}

// LEVEL_002
function checkLevel7(match: MatchSnapshot): DecisionPoint[] {
  const r = snapAt(match, '4-1');
  if (!r || r.level >= 7) return [];
  return [{
    ruleId:   'LEVEL_002',
    round:    '4-1',
    category: 'leveling',
    severity: 'critical',
    observed: `Level ${r.level} at 4-1 — standard target is 7`,
    recommended: 'Reach level 7 by round 4-1; XP purchases in stage 3 should cover the gap',
    reasonMetrics: { actual: r.level, target: 7, gold: r.goldEnd },
    coaching_text: byGold(r.goldEnd, {
      rich:  `Level ${r.level} at 4-1 with ${r.goldEnd}g — the gold to reach level 7 was there but the XP wasn't purchased. Level 7 jumps 3-cost odds to 40%; every fight you play at level ${r.level} instead is a fight with a weaker shop ceiling.`,
      mid:   `Level ${r.level} at 4-1 with ${r.goldEnd}g. Buying XP in stage 3 would have covered the gap to level 7 by now. At level 7 your shop hits 40% 3-cost — the core stabilisation tier. The missed XP purchases in stage 3 are what put you behind this checkpoint.`,
      broke: `Level ${r.level} at 4-1 with only ${r.goldEnd}g. Gold was stretched, but stage-3 XP is usually worth cutting a roll for. Missing level 7 by 4-1 means every stage-3 fight was played with worse shop odds than the lobby average.`,
    }),
  }];
}

// LEVEL_003 — flag only if player had ≥50g at 4-1 (had the resources)
function checkLevel8(match: MatchSnapshot): DecisionPoint[] {
  const at41 = snapAt(match, '4-1');
  const at42 = snapAt(match, '4-2');
  if (!at42 || at42.level >= 8) return [];
  if (!at41 || at41.goldEnd < 50) return []; // not enough gold to flag
  return [{
    ruleId:   'LEVEL_003',
    round:    '4-2',
    category: 'leveling',
    severity: 'moderate',
    observed: `Level ${at42.level} at 4-2 despite ${at41.goldEnd}g available at 4-1`,
    recommended: 'With 50g+ at 4-1, prioritise XP to hit level 8 by 4-2 — 4-cost odds jump to 30% at level 8',
    reasonMetrics: { actual: at42.level, target: 8, goldAt41: at41.goldEnd },
    coaching_text: `You had ${at41.goldEnd}g at 4-1 but were only level ${at42.level} at 4-2. With those resources the standard Fast-8 line was available: buy XP at 4-1 to reach level 8, then roll. Level 8 gives 30% 4-cost odds vs. 10% at level 7 — a massive hit-rate improvement for late-game carries.`,
  }];
}

// LEVEL_005
function checkLevel9(match: MatchSnapshot): DecisionPoint[] {
  const at51 = snapAt(match, '5-1');
  const at52 = snapAt(match, '5-2');
  if (!at52 || at52.level >= 9) return [];
  if (!at51) return [];
  if (at51.goldEnd < 40 || at51.health < 30) return []; // lacked resources/HP
  return [{
    ruleId:   'LEVEL_005',
    round:    '5-2',
    category: 'leveling',
    severity: 'moderate',
    observed: `Level ${at52.level} at 5-2 with ${at51.goldEnd}g and ${at51.health} HP available`,
    recommended: 'Push to level 9 at stage 5 when HP is stable — adds 15% 5-cost odds per slot',
    reasonMetrics: { actual: at52.level, target: 9, goldAt51: at51.goldEnd, hpAt51: at51.health },
    coaching_text: `You had ${at51.goldEnd}g and ${at51.health} HP at 5-1 but were still level ${at52.level} at 5-2. Level 9 adds 15% 5-cost odds and 33% 4-cost odds — with a stable board, pushing to 9 is the correct ceiling investment. The resources were present; the decision to hold blocked your board from reaching its maximum power.`,
  }];
}

// Naked level: buying XP with <10g remaining and <3 two-star units (unchanged heuristic)
function checkNakedLevel(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  for (const round of match.rounds) {
    if (!round.xpBought) continue;
    const twoStars = Object.values(round.board).filter(c => c.level >= 2).length;
    if (round.goldEnd < 10 && twoStars < 3) {
      points.push({
        ruleId:   'LEVEL_004',
        round:    round.label,
        category: 'leveling',
        severity: 'moderate',
        observed: `Bought XP at ${round.label} with only ${round.goldEnd}g left and ${twoStars} two-star unit(s)`,
        recommended: 'Only buy XP when you have 10g+ remaining or a stable 2-starred core',
        reasonMetrics: { goldAfter: round.goldEnd, twoStars },
        coaching_text: `Leveling at ${round.label} left you with only ${round.goldEnd}g and a board with ${twoStars} two-star unit(s). That's not enough cushion to respond if you lose the next fight. Save XP purchases for when you have a 10g+ buffer or a stable 2-starred core to justify the power spike.`,
      });
    }
  }
  return points;
}
