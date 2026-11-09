// Match plan synthesis — the one place that looks across the WHOLE match to
// describe what the player was actually trying to do, instead of judging
// isolated rounds. Every checker in checkers/*.ts operates on a single round
// or a short local window; this module is the counterpart that produces a
// deterministic overview (comp trajectory, econ arc, leveling curve) meant to
// sit above the flat note list in the report.
//
// Deliberately deterministic — no LLM narration (see report-generator.ts's
// header comment for why this project hasn't wired one up).

import type {
  MatchSnapshot,
  MetaData,
  RoundSnapshot,
  MatchPlan,
  CompPivot,
  EconPhase,
  EconStyle,
  LevelMilestone,
} from '../shared/types';
import { buildMatchContext, computeActiveTraitSet } from './match-context';
import { buildMetaContext } from './meta-blend';

// A trait becomes "active" once the board meets its lowest breakpoint tier —
// same notion getActiveTraits() (src/enrichment/meta-lookup.ts) already uses
// for the live in-game trait readout, applied here per-round instead of once.
// Thin wrapper: the actual derivation now lives in match-context.ts's
// computeActiveTraitSet.
function activeTraitsForRound(round: RoundSnapshot, meta: MetaData): Set<string> {
  return computeActiveTraitSet(round.board, meta);
}

function setsDiffer(a: Set<string>, b: Set<string>): { changed: boolean; symmetricDiff: number } {
  let diff = 0;
  for (const t of a) if (!b.has(t)) diff++;
  for (const t of b) if (!a.has(t)) diff++;
  return { changed: diff > 0, symmetricDiff: diff };
}

// Real pivot = the active trait set changes by more than one trait between
// two distinct stage-3+ states. A single trait swap (e.g. losing a breakpoint
// because one unit died mid-fight) is noise, not a strategy change.
const PIVOT_THRESHOLD = 2;

function computeCompTrajectory(
  match: MatchSnapshot,
  meta: MetaData
): { finalTraits: string[]; pivots: CompPivot[] } {
  const pvpRounds = match.rounds.filter(r => r.type === 'PVP');

  const stage3PlusStates: Array<{ round: string; traits: Set<string> }> = [];
  for (const round of pvpRounds) {
    const [stage] = round.label.split('-').map(Number);
    if ((stage ?? 0) < 3) continue;
    const traits = activeTraitsForRound(round, meta);
    stage3PlusStates.push({ round: round.label, traits });
  }

  const pivots: CompPivot[] = [];
  let lastDistinct: { round: string; traits: Set<string> } | undefined;

  for (const state of stage3PlusStates) {
    if (!lastDistinct) {
      lastDistinct = state;
      continue;
    }
    const { changed, symmetricDiff } = setsDiffer(lastDistinct.traits, state.traits);
    if (!changed) continue;
    if (symmetricDiff >= PIVOT_THRESHOLD) {
      pivots.push({
        round: state.round,
        from: [...lastDistinct.traits],
        to: [...state.traits],
      });
    }
    lastDistinct = state;
  }

  const finalTraits = lastDistinct ? [...lastDistinct.traits] : [];
  return { finalTraits, pivots };
}

function roundMode(round: RoundSnapshot): 'banking' | 'spending' {
  if (round.rollsSpent > 0 || round.xpBought) return 'spending';
  return round.goldEnd < round.goldStart ? 'spending' : 'banking';
}

function computeEconPhases(match: MatchSnapshot): EconPhase[] {
  const phases: EconPhase[] = [];
  for (const round of match.rounds) {
    const mode = roundMode(round);
    const current = phases.at(-1);
    if (current && current.mode === mode) {
      current.endRound = round.label;
    } else {
      phases.push({ startRound: round.label, endRound: round.label, mode });
    }
  }
  return phases;
}

// A committed, sustained roll-down at a fixed level — distinct from a single
// stabilising roll during an HP crisis (context.hpCrisisRounds already covers
// that case elsewhere). 4+ rounds of real rolling with no level movement is
// the shape of an intentional slow-roll line, not incidental rerolling.
const SLOW_ROLL_ROUND_THRESHOLD = 4;

function computeEconStyle(
  match: MatchSnapshot,
  isRerollComp: boolean,
  isFastTempo: boolean
): EconStyle {
  if (isRerollComp) return 'reroll';
  if (isFastTempo) return 'fast_tempo';

  let rollWhileLevelStable = 0;
  for (let i = 1; i < match.rounds.length; i++) {
    const prev = match.rounds[i - 1];
    const cur = match.rounds[i];
    if (cur.rollsSpent > 0 && cur.level === prev.level) rollWhileLevelStable++;
  }
  if (rollWhileLevelStable >= SLOW_ROLL_ROUND_THRESHOLD) return 'slow_roll';

  return 'standard';
}

function computeLevelMilestones(match: MatchSnapshot): LevelMilestone[] {
  const milestones: LevelMilestone[] = [];
  let seenLevel = 0;
  for (const round of match.rounds) {
    while (round.level > seenLevel) {
      seenLevel++;
      milestones.push({ level: seenLevel, round: round.label });
    }
  }
  return milestones;
}

// "3-2" -> 302. Mirrors rule-engine.ts's roundToNumber (kept local there —
// this is a small enough helper to duplicate rather than export across a
// module boundary for).
function roundToNumber(label: string): number {
  const [stage, round] = label.split('-').map(Number);
  return (stage ?? 0) * 100 + (round ?? 0);
}

