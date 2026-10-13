// HP_001: Stage 2 excessive HP bleed (>15 HP lost)
// HP_002: Stage 3 critical threshold — below 60 HP entering stage 4
// HP_003: Stage 5 lethal zone — at or below 25 HP entering stage 5

import type { MatchSnapshot, DecisionPoint } from '../../shared/types';

export function checkHp(match: MatchSnapshot): DecisionPoint[] {
  return [
    ...checkStage2Bleed(match),
    ...checkStage3Threshold(match),
    ...checkStage5Lethal(match),
  ];
}

// HP_001
function checkStage2Bleed(match: MatchSnapshot): DecisionPoint[] {
  const at21 = match.rounds.find(r => r.label === '2-1');
  const at31 = match.rounds.find(r => r.label === '3-1');
  if (!at21 || !at31) return [];

  const hpLost = at21.health - at31.health;
  if (hpLost <= 15) return [];

  return [{
    ruleId:   'HP_001',
    round:    '3-1',
    category: 'hp',
    severity: hpLost > 25 ? 'critical' : 'moderate',
    observed: `Lost ${hpLost} HP during stage 2 (from ${at21.health} to ${at31.health} HP)`,
    recommended: 'If this HP was not traded for a planned loss streak, a stronger opener (pairs into 2-stars, an active trait) is the usual way to cut stage 2 losses',
    reasonMetrics: { hpLost, hpStart: at21.health, hpEnd: at31.health },
    coaching_text: `You lost ${hpLost} HP during stage 2, more than the 15 HP a typical opener gives up. A stage 2 loss costs only 2 plus each surviving enemy, so this many points usually means several fights against clearly stronger boards. That can be deliberate: a loss streak trades exactly this HP for streak gold. The stage 2 observations show the gold and the shops you had; compare them with what you were going for.`,
  }];
}

// HP_002
function checkStage3Threshold(match: MatchSnapshot): DecisionPoint[] {
  const at31 = match.rounds.find(r => r.label === '3-1');
  const at41 = match.rounds.find(r => r.label === '4-1');
  if (!at41 || at41.health >= 60) return [];

  const hpLostStage3 = at31 ? at31.health - at41.health : 0;

  return [{
    ruleId:   'HP_002',
    round:    '4-1',
    category: 'hp',
    severity: at41.health < 40 ? 'critical' : 'moderate',
    observed: `Entered stage 4 at ${at41.health} HP (safe zone is 60+)`,
    recommended: 'If this HP was not a planned trade for gold, a roll-down at 3-2 or 3-5 is the usual way to stop the bleed before stage 4',
    reasonMetrics: { hp: at41.health, hpLostStage3 },
    coaching_text: `You entered stage 4 at ${at41.health} HP, under the 60 HP mark where losses start to decide games. A stage 4 loss costs 7 plus each surviving enemy, so a few more from here can end it. You lost ${hpLostStage3} HP in stage 3. Whether that was a mistake depends on what it bought: banked gold for a planned roll-down is a trade, an empty bank and a weak board is not. The stage 3 observations show which one this was.`,
  }];
}

// HP_003
function checkStage5Lethal(match: MatchSnapshot): DecisionPoint[] {
  const at41 = match.rounds.find(r => r.label === '4-1');
  const at51 = match.rounds.find(r => r.label === '5-1');
  if (!at51 || at51.health > 25) return [];

  const hpLostStage4 = at41 ? at41.health - at51.health : 0;

  return [{
    ruleId:   'HP_003',
    round:    '5-1',
    category: 'hp',
    severity: 'critical',
    observed: `Entered stage 5 at ${at51.health} HP — lethal range (≤25 HP)`,
    recommended: 'If gold was banked through stage 4, spending it at 4-1 or 4-2 is the usual way to protect HP this low',
    reasonMetrics: { hp: at51.health, hpLostStage4 },
    coaching_text: `You entered stage 5 at ${at51.health} HP. A stage 5 loss costs 10 plus each surviving enemy, so one full loss can end the game from here. You lost ${hpLostStage4} HP in stage 4. In the audited games this checkpoint is one of the clearest signs of a low finish, but it records where the game stood, not which stage 4 decision led here; the observations show what you did in that stage.`,
  }];
}
