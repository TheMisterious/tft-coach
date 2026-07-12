// Rule engine — runs all checkers and returns a sorted list of decision points.
// Every numeric claim originates here; the report generator only summarizes them.

import type { MatchSnapshot, DecisionPoint, Severity, MetaData } from '../shared/types';
import { checkEcon }             from './checkers/econ';
import { checkLeveling }         from './checkers/leveling';
import { checkStreak }           from './checkers/streak';
import { checkItems }            from './checkers/items';
import { checkRolling }          from './checkers/rolling';
import { checkHp }               from './checkers/hp';
import { checkBoard }            from './checkers/board';
import { checkComp }             from './checkers/comp';
import { checkSet17 }            from './checkers/set17';
import { checkTraitBreakpoints } from './checkers/traits';
import { checkAugments }         from './checkers/augments';
import { checkPositioning }      from './checkers/positioning';
import { getRuleTier, getRuleMeta, getMvpRules } from './rules-loader';
import { buildMatchContext }     from './match-context';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  moderate: 1,
  minor:    2,
};

// Rules that assume "hold gold" / "don't spend" is always correct. Contradicts
// crisis-response advice (roll down, spend everything) on the same round —
// e.g. ROLL_002 explicitly tells a <40 HP player entering stage 4 to spend
// 20-40g stabilising; STREAK_002 would otherwise flag that exact spend as
// "wasted gold, should have committed to the loss streak instead" if the
// stabilising roll didn't win the very next fight.
const HOLD_GOLD_RULES = new Set(['ECON_001', 'ECON_002', 'STREAK_002']);

// Rule priority within a match, by unique_id (data/rules.mvp.json). Lower index
// = higher priority. Used only as a tiebreaker within a severity band so the
// hand-curated "most pedagogically important" rules aren't buried under a pile
// of same-severity but lower-value notes when the report gets truncated.
const MVP_RANK: Map<string, number> = new Map(getMvpRules().map((id, i) => [id, i]));

export function extractDecisionPoints(
  match: MatchSnapshot,
  meta: MetaData
): DecisionPoint[] {
  console.log('[rule-engine] running checkers on', match.rounds.length, 'rounds');

  const context = buildMatchContext(match, meta);
  if (context.isRerollComp) {
    console.log(`[rule-engine] detected reroll archetype: ${context.matchedComp?.name}`);
  }

  const checkerResults: Array<[string, DecisionPoint[]]> = [
    ['econ',       checkEcon(match, meta, context)],
    ['hp',         checkHp(match)],
    ['leveling',   checkLeveling(match)],
    ['rolling',    checkRolling(match, meta, context)],
    ['streak',     checkStreak(match)],
    ['items',      checkItems(match, meta, context)],
    ['board',      checkBoard(match, meta)],
    ['comp',       checkComp(match)],
    ['set17',      checkSet17(match)],
    ['traits',     checkTraitBreakpoints(match, meta)],
    ['augments',   checkAugments(match, meta, context)],
    ['positioning',checkPositioning(match, meta)],
  ];

  const summary = checkerResults.map(([name, pts]) => `${name}:${pts.length}`).join(' ');
  console.log('[rule-engine] checker counts —', summary);

  let points = checkerResults.flatMap(([, pts]) => pts)
    .map(p => (p.ruleId && !p.tier) ? { ...p, tier: getRuleTier(p.ruleId) } : p)
    .map(applyConfidenceHedge);

  points = suppressHoldGoldAdviceDuringHpCrisis(points, context);
  points = mergeEconShortfallsAtSameRound(points);

  console.log('[rule-engine] total decision points:', points.length);

  // Sort: critical first, then MVP-curated priority, then chronologically by round.
  return points.sort((a, b) => {
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDiff !== 0) return severityDiff;
    const rankA = a.ruleId ? MVP_RANK.get(a.ruleId) ?? Infinity : Infinity;
    const rankB = b.ruleId ? MVP_RANK.get(b.ruleId) ?? Infinity : Infinity;
    if (rankA !== rankB) return rankA - rankB;
    return roundToNumber(a.round) - roundToNumber(b.round);
  });
}

