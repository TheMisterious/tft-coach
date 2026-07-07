// Augment checker
//
// GEP captures picks only — not what was offered — so we can only reason about
// what was chosen, never what was passed.
//
// AUGMENT_001: Economy augment chosen while critically low HP (<45) at pick round
// AUGMENT_002: No augment data at all by stage 4 in a bottom-4 finish (data gap warning)

import type { MatchSnapshot, DecisionPoint, RoundSnapshot, MetaData } from '../../shared/types';
import { getAugmentName } from '../../enrichment/meta-lookup';

const AUGMENT_PICK_ROUNDS = ['2-1', '3-2', '4-2'];

const HP_CRISIS_THRESHOLD = 45;

export function checkAugments(match: MatchSnapshot, meta: MetaData = {} as MetaData): DecisionPoint[] {
  return [
    ...checkEconAugmentOnCrisis(match, meta),
    ...checkMissingAugmentData(match),
  ];
}

// AUGMENT_001 — picked an econ augment when already bleeding HP
function checkEconAugmentOnCrisis(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const economyAugments = new Set(meta.augments?.economy ?? []);

  for (let i = 0; i < match.rounds.length; i++) {
    const round = match.rounds[i];
    if (!AUGMENT_PICK_ROUNDS.includes(round.label)) continue;

    const prev     = match.rounds[i - 1];
    const prevSet  = new Set(prev?.augmentsPicked ?? []);
    const newAugs  = round.augmentsPicked.filter(a => !prevSet.has(a));

    for (const aug of newAugs) {
      if (!economyAugments.has(aug)) continue;
      if (round.health >= HP_CRISIS_THRESHOLD) continue;

      const shortName = getAugmentName(aug, meta);

      points.push({
        ruleId:   'AUGMENT_001',
        round:    round.label,
        category: 'augments',
        severity: round.health < 30 ? 'critical' : 'moderate',
        observed: `Picked economy augment ${shortName} at ${round.health} HP`,
        recommended: 'Below 45 HP, prioritise combat or item augments — econ augments pay off over time, but you may not have time',
        reasonMetrics: { augment: shortName, hp: round.health },
        coaching_text: byHp(round, {
          low: `At only ${round.health} HP you chose ${shortName}, an economy augment. Economy augments compound over many rounds — but at ${round.health} HP you are likely to be eliminated before that income materialises. A combat augment here would have added immediate board strength when you needed it most.`,
          mid: `You picked ${shortName} (econ augment) at ${round.health} HP — below the safe threshold. Econ augments are correct when you're healthy and econ'ing; at ${round.health} HP the priority shifts toward stabilising your board with a combat or item augment.`,
        }),
      });
    }
  }

  return points;
}

// AUGMENT_002 — no augment data recorded in a bottom-4 finish
function checkMissingAugmentData(match: MatchSnapshot): DecisionPoint[] {
  if (match.augments.length > 0) return [];
  if (match.finalPlacement <= 4) return []; // top-4 finish is fine even without data

  return [{
    ruleId:   'AUGMENT_002',
    round:    'match',
    category: 'augments',
    severity: 'minor',
    observed: 'No augment picks were recorded for this match',
    recommended: 'Augment data was unavailable — coaching on augment decisions is skipped for this match',
    reasonMetrics: { augmentsRecorded: 0 },
    coaching_text: 'GEP did not capture augment picks for this match, so augment decisions cannot be evaluated. This typically happens when the game ends very early or GEP had a registration delay. Future matches should capture this data normally.',
  }];
}

function byHp(round: RoundSnapshot, t: { low: string; mid: string }): string {
  return round.health < 30 ? t.low : t.mid;
}
