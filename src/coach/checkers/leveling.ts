// LEVEL_001: Late level 6 — not at 6 by 3-2
// LEVEL_002: Late level 7 — not at 7 by 4-1
// LEVEL_003: Fast 8 delay — not at 8 by 4-2 despite having the gold
// LEVEL_005: Late level 9 — not at 9 by 5-2 with gold ≥40 and HP ≥30
// LEVEL_006: Streak-adjusted level targets — a real win/lose streak shifts
// the standard checkpoints earlier (source: community rolldown-theory guides,
// see rolling.ts's ROLL_004/005 for the same research pass). A 3+ win streak
// should hit level 6 by 3-1 (one round earlier than the generic 3-2 target);
// a 3+ loss streak should hit level 8 by 4-1 (one round earlier than the
// generic 4-2 target) since a losing board needs its power spike sooner, not
// later. The loss-streak check only fires at exactly level 7 at 4-1 — below
// 7 is already caught by LEVEL_002's generic target, and duplicating that
// observation as a second card would just repeat it (see rule-engine.ts's
// ECON_001/ECON_004 merge for the same "don't double-report one shortfall"
// principle applied there).

import type { MatchSnapshot, DecisionPoint, RoundSnapshot } from '../../shared/types';
import { boardUnits } from '../../ledger/merge';

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
    ...checkStreakAdjustedLevel(match),
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
    recommended: 'Unless the gold was saved for a planned roll or streak, level 6 by 3-2 is the usual target — it adds a 6th board slot and better 2-cost odds',
    reasonMetrics: { actual: r.level, target: 6, gold: r.goldEnd },
    coaching_text: byGold(r.goldEnd, {
      rich:  `You were level ${r.level} at 3-2 with ${r.goldEnd}g on hand, so gold was not what held level 6 back. Level 6 adds a board slot and better 2-cost odds. Consider buying it here unless that gold was set aside for a specific roll or a streak.`,
      mid:   `You were level ${r.level} at 3-2 with ${r.goldEnd}g, enough to buy XP toward level 6. The usual line reaches 6 here for the extra board slot; staying at ${r.level} plays the next rounds one unit down, which pays off only if that gold buys something specific soon.`,
      broke: `You were level ${r.level} at 3-2 with only ${r.goldEnd}g, so gold was genuinely tight. If level 6 by 3-2 fits your plan, holding more gold through stage 2 is the usual way to have the XP budget at this checkpoint.`,
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
    recommended: 'Unless you are rerolling at a lower level, level 7 by 4-1 is the usual target; XP bought in stage 3 usually covers the gap',
    reasonMetrics: { actual: r.level, target: 7, gold: r.goldEnd },
    coaching_text: byGold(r.goldEnd, {
      rich:  `Level ${r.level} at 4-1 with ${r.goldEnd}g: the gold for level 7 was there, but the XP was not bought. Level 7 lifts 3-cost odds to 40%. Unless you were rerolling at this level on purpose, consider buying the level before rolling or holding.`,
      mid:   `Level ${r.level} at 4-1 with ${r.goldEnd}g. XP bought in stage 3 usually reaches level 7 by now, where the shop shows 40% 3-costs. If you were not rerolling at this level on purpose, stage 3's XP is the place to look.`,
      broke: `Level ${r.level} at 4-1 with only ${r.goldEnd}g. Gold was stretched; stage 3 XP is usually worth more than a roll at that point, unless the rolls were for a reroll comp you had already committed to.`,
    }),
  }];
}

// LEVEL_003 — flag only if player had ≥50g at 4-1 AND HP to spare (had the
// resources AND leveling, not rolling for board survival, was the correct
// priority). Mirrors the HP guard LEVEL_005 already applies.
function checkLevel8(match: MatchSnapshot): DecisionPoint[] {
  const at41 = snapAt(match, '4-1');
  const at42 = snapAt(match, '4-2');
  if (!at42 || at42.level >= 8) return [];
  if (!at41 || at41.goldEnd < 50) return []; // not enough gold to flag
  if (at41.health < 30) return []; // HP crisis — rolling for board survival outranks leveling
  return [{
    ruleId:   'LEVEL_003',
    round:    '4-2',
    category: 'leveling',
    severity: 'moderate',
    observed: `Level ${at42.level} at 4-2 despite ${at41.goldEnd}g available at 4-1`,
    recommended: 'With 50g+ and HP to spare at 4-1, level 8 by 4-2 is the usual fast-8 line — 4-cost odds rise to 30% at level 8',
    reasonMetrics: { actual: at42.level, target: 8, goldAt41: at41.goldEnd },
    coaching_text: `You had ${at41.goldEnd}g at 4-1 but were level ${at42.level} at 4-2. With that bank and HP to spare, the usual fast-8 line buys XP at 4-1 to reach level 8, then rolls: level 8 shows 4-costs at 30%, against 10% at level 7. Holding at 7 fits a 3-cost reroll; otherwise level 8 here is worth considering.`,
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
    recommended: 'With 40g+ and stable HP at stage 5, level 9 is the usual next step — it adds 15% 5-cost odds per slot',
    reasonMetrics: { actual: at52.level, target: 9, goldAt51: at51.goldEnd, hpAt51: at51.health },
    coaching_text: `You had ${at51.goldEnd}g and ${at51.health} HP at 5-1 but were still level ${at52.level} at 5-2. Level 9 adds 15% 5-cost and 33% 4-cost odds. With a stable board, the usual answer is to push to 9, unless the board was already complete at 8 or the gold was needed for a key upgrade.`,
  }];
}

