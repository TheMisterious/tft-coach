// Grades the match overall and per-category from the decision-point list.
//
// Two corrections were needed against real matches before this was trustworthy:
//
// 1. Repeat firings of the same rule are capped (MAX_PER_RULE) before scoring,
//    same as brief-builder.ts caps them before display — reusing this module's
//    capRepeats() as the single source of truth for both. Without this, a rule
//    that legitimately fires many times for a genuinely minor issue (e.g.
//    ECON_001 "1g short of a bracket," which can trip on nearly every round)
//    dominates the penalty sum the same way it would dominate the display list.
//
// 2. Penalty is normalized against round count. Even after (1), a 34-round
//    game that goes the distance racks up more total flagged notes than a
//    26-round game that ends early, purely because there are more rounds to
//    check — that's match length, not skill. Confirmed with 3 real matches:
//    raw capped penalty was 15.25 (1st place, 34 rounds), 14.50 (8th place,
//    26 rounds), 18.75 (3rd place, 33 rounds) — barely distinguishing the 1st
//    and 8th place games, because it wasn't controlling for length. Dividing
//    by round count first (`penalty per round`) cleanly separated them: 0.449
//    (1st) vs 0.558 (8th) vs 0.568 (3rd), in the order you'd expect.
//
// Thresholds below are calibrated against those 3 real data points, not a
// large sample — treat them as a reasonable starting point that may need
// revisiting once more real matches (especially very short/early-elimination
// games) go through this.

import type { DecisionPoint, DecisionCategory, Severity, Grade } from '../shared/types';

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 1.5,
  moderate: 0.75,
  minor:    0.25,
};

// Cap repeat firings of the same ruleId. Points are expected pre-sorted
// (most severity-important first, per rule-engine.ts) so the kept occurrences
// are each rule's most important ones.
export const MAX_PER_RULE = 3;

export function capRepeats(points: DecisionPoint[], maxPerRule = MAX_PER_RULE): DecisionPoint[] {
  const ruleCounts = new Map<string, number>();
  return points.filter(p => {
    if (!p.ruleId) return true;
    const count = ruleCounts.get(p.ruleId) ?? 0;
    ruleCounts.set(p.ruleId, count + 1);
    return count < maxPerRule;
  });
}

// A typical full real match runs ~25-35 rounds (observed range across this
// project's golden files). Penalty is rescaled to "as if this were a
// BASELINE_ROUNDS-length game" so a longer game isn't penalized just for
// having more rounds to flag things in.
const BASELINE_ROUNDS = 25;
const MIN_ROUNDS_FOR_NORMALIZATION = 10; // avoid wild multipliers on very short games

function normalizedPenalty(points: DecisionPoint[], totalRounds: number): number {
  const raw = capRepeats(points).reduce((sum, p) => sum + SEVERITY_WEIGHT[p.severity], 0);
  const effectiveRounds = Math.max(totalRounds, MIN_ROUNDS_FOR_NORMALIZATION);
  return raw * (BASELINE_ROUNDS / effectiveRounds);
}

// Overall grade folds in placement — a 1st place with a few moderate notes
// should still grade higher than an 8th place with the same notes.
export function overallGrade(placement: number, points: DecisionPoint[], totalRounds: number): Grade {
  const score = placement + normalizedPenalty(points, totalRounds);
  if (score <= 10) return 'S';
  if (score <= 14) return 'A';
  if (score <= 18) return 'B';
  if (score <= 21) return 'C';
  return 'D';
}

// Per-category grades have no placement signal to fold in — they're purely
// "how many mistakes, how severe, in this one area." No notes in a category
// = S, same philosophy as report-generator's CLEAN_CATEGORY_STRENGTHS.
function categoryGrade(penalty: number): Grade {
  if (penalty <= 0)   return 'S';
  if (penalty <= 1.5) return 'A';
  if (penalty <= 3.0) return 'B';
  if (penalty <= 4.5) return 'C';
  return 'D';
}

export const ALL_CATEGORIES: DecisionCategory[] = [
  'econ', 'streak', 'leveling', 'items', 'rolling', 'traits',
  'augments', 'positioning', 'hp', 'board', 'comp', 'set_mechanic',
];

export const CATEGORY_LABELS: Record<DecisionCategory, string> = {
  econ: 'economy',
  streak: 'streak management',
  leveling: 'leveling',
  items: 'itemization',
  rolling: 'rolling',
  traits: 'traits',
  augments: 'augments',
  positioning: 'positioning',
  hp: 'HP management',
  board: 'board strength',
  comp: 'comp direction',
  set_mechanic: 'set mechanics',
};

export function categoryGrades(points: DecisionPoint[], totalRounds: number): Record<DecisionCategory, Grade> {
  const byCategory = new Map<DecisionCategory, DecisionPoint[]>();
  for (const p of points) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  const grades = {} as Record<DecisionCategory, Grade>;
  for (const category of ALL_CATEGORIES) {
    grades[category] = categoryGrade(normalizedPenalty(byCategory.get(category) ?? [], totalRounds));
  }
  return grades;
}
