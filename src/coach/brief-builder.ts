// Compresses a full match snapshot + decision points into the compact report
// brief consumed by the offline reporter.
//
// Decision points with coaching_text are converted to CoachingNotes by the
// rule engine and placed in resolvedNotes. The reporter only needs to fill in
// the remaining unresolved points and generate tldr, grade, and strengths.

import type { MatchSnapshot, DecisionPoint, DecisionCategory, MatchBrief, CoachingNote, MetaData, RoundTrajectoryPoint } from '../shared/types';
import { getChampionName, getItemName } from '../enrichment/meta-lookup';
import { overallGrade, categoryGrades, capRepeats, ALL_CATEGORIES } from './scoring';
import { buildMatchPlan } from './plan-builder';
import { getRuleEvidence, getRuleMeta, categoryGradeValidated } from './rules-loader';
import { canGradeOverall, captureNotes, gradableCategories } from './coverage';
import { boardUnits } from '../ledger/merge';
import { traceGame } from './rule-network';
import { readFights } from './fights';

// Maximum decision points (resolved + pending combined) before truncating.
const MAX_POINTS = 20;

// What the report shows, decided by the audit's evidence
// (data/core/rule-evidence.json) and the rule registry:
//  - a rule that fires in nearly every audited match cannot tell this game from
//    any other, so it gets no note and no grade penalty, only one summary line;
//  - a candidate rule (status 'candidate' in rules.core.json) stays out until
//    matches recorded after it was written confirm it;
//  - every other point is reported as before.
// The full list still reaches the audit and the Player Trends features — only
// the report is filtered.
export function partitionForReport(points: DecisionPoint[]): { reportable: DecisionPoint[]; commonPatterns: string[] } {
  const alwaysOn = new Map<string, number>();
  const reportable: DecisionPoint[] = [];
  for (const p of points) {
    const evidence = getRuleEvidence(p.ruleId);
    if (p.ruleId && evidence.verdict === 'always-on') {
      alwaysOn.set(p.ruleId, (alwaysOn.get(p.ruleId) ?? 0) + 1);
      continue;
    }
    if (p.ruleId && getRuleMeta(p.ruleId)?.status === 'candidate' && evidence.status !== 'confirmed') continue;
    reportable.push(p);
  }
  return { reportable, commonPatterns: [...alwaysOn].map(([ruleId, n]) => commonPatternLine(ruleId, n)) };
}

function commonPatternLine(ruleId: string, count: number): string {
  const name = getRuleMeta(ruleId)?.human_readable_name ?? ruleId;
  const e = getRuleEvidence(ruleId);
  const how = e.matchesFired !== undefined && e.matches !== undefined
    ? `It shows up in ${e.matchesFired} of ${e.matches} audited games`
    : 'It shows up in nearly every audited game';
  return `${name}: ${count} time${count === 1 ? '' : 's'} this game. ${how}, so it says little about this one.`;
}

export function buildBrief(
  match: MatchSnapshot,
  allPoints: DecisionPoint[],
  meta: MetaData
): MatchBrief {
  const { reportable: points, commonPatterns } = partitionForReport(allPoints);

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

  const notes = captureNotes(match);

  // A letter needs two things: this match recorded enough to judge the
  // category, and the category's letter has been shown to track results at all.
  const judgeable = gradableCategories(match);
  const graded = new Set([...judgeable].filter(categoryGradeValidated));
  const ungradedReasons: Partial<Record<DecisionCategory, 'no-data' | 'unvalidated'>> = {};
  for (const category of ALL_CATEGORIES) {
    if (!judgeable.has(category)) ungradedReasons[category] = 'no-data';
    else if (!graded.has(category)) ungradedReasons[category] = 'unvalidated';
  }

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
    commonPatterns,
    flaggedCategories: [...new Set(allPoints.map(p => p.category))],
    gameStory:       traceGame(match, allPoints, meta),
    fights:          readFights(match, meta).map(({ ownShares: _shares, ...row }) => row),
    // Graded from the FULL point list (pre-truncation, always-on rules
    // included) and normalized by round count — see src/coach/scoring.ts.
    // Always-on rules stay in on purpose: the S-D thresholds were set with them
    // in, and dropping them moved 27 of 74 audited games to an S, an 8th place
    // included. Re-deriving the grade is its own piece of work, not a side
    // effect of trimming notes.
    //
    // Only what the recording can support is graded (src/coach/coverage.ts):
    // a category with nothing observed to judge gets no letter instead of an S.
    overallGrade:    canGradeOverall(match) ? overallGrade(match.finalPlacement, allPoints, match.rounds.length) : null,
    categoryGrades:  categoryGrades(allPoints, match.rounds.length, graded),
    ungradedReasons,
    ...(notes.length > 0 ? { captureNotes: notes } : {}),
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
  return boardUnits(match.finalBoard)
    .map(c => ({
      name:  getChampionName(c.name, meta),
      stars: c.level,
      items: [c.item_1, c.item_2, c.item_3]
        .filter(i => i && i !== '0')
        .map(i => getItemName(i, meta)),
    }))
    .sort((a, b) => b.stars - a.stars); // highest-star units first
}
