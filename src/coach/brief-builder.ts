// Compresses a full match snapshot + decision points into the compact report
// brief consumed by the offline reporter.
//
// Decision points with coaching_text are converted to CoachingNotes by the
// rule engine and placed in resolvedNotes. The reporter only needs to fill in
// the remaining unresolved points and generate tldr, grade, and strengths.

import type { MatchSnapshot, DecisionPoint, MatchBrief, CoachingNote, MetaData, RoundTrajectoryPoint } from '../shared/types';
import { getChampionName, getItemName } from '../enrichment/meta-lookup';
import { overallGrade, categoryGrades, capRepeats } from './scoring';

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
  const diversified = capRepeats(points);

  const topPoints = diversified.slice(0, MAX_POINTS); // already severity-sorted
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
    resolvedNotes,
    decisionPoints: pendingPoints,
    // Graded from the FULL `points` list (pre-truncation) and normalized by
    // round count — see src/coach/scoring.ts for why both matter.
    overallGrade:    overallGrade(match.finalPlacement, points, match.rounds.length),
    categoryGrades:  categoryGrades(points, match.rounds.length),
  };
}

function toCoachingNote(dp: DecisionPoint): CoachingNote {
  return {
    round_label:               dp.round,
    category:                  dp.category,
    severity:                  dp.severity,
    tier:                      dp.tier,
    what_happened:             dp.observed,
    what_should_have_happened: dp.recommended,
    why:                       dp.coaching_text!,
    references:                (dp.hexPosition || dp.boardSnapshot)
      ? { hexPosition: dp.hexPosition, boardSnapshot: dp.boardSnapshot }
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
    liveRank: r.liveRank,
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
