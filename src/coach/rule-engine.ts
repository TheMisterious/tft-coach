// Rule engine — runs all checkers and returns a sorted list of decision points.
// Every numeric claim originates here; the report generator only summarizes them.

import type { MatchSnapshot, DecisionPoint, Severity, MetaData, MatchContext } from '../shared/types';
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
import { checkCombat }           from './checkers/combat';
import { checkLobby }            from './checkers/lobby';
import { getRuleTier, getRuleMeta, getMvpRules } from './rules-loader';
import { buildMatchContext }     from './match-context';
import { buildMatchPlan }        from './plan-builder';
import { linkCompoundingPatterns } from './decision-links';
import { lobbyClause }           from './lobby-context';
import { attachHistoryContext }  from './history-context';
import { attachContributingDecisions } from './decision-trace';
import type { MatchHistoryEntry } from './history-context';
import { observedCategories }    from './coverage';
import { boardUnits }            from '../ledger/merge';

function stageOf(label: string): number {
  return Number(label.split('-')[0]) || 0;
}

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
//
// ECON_002 ("sat above 50g without rolling or leveling") used to be in this
// set and must not be: its advice is to SPEND, the same as the crisis advice.
// Suppressing it hid exactly the low-HP gold-hoarding a deliberately poor QA
// game produced, and the report graded that game's economy S.
const HOLD_GOLD_RULES = new Set(['ECON_001', 'STREAK_002']);

// Rule priority within a match, by unique_id (data/rules.mvp.json). Lower index
// = higher priority. Used only as a tiebreaker within a severity band so the
// hand-curated "most pedagogically important" rules aren't buried under a pile
// of same-severity but lower-value notes when the report gets truncated.
const MVP_RANK: Map<string, number> = new Map(getMvpRules().map((id, i) => [id, i]));

// The checkers that still run when there is no data/sets/ folder for the
// match's set (meta.setDataMissing — see loadMeta). hp, leveling, streak and
// lobby read no meta at all (lobby only compares the roster's HP and level
// across players). econ reads two set tables: with no benchmarks its
// benchmark pass adds nothing, and with no comps it loses only the reroll-comp
// exemption, as any match on an uncurated comp already does; its
// interest-tier rule is the same in every set. Every other checker fills a
// missing table with a default and reports the result as fact (board.ts
// prices an unknown champion at 2). An allow-list, so a new checker stays off
// for an uncurated set until someone decides it belongs here.
const SET_AGNOSTIC_CHECKERS = new Set(['econ', 'hp', 'leveling', 'streak', 'lobby']);

