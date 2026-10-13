// Compresses a full match snapshot + decision points into the compact report
// brief consumed by the offline reporter.
//
// Decision points with coaching_text are converted to CoachingNotes by the
// rule engine and placed in resolvedNotes. The reporter only needs to fill in
// the remaining unresolved points and generate tldr, grade, and strengths.

import type { MatchSnapshot, DecisionPoint, MatchBrief, CoachingNote, MetaData, RoundTrajectoryPoint } from '../shared/types';
import { getChampionName, getItemName } from '../enrichment/meta-lookup';
import { overallGrade, categoryGrades, capRepeats } from './scoring';
import { buildMatchPlan } from './plan-builder';
import { getRuleEvidence } from './rules-loader';

// Maximum decision points (resolved + pending combined) before truncating.
const MAX_POINTS = 20;

export function buildBrief(
  match: MatchSnapshot,
  points: DecisionPoint[],
  meta: MetaData
): MatchBrief {
  // Cap repeat firings of the same rule before truncation. Without this, a
  // rule that legitimately fires many times in one match (e.g. ECON_001 "1g
  // short of a bracket", which can trip on nearly every round) eats the whole
  // MAX_POINTS budget and crowds out rules that only fired once but matter
  // more (e.g. an off-BiS item note). Same cap scoring.ts uses for grading —
  // see capRepeats() there for why that matters too.
  const diversified = diversifyRepeatedNotes(capRepeats(points));

  // Rules with a measured link to placement go first (stable, so severity
  // order holds within each half): the MAX_POINTS cut must never drop one of
  // them to make room for a rule that fires in every match.
  const measured = (p: DecisionPoint) => getRuleEvidence(p.ruleId).verdict === 'predictive';
  const ordered = [...diversified.filter(measured), ...diversified.filter(p => !measured(p))];

  const topPoints = ordered.slice(0, MAX_POINTS);
  if (points.length > MAX_POINTS) {
    console.log(`[brief] truncated ${points.length} → ${MAX_POINTS} decision points (${points.length - diversified.length} dropped by per-rule cap)`);
  }

  const resolvedNotes: CoachingNote[] = [];
  const pendingPoints: DecisionPoint[] = [];

  for (const dp of topPoints) {
    if (dp.coaching_text) {
      resolvedNotes.push(toCoachingNote(dp));
    } else {
      pendingPoints.push(dp);
    }
  }

  console.log(`[brief] resolved:${resolvedNotes.length} pending:${pendingPoints.length} finalComp units:${Object.values(match.finalBoard).filter(c => c?.name && c.name !== '0').length}`);

  return {
    placement:       match.finalPlacement,
    setId:           match.setId,
    roundTrajectory: buildRoundTrajectory(match),
    finalComp:      buildFinalComp(match, meta),
    augments:       match.augments,
    godPicks:       match.godPicks,
    plan:           buildMatchPlan(match, meta),
    resolvedNotes,
    decisionPoints: pendingPoints,
    // Graded from the FULL `points` list (pre-truncation) and normalized by
    // round count — see src/coach/scoring.ts for why both matter.
    overallGrade:    overallGrade(match.finalPlacement, points, match.rounds.length),
    categoryGrades:  categoryGrades(points, match.rounds.length),
  };
}

// Each checker's coaching_text is picked from a small (2-3 entry) bucket
// template keyed on HP/gold band (see e.g. checkers/econ.ts's byHp helper).
// capRepeats() above allows the same ruleId to fire up to MAX_PER_RULE times
// in one report, and a match's HP/gold band often stays put across nearby
// rounds — so occurrence 2 and 3 would otherwise repeat the EXACT same
// paragraph verbatim, just with the round-specific numbers swapped in ("mad
// libs" repetition). Recurrences are rewritten into a short reference back to
// the first occurrence instead of restating the full explanation — the
// specific numbers already live in `observed`/`recommended`, which stay
// per-round and are left untouched; only the repeated long-form "why" prose
// is compressed.
const RECURRENCE_INTROS: Array<(firstRound: string) => string> = [
  firstRound => `Same pattern recurring since ${firstRound}`,
  firstRound => `This kept happening — first flagged at ${firstRound}`,
  firstRound => `Still unresolved from ${firstRound}`,
];

export function diversifyRepeatedNotes(points: DecisionPoint[]): DecisionPoint[] {
  const firstRoundByRule = new Map<string, string>();
  const occurrenceByRule = new Map<string, number>();

  return points.map(p => {
    if (!p.ruleId || !p.coaching_text) return p;
    const occurrence = (occurrenceByRule.get(p.ruleId) ?? 0) + 1;
    occurrenceByRule.set(p.ruleId, occurrence);

    if (occurrence === 1) {
      firstRoundByRule.set(p.ruleId, p.round);
      return p;
    }

    const firstRound = firstRoundByRule.get(p.ruleId)!;
    const intro = RECURRENCE_INTROS[(occurrence - 2) % RECURRENCE_INTROS.length](firstRound);
    return { ...p, coaching_text: `${intro}: ${lowercaseFirst(p.observed)}. ${p.recommended}` };
  });
}

function lowercaseFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function toCoachingNote(dp: DecisionPoint): CoachingNote {
  return {
    round_label:               dp.round,
    category:                  dp.category,
    severity:                  dp.severity,
    tier:                      dp.tier,
    evidence:                  getRuleEvidence(dp.ruleId),
    ...(dp.contributing ? { contributing: dp.contributing } : {}),
    what_happened:             dp.observed,
    what_should_have_happened: dp.recommended,
    why:                       dp.coaching_text!,
    references:                (dp.hexPosition || dp.boardSnapshot || dp.recommendedPosition)
      ? {
          hexPosition: dp.hexPosition,
          boardSnapshot: dp.boardSnapshot,
          recommendedPosition: dp.recommendedPosition,
          moveUnitName: dp.moveUnitName,
        }
      : undefined,
  };
}

function buildRoundTrajectory(match: MatchSnapshot): RoundTrajectoryPoint[] {
  return match.rounds.map(r => ({
    round:    r.label,
    hp:       r.health,
    gold:     r.goldEnd,
    level:    r.level,
    rollGold: r.rollsSpent * 2,
  }));
}

function buildFinalComp(
  match: MatchSnapshot,
  meta: MetaData
): Array<{ name: string; stars: number; items: string[] }> {
  return Object.values(match.finalBoard)
    .filter(c => c?.name && c.name !== '0')
    .map(c => ({
      name:  getChampionName(c.name, meta),
      stars: c.level,
      items: [c.item_1, c.item_2, c.item_3]
        .filter(i => i && i !== '0')
        .map(i => getItemName(i, meta)),
    }))
    .sort((a, b) => b.stars - a.stars); // highest-star units first
}
