// The coaching pipeline itself: ledger in, report out. No Overwolf, disk,
// storage or window calls, so the three places that coach a match run the
// same code — main.ts after match_end, main.ts again when it rebuilds a saved
// match, and tests/replay-harness.ts on recorded ledgers. Before this module
// each of them carried its own copy of the steps, and the harness's copy had
// already drifted (it never generated the report or the trend data).
//
// Persistence stays with the caller (architectural invariant 5): history comes
// in as an argument, and the result goes back out for main.ts to save.

import type {
  LedgerEntry, MatchSnapshot, MetaData, DecisionPoint, MatchBrief, CoachingReport,
  FeatureVector, MatchLabels,
} from '../shared/types';
import { reconstructSnapshots } from '../ledger/rounds';
import { detectSet, loadMeta } from '../enrichment/meta-lookup';
import { extractDecisionPoints } from '../coach/rule-engine';
import type { MatchHistoryEntry } from '../coach/history-context';
import { buildBrief } from '../coach/brief-builder';
import { generateCoachingReport } from '../coach/report-generator';
import { buildMatchContext } from '../coach/match-context';
import { buildMatchPlan } from '../coach/plan-builder';
import { isUsableCapture } from '../coach/coverage';
import { extractFeatureVector } from '../profile/feature-vector';
import { extractMatchLabels } from '../profile/labels';

// Why a ledger produced no match to coach. Each one used to produce a fake
// report before its guard existed:
//  - empty_ledger: nothing was written under this matchId.
//  - no_rounds: GEP sent a few stray info updates but no round_start/round_end
//    pair, e.g. post-game lobby spectating re-triggering match start. Without
//    the guard that became an "8th place" report with no data behind it.
//  - not_playable: rounds exist, but the capture never saw the player's own
//    gold or board — a ledger that began after elimination, recording the
//    lobby being spectated. The source of a QA report that coached "level 1,
//    empty board" at 6-3.
export type UnusableReason = 'empty_ledger' | 'no_rounds' | 'not_playable';

export type ReadMatch =
  | { snapshot: MatchSnapshot; unusable?: undefined }
  | { unusable: UnusableReason; snapshot?: MatchSnapshot };

export function readMatch(ledger: LedgerEntry[]): ReadMatch {
  if (ledger.length === 0) return { unusable: 'empty_ledger' };
  const snapshot = reconstructSnapshots(ledger);
  if (snapshot.rounds.length === 0) return { unusable: 'no_rounds', snapshot };
  if (!isUsableCapture(snapshot)) return { unusable: 'not_playable', snapshot };
  return { snapshot };
}

export interface CoachedMatch {
  setId: string;
  meta: MetaData;
  points: DecisionPoint[];
  brief: MatchBrief;
  report: CoachingReport;
  featureVector: FeatureVector;
  matchLabels: MatchLabels;
}

// history: prior matches' feature vectors, oldest first, without this match
// (see main.ts priorFeatureHistory). Omit it for no self-relative clauses.
export async function coachMatch(
  ledger: LedgerEntry[], snapshot: MatchSnapshot, history?: MatchHistoryEntry[],
): Promise<CoachedMatch> {
  const setId  = detectSet(ledger);
  const meta   = await loadMeta(setId);
  const points = extractDecisionPoints(snapshot, meta, history);
  // This match's own feature vector goes into the brief too, beside the
  // history, for the "your usual game" read (src/coach/style-context.ts).
  const trend  = computeTrendData(snapshot, meta, points);
  const brief  = buildBrief(snapshot, points, meta, { history, featureVector: trend.featureVector });
  const report = await generateCoachingReport(brief);
  return { setId, meta, points, brief, report, ...trend };
}

// The per-match featureVector + matchLabels persisted alongside each saved
// match — src/profile's trend model is rebuilt from these. context is
// recomputed here rather than threaded out of extractDecisionPoints (which
// builds an equivalent context internally but doesn't return it) — consistent
// with this codebase's existing tolerance for cheap redundant recomputation of
// pure functions (checkers/combat.ts and positioning.ts both already
// independently call computeActiveComp rather than sharing one computed value).
function computeTrendData(
  snapshot: MatchSnapshot, meta: MetaData, points: DecisionPoint[],
): { featureVector: FeatureVector; matchLabels: MatchLabels } {
  const context = { ...buildMatchContext(snapshot, meta), plan: buildMatchPlan(snapshot, meta) };
  return {
    featureVector: extractFeatureVector(snapshot, points, context, meta),
    matchLabels:   extractMatchLabels(snapshot, context),
  };
}
