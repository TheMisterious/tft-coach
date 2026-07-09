// ROLL_001: Over-rolling at wrong level for carry cost tier
// ROLL_002: Under-rolling at stabilization window (HP <40 at 4-1, <20g rolled)
// ROLL_003: Post-stabilization over-roll after board is complete

import type { MatchSnapshot, DecisionPoint, RoundSnapshot, MetaData, MatchContext } from '../../shared/types';
import { NEUTRAL_CONTEXT } from '../match-context';
import { identifyCarry } from '../../ledger/merge';

// Shop odds indexed by [carry_cost - 1][level - 1] (levels 1-10, costs 1-5).
// Source: lolchess.gg/guide/reroll, Set 17.
const SHOP_ODDS: number[][] = [
  [100,100, 75, 55, 45, 30, 19, 15, 10,  5], // 1-cost
  [  0,  0, 25, 30, 33, 40, 30, 20, 17, 10], // 2-cost
  [  0,  0,  0, 15, 20, 25, 40, 32, 25, 20], // 3-cost
  [  0,  0,  0,  0,  2,  5, 10, 30, 33, 40], // 4-cost
  [  0,  0,  0,  0,  0,  0,  1,  3, 15, 25], // 5-cost
];

function oddsAt(level: number, cost: number): number {
  const costIdx  = Math.min(Math.max(cost - 1, 0), 4);
  const levelIdx = Math.min(Math.max(level - 1, 0), 9);
  return SHOP_ODDS[costIdx][levelIdx];
}

// Infer most likely carry cost, using meta for both role-aware carry
// identification (see ledger/merge.ts) and tier lookup.
function inferCarryCost(round: RoundSnapshot, meta: MetaData): number {
  const units = Object.values(round.board).filter(c => c?.name && c.name !== '0');
  if (units.length === 0) return 3;
  const carry = identifyCarry(units, meta);
  return meta.champions[carry.name]?.tier ?? 3;
}

export function checkRolling(
  match: MatchSnapshot,
  meta: MetaData,
  context: MatchContext = NEUTRAL_CONTEXT
): DecisionPoint[] {
  return [
    ...checkOverRollBadOdds(match, meta, context),
    ...checkUnderRollCrisis(match),
    ...checkPostStabilizationRoll(match, context),
  ];
}

// ROLL_001 — heavy rolling (>15g) at a level where carry odds ≤10%. Suppressed
// for a detected reroll archetype: a real reroll line intentionally sits at a
// fixed low level rolling for its (cheap) target, and inferCarryCost's "most
// itemised unit" heuristic is unreliable mid-reroll before items are slammed.
function checkOverRollBadOdds(match: MatchSnapshot, meta: MetaData, context: MatchContext): DecisionPoint[] {
  if (context.isRerollComp) return [];
  const points: DecisionPoint[] = [];
  for (const round of match.rounds) {
    const goldRolled = round.rollsSpent * 2;
    if (goldRolled <= 15) continue;
    const cost  = inferCarryCost(round, meta);
    const odds  = oddsAt(round.level, cost);
    if (odds > 10) continue;

    // Find the level where odds would cross 15% for this cost.
    let targetLevel = round.level;
    for (let lv = round.level + 1; lv <= 10; lv++) {
      if (oddsAt(lv, cost) >= 15) { targetLevel = lv; break; }
    }

    points.push({
      ruleId:   'ROLL_001',
      round:    round.label,
      category: 'rolling',
      severity: 'critical',
      observed: `Spent ${goldRolled}g rolling at level ${round.level} for ${cost}-cost units (${odds}% odds per slot)`,
      recommended: `Level to ${targetLevel} first — odds jump to ${oddsAt(targetLevel, cost)}% per slot`,
      reasonMetrics: { goldRolled, level: round.level, cost, odds, targetLevel },
      coaching_text: `You spent ${goldRolled}g rolling at level ${round.level}, but ${cost}-cost units only appear ${odds}% of the time per shop slot at that level. That is extremely inefficient — you expect to see roughly ${(5 * odds / 100 * (goldRolled / 2)).toFixed(1)} copies from ${goldRolled / 2} rolls. Leveling to ${targetLevel} first would give ${oddsAt(targetLevel, cost)}% odds per slot, making each roll dramatically more likely to hit.`,
    });
  }
  return points;
}