export function extractDecisionPoints(
  match: MatchSnapshot,
  meta: MetaData,
  // Prior matches' behavioural feature vectors, newest last. Optional because
  // the rule engine must stay a pure function of the match in front of it —
  // the caller that owns storage (src/background/main.ts) passes these in
  // rather than this module reaching into src/persistence, per architectural
  // invariant 5. Omitted by tests/replay-harness.ts and by the first few
  // matches of a fresh install, in which case no history clause is added.
  history: MatchHistoryEntry[] = []
): DecisionPoint[] {
  console.log('[rule-engine] running checkers on', match.rounds.length, 'rounds');

  const plan = buildMatchPlan(match, meta);
  const context: MatchContext = { ...buildMatchContext(match, meta), plan };
  if (context.isRerollComp) {
    console.log(`[rule-engine] detected reroll archetype: ${context.matchedComp?.name}`);
  }
  if (plan.pivots.length > 0) {
    console.log(`[rule-engine] detected ${plan.pivots.length} comp pivot(s), last at ${plan.pivots.at(-1)!.round}`);
  }

  const checkers: Array<[string, () => DecisionPoint[]]> = [
    ['econ',       () => checkEcon(match, meta, context)],
    ['hp',         () => checkHp(match)],
    ['leveling',   () => checkLeveling(match)],
    ['rolling',    () => checkRolling(match, meta, context)],
    ['streak',     () => checkStreak(match)],
    ['items',      () => checkItems(match, meta, context)],
    ['board',      () => checkBoard(match, meta)],
    ['comp',       () => checkComp(match, meta)],
    ['set17',      () => checkSet17(match)],
    ['traits',     () => checkTraitBreakpoints(match, meta)],
    ['augments',   () => checkAugments(match, meta, context)],
    ['positioning',() => checkPositioning(match, meta)],
    ['combat',     () => checkCombat(match, meta)],
    ['lobby',      () => checkLobby(match, meta)],
  ];

  const runnable = meta.setDataMissing
    ? checkers.filter(([name]) => SET_AGNOSTIC_CHECKERS.has(name))
    : checkers;
  if (runnable.length < checkers.length) {
    const skipped = checkers.filter(c => !runnable.includes(c)).map(([name]) => name);
    console.warn(`[rule-engine] no data for ${match.setId} — skipped set-specific checkers: ${skipped.join(' ')}`);
  }
  const checkerResults = runnable.map(([name, run]): [string, DecisionPoint[]] => [name, run()]);

  const summary = checkerResults.map(([name, pts]) => `${name}:${pts.length}`).join(' ');
  console.log('[rule-engine] checker counts —', summary);

  // A note in a category whose inputs GEP never sent is reading a default
  // (level 1, empty board, 0 gold) as if it were the player's state.
  const observed = observedCategories(match);
  let points = checkerResults.flatMap(([, pts]) => pts)
    .filter(p => observed.has(p.category))
    .map(p => (p.ruleId && !p.tier) ? { ...p, tier: getRuleTier(p.ruleId) } : p)
    .map(applyConfidenceHedge);

  points = suppressHoldGoldAdviceDuringHpCrisis(points, context);
  points = suppressLevelTimingOnRerollLine(points, match, meta);
  points = suppressStreakTiersWithoutAugments(points, match);
  points = mergeEconShortfallsAtSameRound(points);
  points = linkCompoundingPatterns(points);
  points = attachLobbyContext(points, match);
  points = attachHistoryContext(points, history);
  points = attachContributingDecisions(points, match, meta);

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

// A reroll line stays low on purpose: it rolls at 5-7 for 3-stars of cheap
// units while the lobby levels. Level-timing rules measured against a
// standard or fast-8 curve read that as falling behind; a 6th place on
// 2026-11-09 with 3-star Veigar, Rek'Sai and Ornn was told "level 5 at 4-1,
// behind every opponent, levelling at the next window is the usual answer".
// The fight readings (rule-network.ts) judge whether the line worked.
const LEVEL_TIMING_RULES = new Set(['LEVEL_001', 'LEVEL_002', 'LEVEL_003', 'LEVEL_005', 'LEVEL_006', 'LOBBY_001']);

export function isRerollLine(match: MatchSnapshot, meta: MetaData): boolean {
  const at41 = match.rounds.find(r => r.label === '4-1') ?? match.rounds.filter(r => stageOf(r.label) <= 4).slice(-1)[0];
  if (!at41 || at41.level > 6) return false;
  const throughStage4 = match.rounds.filter(r => stageOf(r.label) <= 4);
  const cheapThreeStar = throughStage4.some(r => boardUnits(r.board)
    .some(u => Number(u.level) >= 3 && (meta.champions?.[u.name]?.tier ?? 9) <= 3));
  const rolledMidGame = match.rounds
    .filter(r => stageOf(r.label) === 3 || stageOf(r.label) === 4)
    .reduce((sum, r) => sum + r.rollsSpent * 2, 0);
  return cheapThreeStar || rolledMidGame >= 30;
}

function suppressLevelTimingOnRerollLine(points: DecisionPoint[], match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  if (!isRerollLine(match, meta)) return points;
  return points.filter(p => {
    if (!p.ruleId || !LEVEL_TIMING_RULES.has(p.ruleId)) return true;
    console.log(`[rule-engine] suppressed ${p.ruleId} at ${p.round} — reroll line, low level is the plan`);
    return false;
  });
}

// GEP sends Set 18 augment picks as blank names, and some augments change how
// a streak counts (the player behind the 6th place above took one that doubled
// it: three losses, a streak of 6). Without the picks, "never reached the +2g
// tier" can be false, so the streak-tier rules stay quiet.
const STREAK_TIER_RULES = new Set(['STREAK_002', 'STREAK_003']);

function suppressStreakTiersWithoutAugments(points: DecisionPoint[], match: MatchSnapshot): DecisionPoint[] {
  if (!match.capture || match.capture.augmentsSeen) return points;
  return points.filter(p => {
    if (!p.ruleId || !STREAK_TIER_RULES.has(p.ruleId)) return true;
    console.log(`[rule-engine] suppressed ${p.ruleId} — augment picks not recorded, and an augment can change the streak count`);
    return false;
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

// Rules that compare the player to a fixed constant get one sentence of real
// lobby context appended — where the player actually stood among the people
// taking their HP. A benchmark says "level 8 by 4-2"; it cannot say "and five
// of the seven players still alive were already past you", which is the fact
// that decides the game.
//
// Runs here rather than inside each checker for the same reason
// linkCompoundingPatterns does: it needs no checker-private state, and doing it
// in one place keeps the annotated set explicit instead of scattered across
// thirteen files. Only `coaching_text` is touched — severity, ruleId and
// reasonMetrics are left alone, so scoring and the rule-coverage tests are
// unaffected.
//
// LOBBY_001 is deliberately absent: it IS the lobby comparison, and appending
// a lobby sentence to it would just say the same thing twice.
const LOBBY_ANNOTATED: Record<string, 'level' | 'hp'> = {
  LEVEL_001: 'level',
  LEVEL_002: 'level',
  LEVEL_003: 'level',
  LEVEL_004: 'level',
  LEVEL_005: 'level',
  LEVEL_006: 'level',
  HP_001:    'hp',
  HP_002:    'hp',
  HP_003:    'hp',
  BOARD_001: 'hp',
};

function attachLobbyContext(points: DecisionPoint[], match: MatchSnapshot): DecisionPoint[] {
  const roundByLabel = new Map(match.rounds.map(r => [r.label, r]));

  return points.map(p => {
    const metric = p.ruleId ? LOBBY_ANNOTATED[p.ruleId] : undefined;
    if (!metric || !p.coaching_text) return p;

    const round = roundByLabel.get(p.round);
    if (!round) return p;

    const clause = lobbyClause(round, metric);
    if (!clause || p.coaching_text.includes(clause)) return p;

    return { ...p, coaching_text: p.coaching_text + clause };
  });
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
