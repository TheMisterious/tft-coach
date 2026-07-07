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
    recommended: 'Build a functional 2-star core before stage 3 to reduce early HP bleed',
    reasonMetrics: { hpLost, hpStart: at21.health, hpEnd: at31.health },
    coaching_text: `You lost ${hpLost} HP during stage 2 — significantly above the 15 HP benchmark for a functional opener. Stage 2 base damage is only 2 + surviving enemy units, so heavy losses here indicate multiple fights where opponents had a clear board-power advantage. Review your stage-2 unit placement, trait activations, and whether key synergy units were available in the shop.`,
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
    recommended: 'Stabilise before stage 4 — roll down at 3-2 or 3-5 if HP is under pressure',
    reasonMetrics: { hp: at41.health, hpLostStage3 },
    coaching_text: `You entered stage 4 at ${at41.health} HP — below the 60 HP danger threshold. Stage 4 base damage is 7 + surviving enemy units; three moderate losses from here can eliminate you. You lost ${hpLostStage3} HP in stage 3, which points to a board that was not stabilised by the 3-2 or 3-5 windows. Rolling to 2-star the carry during stage 3 is the correct response to this HP level.`,
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
    recommended: 'Stabilisation at 4-1/4-2 was the last viable window — rolling down there prevents this outcome',
    reasonMetrics: { hp: at51.health, hpLostStage4 },
    coaching_text: `You entered stage 5 at ${at51.health} HP. Stage 5 base damage is 10 + surviving enemies — a single full loss can eliminate you from this position. You lost ${hpLostStage4} HP in stage 4, meaning the board was not stabilised at the 4-1/4-2 window. This level of HP entering stage 5 usually leads to 7th or 8th place regardless of board strength; preventing it requires earlier rolling.`,
  }];
}