// A round already flagged as an HP crisis shouldn't also get "hold more gold"
// / "you sat overcap" / "you should have banked the loss streak" advice — the
// correct play there is spending to survive, not gold discipline. See
// src/coach/match-context.ts for the crisis window.
function suppressHoldGoldAdviceDuringHpCrisis(
  points: DecisionPoint[],
  context: ReturnType<typeof buildMatchContext>
): DecisionPoint[] {
  if (context.hpCrisisRounds.size === 0) return points;

  return points.filter(p => {
    if (!p.ruleId || !HOLD_GOLD_RULES.has(p.ruleId)) return true;
    if (!context.hpCrisisRounds.has(p.round)) return true;
    console.log(`[rule-engine] suppressed ${p.ruleId} at ${p.round} — HP crisis at this round makes "hold gold" advice contradictory`);
    return false;
  });
}

// ECON_001 ("missed interest bracket") and ECON_004 ("below econ benchmark")
// both key off the same round's ending gold, just measured against two
// different targets — the universal 10/20/30/40/50g interest ladder vs. a
// set-curated checkpoint benchmark. Whenever both fire on the same round
// they're really one observation ("you were short on gold here") read twice,
// even when the two gaps differ (e.g. 3g under the 10g interest tier AND 13g
// under a 20g checkpoint benchmark — previously only suppressed when the two
// numbers happened to match exactly, which left the common case where they
// don't showing as two near-identical cards). Merge into a single econ note
// per round instead.
function mergeEconShortfallsAtSameRound(points: DecisionPoint[]): DecisionPoint[] {
  const econ001ByRound = new Map<string, DecisionPoint>();
  const econ004ByRound = new Map<string, DecisionPoint>();
  for (const p of points) {
    if (p.ruleId === 'ECON_001') econ001ByRound.set(p.round, p);
    if (p.ruleId === 'ECON_004') econ004ByRound.set(p.round, p);
  }

  const merged = new Map<string, DecisionPoint>();
  for (const [round, e001] of econ001ByRound) {
    const e004 = econ004ByRound.get(round);
    if (!e004) continue;

    const gold    = e001.reasonMetrics.goldEnd as number;
    const tier    = e001.reasonMetrics.tier as number;
    const gap     = e001.reasonMetrics.gap as number;
    const bench   = e004.reasonMetrics.benchmark as number;
    const deficit = e004.reasonMetrics.deficit as number;
    const severity: Severity =
      SEVERITY_ORDER[e001.severity] <= SEVERITY_ORDER[e004.severity] ? e001.severity : e004.severity;

    console.log(`[rule-engine] merged ECON_001+ECON_004 at ${round} — same ${gold}g ending, two targets (${gap}g/${deficit}g short)`);

    merged.set(round, {
      ...e001,
      severity,
      observed: `Ended ${round} at ${gold}g — ${gap}g below the ${tier}g interest tier and ${deficit}g below the ${bench}g benchmark for this checkpoint`,
      recommended: `${e001.recommended} ${e004.recommended}`,
      reasonMetrics: { ...e001.reasonMetrics, ...e004.reasonMetrics },
      coaching_text: `At ${round} you ended on ${gold}g — short of both the ${tier}g interest bracket (by ${gap}g) and the ${bench}g benchmark expected for this checkpoint (by ${deficit}g). ${e004.recommended}`,
    });
  }

  return points
    .filter(p => !(merged.has(p.round) && (p.ruleId === 'ECON_001' || p.ruleId === 'ECON_004')))
    .concat([...merged.values()]);
}

// Rules the registry marks "confidence: medium" get a short caveat appended
// so the coach doesn't assert community-derived heuristics with the same
// certainty as official game mechanics. High-confidence rules are left as-is.
function applyConfidenceHedge(p: DecisionPoint): DecisionPoint {
  if (!p.ruleId || !p.coaching_text) return p;
  const meta = getRuleMeta(p.ruleId);
  if (meta?.confidence !== 'medium') return p;

  const hedge = ' (This threshold is a community-derived guideline, not an official mechanic — treat it as directional.)';
  if (p.coaching_text.endsWith(hedge)) return p;
  return { ...p, coaching_text: p.coaching_text + hedge };
}

// Convert "3-2" → 302 for sorting. "match" (whole-game flags) sorts last.
function roundToNumber(label: string): number {
  if (label === 'match') return 9999;
  const [stage, round] = label.split('-').map(Number);
  return (stage ?? 0) * 100 + (round ?? 0);
}