// ROLL_002 — under-rolling when entering stage 4 low HP
function checkUnderRollCrisis(match: MatchSnapshot): DecisionPoint[] {
  const at41 = match.rounds.find(r => r.label === '4-1');
  const at42 = match.rounds.find(r => r.label === '4-2');
  if (!at41 || at41.health >= 40) return [];

  const rollSpend = ((at41.rollsSpent ?? 0) + (at42?.rollsSpent ?? 0)) * 2;
  if (rollSpend >= 20) return [];

  const carries2star = Object.values(at42?.board ?? at41.board)
    .filter(c => c?.level >= 2 && [c.item_1, c.item_2, c.item_3].some(i => i && i !== '0'))
    .length;

  if (carries2star >= 1) return [];

  return [{
    ruleId:   'ROLL_002',
    round:    '4-1',
    category: 'rolling',
    severity: 'critical',
    observed: `${at41.health} HP entering stage 4, only ${rollSpend}g spent rolling at 4-1/4-2`,
    recommended: 'At <40 HP entering stage 4, spend 20–40g rolling down to 2-star your carry and stabilise',
    reasonMetrics: { hp: at41.health, rollSpend, goldAvailable: at41.goldEnd },
    coaching_text: `You entered stage 4 at ${at41.health} HP and spent only ${rollSpend}g stabilising across rounds 4-1 and 4-2. With ${at41.goldEnd}g available and no itemised 2-star carry, the correct play was to roll down immediately. Each fight you lose at this HP brings you closer to elimination — board strength, not econ, should have been the priority here.`,
  }];
}

// ROLL_003 — rolling >20g in a round 2+ rounds after board stabilisation, no
// 3-star result. Suppressed for a detected reroll archetype: continuing to
// roll after the carry hits 2-star, hunting for a 3-star, IS the reroll
// strategy — it routinely takes many rounds of rolling per 3-star, so
// penalising "no 3-star result this round" would flag correct reroll play as
// a mistake on nearly every round of the game.
function checkPostStabilizationRoll(match: MatchSnapshot, context: MatchContext): DecisionPoint[] {
  if (context.isRerollComp) return [];
  const rounds = match.rounds;

  // Find stabilisation round: first round where ≥2 item-bearing units are 2-star.
  let stabilisedIdx = -1;
  for (let i = 0; i < rounds.length; i++) {
    const itemCarriers2star = Object.values(rounds[i].board).filter(
      c => c?.level >= 2 && [c.item_1, c.item_2, c.item_3].some(j => j && j !== '0')
    ).length;
    if (itemCarriers2star >= 2) { stabilisedIdx = i; break; }
  }
  if (stabilisedIdx < 0) return [];

  const points: DecisionPoint[] = [];
  let totalWaste = 0;
  let wasteRounds = 0;

  for (let i = stabilisedIdx + 2; i < rounds.length; i++) {
    const r = rounds[i];
    const gold = r.rollsSpent * 2;
    if (gold <= 20) continue;

    // No new 3-star unit appeared this round.
    const new3star = Object.values(r.board).some(c => c?.level >= 3) &&
      !Object.values(rounds[i - 1]?.board ?? {}).some(c => c?.level >= 3);
    if (new3star) continue;

    totalWaste += gold;
    wasteRounds++;
  }

  if (wasteRounds === 0) return [];

  return [{
    ruleId:   'ROLL_003',
    round:    rounds[stabilisedIdx].label,
    category: 'rolling',
    severity: 'moderate',
    observed: `${totalWaste}g spent rolling across ${wasteRounds} round(s) after board stabilisation with no 3-star result`,
    recommended: 'After the carry is 2-starred, save gold toward level 9 rather than continuing to roll',
    reasonMetrics: { totalWaste, wasteRounds, stabilisedRound: rounds[stabilisedIdx].label },
    coaching_text: `After your board stabilised you spent ${totalWaste}g rolling across ${wasteRounds} round(s) without completing a 3-star. Once the carry is 2-starred, additional rolls have diminishing returns — that gold was better saved toward pushing level 9 (which adds 15% 5-cost odds) or competing for a contested unit more efficiently at a higher level.`,
  }];
}
