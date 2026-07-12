// ROLL_001: Over-rolling at wrong level for carry cost tier
// ROLL_002: Under-rolling at stabilization window (HP <40 at 4-1, <20g rolled)
// ROLL_003: Post-stabilization over-roll after board is complete
// ROLL_004: Fast-8 lose-streak discipline broken — rolled at level 6 while on
//           a real, healthy loss streak instead of banking for the level-8 push
// ROLL_005: Slow-roll gold floor violation — dropped below the 50g interest
//           cap for 3+ consecutive rounds while running a reroll comp
//
// ROLL_004/005 source: community rolldown-theory guides (Boosteria's economy
// guide, BunnyMuffins' leveling guide) researched 2026-07-12 — "if you plan
// to Fast 8, you should not roll down at all at level 6 and continue to
// commit to your lose streak" and "Slow Roll is rolling gold little by
// little while staying above 50 to maximize interest." Both community-
// derived guidelines, not official mechanics — confidence: medium, same as
// ROLL_003.

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
    ...checkFast8RollDiscipline(match, context),
    ...checkSlowRollFloorViolation(match, context),
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

// ROLL_004 — rolling at level 6 while on a real (3+), non-crisis loss streak.
// Committing to a loss streak toward Fast 8 only pays off if the gold
// actually gets banked for the level-8 push — rolling it away at level 6
// undercuts the plan currently in progress. Excludes HP-crisis rounds
// (context.hpCrisisRounds) since rolling to survive there is the correct
// call regardless of streak (same guard checkPostStabilizationRoll's reroll
// exclusion and rule-engine.ts's HOLD_GOLD_RULES use). Fires once per fresh
// streak episode, not every qualifying round, to avoid repeating the same
// observation across a multi-round streak.
function checkFast8RollDiscipline(match: MatchSnapshot, context: MatchContext): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  let firedThisEpisode = false;

  for (const round of match.rounds) {
    const inEpisode = round.level === 6
      && round.streakType === 'loss'
      && round.streakCount >= 3
      && !context.hpCrisisRounds.has(round.label);

    if (!inEpisode) { firedThisEpisode = false; continue; }
    if (firedThisEpisode) continue;

    const goldRolled = round.rollsSpent * 2;
    if (goldRolled < 8) continue;

    firedThisEpisode = true;
    points.push({
      ruleId:   'ROLL_004',
      round:    round.label,
      category: 'rolling',
      severity: 'moderate',
      observed: `Spent ${goldRolled}g rolling at level 6 while on a healthy ${round.streakCount}-loss streak`,
      recommended: 'On a deliberate loss streak toward Fast 8, hold rolls at level 6 — bank the gold for the level-8 push instead',
      reasonMetrics: { goldRolled, streakCount: round.streakCount, level: round.level },
      coaching_text: `You spent ${goldRolled}g rolling at level 6 while ${round.streakCount} rounds into a loss streak. A loss streak at healthy HP is usually a deliberate Fast-8 setup — the streak funds the level-8 push, and rolling that gold away at level 6 undercuts the exact plan already in motion. Hold rolls here and commit the gold to leveling instead.`,
    });
  }

  return points;
}

// ROLL_005 — dropped below the 50g interest cap for 3+ consecutive rounds
// while running a detected reroll comp (context.isRerollComp). A real
// slow-roll keeps gold above 50g and spends only the excess each round —
// dropping below the cap loses interest without actually committing to a
// full hyper-roll dump, the "worst of both worlds" the source guide warns
// against. Only evaluated from stage 3 on, since a reroll line's econ
// discipline isn't meaningfully established before then.
function checkSlowRollFloorViolation(match: MatchSnapshot, context: MatchContext): DecisionPoint[] {
  if (!context.isRerollComp) return [];
  const points: DecisionPoint[] = [];
  let streak = 0;
  let streakStart = '';

  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-');
    if (Number(stageStr) < 3) continue;

    if (round.goldEnd < 50) {
      if (streak === 0) streakStart = round.label;
      streak++;
    } else {
      streak = 0;
    }

    if (streak === 3) {
      const compName = context.matchedComp?.name ?? 'your reroll comp';
      points.push({
        ruleId:   'ROLL_005',
        round:    round.label,
        category: 'rolling',
        severity: 'minor',
        observed: `Held below the 50g interest cap for ${streak} consecutive rounds (since ${streakStart}) while running ${compName}`,
        recommended: 'Slow-roll discipline means staying above 50g and spending only the excess each round — rebuild the buffer before rolling more',
        reasonMetrics: { streak, streakStartRound: streakStart, goldEnd: round.goldEnd },
        coaching_text: `You were below the 50g interest cap for ${streak} consecutive rounds (starting ${streakStart}) while playing ${compName}. A real slow roll stays above 50g, spending only the excess above the cap each round — dipping below it for multiple rounds running loses interest income without actually committing to a full rolldown. Rebuild the buffer to 50g+ before rolling further.`,
      });
      streak = 0;
    }
  }

  return points;
}