// Naked level: buying XP with <10g remaining and <3 two-star units (unchanged heuristic)
function checkNakedLevel(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  for (const round of match.rounds) {
    if (!round.xpBought) continue;
    const twoStars = boardUnits(round.board).filter(c => c.level >= 2).length;
    if (round.goldEnd < 10 && twoStars < 3) {
      points.push({
        ruleId:   'LEVEL_004',
        round:    round.label,
        category: 'leveling',
        severity: 'moderate',
        observed: `Bought XP at ${round.label} with only ${round.goldEnd}g left and ${twoStars} two-star unit(s)`,
        recommended: 'XP with under 10g left and few 2-stars is usually saved for when there is a 10g buffer or a stable 2-starred core',
        reasonMetrics: { goldAfter: round.goldEnd, twoStars },
        coaching_text: `Leveling at ${round.label} left you with ${round.goldEnd}g and ${twoStars} two-star unit(s), so there was little to respond with if the next fight went badly. A 10g+ buffer or a stable 2-starred core is the usual condition for this buy, unless the level unlocked an upgrade you were about to hit.`,
      });
    }
  }
  return points;
}

// LEVEL_006 — streak-adjusted level targets (see file header comment).
// STREAK_COUNT_THRESHOLD reuses the same "3+" bar STREAK_001 already treats
// as a real, established streak (not a fresh coincidence), rather than
// inventing a new threshold for this rule.
const STREAK_COUNT_THRESHOLD = 3;

function checkStreakAdjustedLevel(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  const winCheck = snapAt(match, '3-1');
  if (winCheck && winCheck.streakType === 'win' && winCheck.streakCount >= STREAK_COUNT_THRESHOLD && winCheck.level < 6) {
    points.push({
      ruleId:   'LEVEL_006',
      round:    '3-1',
      category: 'leveling',
      severity: 'moderate',
      observed: `On a ${winCheck.streakCount}-win streak but still level ${winCheck.level} at 3-1 — streak-adjusted target is 6`,
      recommended: 'On a real win streak, level 6 by 3-1 (a round before the usual 3-2) is a common way to press the lead',
      reasonMetrics: { actual: winCheck.level, target: 6, streakCount: winCheck.streakCount },
      coaching_text: `You were on a ${winCheck.streakCount}-win streak at 3-1 but still level ${winCheck.level}. A win streak brings extra gold and an HP cushion, and a common line spends some of it on level 6 a round early (3-1, not 3-2) to keep the streak going. Banking instead can be right when the gold is meant for a bigger level or roll soon after.`,
    });
  }

  const loseCheck = snapAt(match, '4-1');
  if (loseCheck && loseCheck.streakType === 'loss' && loseCheck.streakCount >= STREAK_COUNT_THRESHOLD && loseCheck.level === 7) {
    points.push({
      ruleId:   'LEVEL_006',
      round:    '4-1',
      category: 'leveling',
      severity: 'moderate',
      observed: `On a ${loseCheck.streakCount}-loss streak but still level 7 at 4-1 — streak-adjusted target is 8`,
      recommended: 'On a real loss streak, level 8 by 4-1 (a round before the usual 4-2) is a common way to bring the power spike forward',
      reasonMetrics: { actual: loseCheck.level, target: 8, streakCount: loseCheck.streakCount },
      coaching_text: `You were on a ${loseCheck.streakCount}-loss streak at 4-1, level 7. That meets the usual level 7 target, but a common line on a loss streak reaches level 8 a round early, so the power spike lands before the streak costs more HP. Staying at 7 fits a 3-cost reroll; otherwise level 8 here is worth considering.`,
    });
  }

  return points;
}