function levelTiming(
  match: MatchSnapshot,
  milestones: LevelMilestone[],
  targetLevel: number,
  benchmarkRound: string
): 'ahead' | 'on_curve' | 'behind' | undefined {
  const benchmarkExists = match.rounds.some(r => r.label === benchmarkRound);
  if (!benchmarkExists) return undefined;

  const milestone = milestones.find(m => m.level === targetLevel);
  const milestoneNum = milestone ? roundToNumber(milestone.round) : Infinity;
  const benchmarkNum = roundToNumber(benchmarkRound);

  if (milestoneNum < benchmarkNum) return 'ahead';
  if (milestoneNum === benchmarkNum) return 'on_curve';
  return 'behind';
}

const ECON_STYLE_LABEL: Record<EconStyle, string> = {
  standard: 'standard',
  slow_roll: 'slow-roll',
  reroll: 'reroll',
  fast_tempo: 'fast-tempo',
};

function buildHeadline(
  finalTraits: string[],
  pivots: CompPivot[],
  econStyle: EconStyle,
  finalLevel: number,
  finalLevelRound: string,
  level8Timing: 'ahead' | 'on_curve' | 'behind' | undefined,
  level9Timing: 'ahead' | 'on_curve' | 'behind' | undefined
): string {
  const traitPhrase = finalTraits.length > 0
    ? finalTraits.slice(0, 2).join('/')
    : 'no consistent trait line';

  let pivotClause = '';
  if (pivots.length === 1) {
    pivotClause = ` (pivoted from ${pivots[0].from.join('/') || 'no traits'} to ${pivots[0].to.join('/') || 'no traits'} at ${pivots[0].round})`;
  } else if (pivots.length > 1) {
    pivotClause = ` (pivoted comps ${pivots.length} times, last at ${pivots.at(-1)!.round})`;
  }

  const timing = finalLevel >= 9 ? level9Timing : finalLevel >= 8 ? level8Timing : undefined;
  const timingClause = timing ? `, ${timing.replace('_', '-')} on tempo` : '';

  return `Committed to ${traitPhrase}${pivotClause} while running a ${ECON_STYLE_LABEL[econStyle]} economy, reaching level ${finalLevel} by ${finalLevelRound}${timingClause}.`;
}

function stageOf(roundLabel: string): number {
  return Number(roundLabel.split('-')[0]) || 0;
}

// The most recent pivot at or before `roundLabel`, restricted to the same or
// immediately preceding stage — lets a checker explain "this happened right
// after you pivoted" without a pivot from 3 stages ago (irrelevant by then)
// getting attached to every later note. Ranks candidates by full round order
// (roundToNumber), not just stage — two pivots in the same stage (e.g. 4-1
// and 4-3) must still pick the later one, which comparing stage numbers
// alone can't distinguish.
export function mostRecentPivot(plan: MatchPlan, roundLabel: string): CompPivot | undefined {
  const targetNum = roundToNumber(roundLabel);
  const targetStage = stageOf(roundLabel);
  let best: CompPivot | undefined;
  let bestNum = -Infinity;
  for (const p of plan.pivots) {
    const pNum = roundToNumber(p.round);
    if (pNum > targetNum) continue;
    if (pNum > bestNum) { best = p; bestNum = pNum; }
  }
  if (!best) return undefined;
  return targetStage - stageOf(best.round) <= 1 ? best : undefined;
}

// A short, appendable clause connecting a per-round note back to the whole-
// match plan — the concrete mechanism for "the Game Plan should inform other
// advice, not just describe itself" (real user feedback, 2026-07-28): a
// checker that already has `context.plan` can append this to its
// `coaching_text` instead of judging the round in total isolation. Empty
// string (safe to unconditionally concatenate) when there's no recent pivot.
export function pivotContextClause(plan: MatchPlan | undefined, roundLabel: string): string {
  if (!plan) return '';
  const pivot = mostRecentPivot(plan, roundLabel);
  if (!pivot) return '';
  const from = pivot.from.join('/') || 'an earlier line';
  const to = pivot.to.join('/') || 'a new line';
  return ` This was shortly after you pivoted from ${from} to ${to} at ${pivot.round} — comp changes like that often disrupt your usual economy/itemization rhythm for a round or two.`;
}

export function buildMatchPlan(match: MatchSnapshot, meta: MetaData): MatchPlan {
  const context = buildMatchContext(match, meta);
  const { finalTraits, pivots } = computeCompTrajectory(match, meta);
  const econPhases = computeEconPhases(match);
  const econStyle = computeEconStyle(match, context.isRerollComp, context.isFastTempo);
  const levelMilestones = computeLevelMilestones(match);
  const level8Timing = levelTiming(match, levelMilestones, 8, '4-2');
  const level9Timing = levelTiming(match, levelMilestones, 9, '5-2');

  const lastRound = match.rounds.at(-1);
  const finalLevel = lastRound?.level ?? 0;
  const finalLevelRound = lastRound?.label ?? 'match';

  const headline = buildHeadline(
    finalTraits, pivots, econStyle, finalLevel, finalLevelRound, level8Timing, level9Timing
  );

  const metaContext = buildMetaContext(match, finalTraits, meta);

  return {
    headline,
    finalTraits,
    pivots,
    econStyle,
    econPhases,
    levelMilestones,
    level8Timing,
    level9Timing,
    metaContext,
  };
}
