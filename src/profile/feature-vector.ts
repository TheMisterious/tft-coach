// Extracts a fixed-length, set-invariant FeatureVector for one match — the
// raw input to the cross-match Player Trends model (see trend-model.ts).
//
// Every field here is derivable purely from mechanics that don't change
// between sets (econ, rolling, streak, itemization timing, positioning,
// combat, HP). Reuses the exact ground-truth definitions the per-round
// checkers already use (checkers/econ.ts, rolling.ts, items.ts, combat.ts,
// positioning.ts) wherever an equivalent already exists, rather than
// inventing a second definition of the same mechanic — see each function's
// comment for which checker it mirrors.

import type {
  MatchSnapshot,
  RoundSnapshot,
  DecisionPoint,
  MetaData,
  MatchContext,
  FeatureVector,
  Cell,
} from '../shared/types';
import { identifyCarry, boardItemIds, boardUnits } from '../ledger/merge';
import { unitItems, isComponent } from '../coach/checkers/items';
import { resolveHexCell, HEX_ROWS } from '../shared/hex-grid';
import { computeCarryDamage } from '../coach/match-context';

function stageOf(label: string): number {
  return Number(label.split('-')[0]) || 0;
}

// "3-2" -> 302, mirrors rule-engine.ts's/plan-builder.ts's local roundToNumber
// (duplicated again here rather than exported across another module boundary
// — same precedent those two files already set for this exact helper).
function roundToNumber(label: string): number {
  const [stage, round] = label.split('-').map(Number);
  return (stage ?? 0) * 100 + (round ?? 0);
}

// Mirrors plan-builder.ts's roundMode exactly.
function roundMode(r: RoundSnapshot): 'banking' | 'spending' {
  if (r.rollsSpent > 0 || r.xpBought) return 'spending';
  return r.goldEnd < r.goldStart ? 'spending' : 'banking';
}

function computeEconCurveStats(rounds: RoundSnapshot[]): { bankingRatio: number; phaseSwitchCount: number } {
  if (rounds.length === 0) return { bankingRatio: 0, phaseSwitchCount: 0 };
  let bankingCount = 0;
  let phaseSwitchCount = 0;
  let prevMode: 'banking' | 'spending' | null = null;
  for (const r of rounds) {
    const mode = roundMode(r);
    if (mode === 'banking') bankingCount++;
    if (prevMode !== null && mode !== prevMode) phaseSwitchCount++;
    prevMode = mode;
  }
  return { bankingRatio: bankingCount / rounds.length, phaseSwitchCount };
}

// Mirrors checkers/econ.ts's checkMissedInterest condition (gold 1-3g short
// of a 10/20/30/40/50g tier) as a per-round count instead of a fired note.
const INTEREST_TIERS = [10, 20, 30, 40, 50];
function isInterestMissed(goldEnd: number): boolean {
  if (goldEnd >= 50) return false;
  return INTEREST_TIERS.some(tier => {
    const gap = tier - goldEnd;
    return gap > 0 && gap <= 3;
  });
}

// Mirrors checkers/econ.ts's checkInterestOvercap's per-round condition
// (INTEREST_CAP=50 + OVERCAP_ACTIONABLE_SURPLUS=4, idle = no roll/XP spend).
function isOvercapIdle(r: RoundSnapshot): boolean {
  return r.goldEnd >= 54 && r.rollsSpent === 0 && !r.xpBought;
}

function computePreStage3RollGold(rounds: RoundSnapshot[]): number {
  let gold = 0;
  for (const r of rounds) {
    if (stageOf(r.label) >= 3) break;
    gold += r.rollsSpent * 2;
  }
  return gold;
}

// Rounds between the first stage>=3 HP-crisis round (health<40, matching
// context.hpCrisisRounds' own threshold) and the first round afterward with
// any real roll spend. null when the match had no crisis at all. When a
// crisis occurred but no roll response ever followed, returns the number of
// rounds remaining after the crisis started rather than null — the crisis is
// real, "never responded" is itself a meaningful (large) value, not an
// absence of data.
function computeRolldownLatency(rounds: RoundSnapshot[]): number | null {
  const crisisIdx = rounds.findIndex(r => stageOf(r.label) >= 3 && r.health < 40);
  if (crisisIdx < 0) return null;
  for (let i = crisisIdx; i < rounds.length; i++) {
    if (rounds[i].rollsSpent > 0) return i - crisisIdx;
  }
  return rounds.length - 1 - crisisIdx;
}

function computeStreakStats(rounds: RoundSnapshot[]): {
  maxWinStreak: number;
  maxLossStreak: number;
  streakConversionRate: number;
} {
  const maxWinStreak = Math.max(0, ...rounds.filter(r => r.streakType === 'win').map(r => r.streakCount));
  const maxLossStreak = Math.max(0, ...rounds.filter(r => r.streakType === 'loss').map(r => r.streakCount));

  // Win-streak "episodes" — a run of consecutive rounds with streakType
  // 'win', tracking the highest streakCount reached during that run.
  const episodeMaxes: number[] = [];
  let curMax = 0;
  let inEpisode = false;
  for (const r of rounds) {
    if (r.streakType === 'win') {
      curMax = Math.max(curMax, r.streakCount);
      inEpisode = true;
    } else if (inEpisode) {
      episodeMaxes.push(curMax);
      curMax = 0;
      inEpisode = false;
    }
  }
  if (inEpisode) episodeMaxes.push(curMax);

  const reach2 = episodeMaxes.filter(m => m >= 2).length;
  const reach3 = episodeMaxes.filter(m => m >= 3).length;
  const streakConversionRate = reach2 > 0 ? reach3 / reach2 : 0;

  return { maxWinStreak, maxLossStreak, streakConversionRate };
}

function computeLevelDelta(context: MatchContext, targetLevel: number, benchmarkRound: string): number | null {
  const milestone = context.plan?.levelMilestones.find(m => m.level === targetLevel);
  if (!milestone) return null;
  return roundToNumber(milestone.round) - roundToNumber(benchmarkRound);
}

// Mirrors checkers/items.ts's checkSlamTiming condition (components live
// equipped-on-bench OR loose in the item tray, 2+ counts as "holding").
function computeComponentHoldRatio(rounds: RoundSnapshot[], meta: MetaData): number {
  const qualifying = rounds.filter(r => stageOf(r.label) >= 2);
  if (qualifying.length === 0) return 0;
  let holding = 0;
  for (const r of qualifying) {
    const benchComps = [...boardItemIds(r.bench), ...r.benchItems].filter(id => isComponent(id, meta));
    if (benchComps.length >= 2) holding++;
  }
  return holding / qualifying.length;
}

function computeCarryItemCountAt41(
  rounds: RoundSnapshot[],
  meta: MetaData,
  activeComp: Set<string>,
  carryDamage: Map<string, number>
): number {
  const r41 = rounds.find(r => r.label === '4-1');
  if (!r41) return 0;
  const units = Object.values(r41.board).filter(c => c?.name && c.name !== '0');
  if (units.length === 0) return 0;
  const carry = identifyCarry(units, meta, activeComp, carryDamage);
  return unitItems(carry).filter(id => !isComponent(id, meta)).length;
}

// The same "opponent's carry, by hex" ground truth checkers/positioning.ts's
// checkRepeatedOpponentCarry uses (real battle_stats top-damage unit,
// falling back to most-items) — as a raw key generator instead of a
// fired-and-reset streak counter, so an *average* run length can be measured
// (positioning.ts resets its own counter to 0 on every fire, which would
// undercount the true average considerably).
function opponentCarryKey(round: RoundSnapshot): string | null {
  const oppUnits = Object.entries(round.opponentBoard).filter(([, cell]) => !cell?.name?.includes('_PVE_'));
  if (oppUnits.length === 0) return null;

  let hex = '';
  let carry: Cell | null = null;

  const topDamageUnit = round.battleStats?.opponent.length
    ? [...round.battleStats.opponent].sort((a, b) => b.totalDamage - a.totalDamage)[0]
    : undefined;
  if (topDamageUnit) {
    const found = oppUnits.find(([, cell]) => cell?.name === topDamageUnit.name);
    if (found) { hex = found[0]; carry = found[1]; }
  }

  if (!carry) {
    let bestItems = -1;
    for (const [h, cell] of oppUnits) {
      if (!cell?.name) continue;
      const items = unitItems(cell).length;
      if (items > bestItems) { bestItems = items; hex = h; carry = cell; }
    }
  }
  if (!carry) return null;
  return `${carry.name}-${hex}`;
}

function computePositioningNoAdjustAvg(rounds: RoundSnapshot[]): number {
  const runs: number[] = [];
  let curKey: string | null = null;
  let curRun = 0;
  for (const round of rounds) {
    if (round.type !== 'PVP') continue;
    const key = opponentCarryKey(round);
    if (key === null) continue;
    if (key === curKey) {
      curRun++;
    } else {
      if (curKey !== null) runs.push(curRun);
      curKey = key;
      curRun = 1;
    }
  }
  if (curKey !== null) runs.push(curRun);
  return runs.length > 0 ? runs.reduce((a, b) => a + b, 0) / runs.length : 0;
}

// Mirrors checkers/positioning.ts's checkNoFrontline's ground truth (own-side
// row < HEX_ROWS/2 means "someone is holding the front"), without the augment
// frontline-exemption carve-out — that's a per-round coaching judgment call,
// not part of the raw geometric signal this continuous feature measures.
function computeNoFrontlineRatio(rounds: RoundSnapshot[]): number {
  const qualifying = rounds.filter(r => stageOf(r.label) >= 4 && r.type === 'PVP');
  if (qualifying.length === 0) return 0;
  let noFrontline = 0;
  for (const round of qualifying) {
    const ownEntries = Object.entries(round.board).filter(([, c]) => c?.name && c.name !== '0');
    const hasFrontline = ownEntries.some(([hex]) => {
      const pos = resolveHexCell(hex);
      return !!pos && pos.side === 'own' && pos.row < HEX_ROWS / 2;
    });
    if (!hasFrontline) noFrontline++;
  }
  return noFrontline / qualifying.length;
}

const MIN_COMPLETED_ITEMS = 2; // mirrors checkers/combat.ts's COMBAT_001 precondition

function computeCombatDamageStats(
  rounds: RoundSnapshot[],
  meta: MetaData,
  activeComp: Set<string>,
  carryDamage: Map<string, number>
): { carryDamageLeadRate: number | null; avgCarryDamageShareOfTeam: number | null } {
  let qualifying = 0;
  let leadCount = 0;
  let shareSum = 0;

  for (const round of rounds) {
    if (round.type !== 'PVP' || stageOf(round.label) < 4) continue;
    if (!round.battleStats?.own?.length) continue;

    const units = boardUnits(round.board);
    if (units.length === 0) continue;

    const carry = identifyCarry(units, meta, activeComp, carryDamage);
    const completedItems = unitItems(carry).filter(id => !isComponent(id, meta)).length;
    if (completedItems < MIN_COMPLETED_ITEMS) continue;

    const carryStats = round.battleStats.own.find(u => u.name === carry.name);
    if (!carryStats) continue;

    const teamDamage = round.battleStats.own.reduce((sum, u) => sum + u.totalDamage, 0);
    if (teamDamage <= 0) continue;

    const leader = [...round.battleStats.own].sort((a, b) => b.totalDamage - a.totalDamage)[0];

    qualifying++;
    if (leader.name === carryStats.name) leadCount++;
    shareSum += carryStats.totalDamage / teamDamage;
  }

  return {
    carryDamageLeadRate: qualifying > 0 ? leadCount / qualifying : null,
    avgCarryDamageShareOfTeam: qualifying > 0 ? shareSum / qualifying : null,
  };
}

function computeHpTrajectoryStats(rounds: RoundSnapshot[], context: MatchContext): {
  hpAtStage3Entry: number | null;
  hpAtStage4Entry: number | null;
  hpAtStage5Entry: number | null;
  hpRecoverySlope: number | null;
} {
  const at = (label: string) => rounds.find(r => r.label === label)?.health ?? null;

  const crisisIdx = rounds.findIndex(r => context.hpCrisisRounds.has(r.label));
  let hpRecoverySlope: number | null = null;
  if (crisisIdx >= 0) {
    let recoverIdx = rounds.length - 1;
    for (let i = crisisIdx; i < rounds.length; i++) {
      if (rounds[i].health >= 40) { recoverIdx = i; break; }
    }
    const span = recoverIdx - crisisIdx;
    hpRecoverySlope = span > 0 ? (rounds[recoverIdx].health - rounds[crisisIdx].health) / span : 0;
  }

  return {
    hpAtStage3Entry: at('3-1'),
    hpAtStage4Entry: at('4-1'),
    hpAtStage5Entry: at('5-1'),
    hpRecoverySlope,
  };
}

export function extractFeatureVector(
  match: MatchSnapshot,
  points: DecisionPoint[],
  context: MatchContext,
  meta: MetaData
): FeatureVector {
  const rounds = match.rounds;
  const activeComp = context.activeComp;
  const carryDamage = computeCarryDamage(match);

  const { bankingRatio, phaseSwitchCount } = computeEconCurveStats(rounds);
  const { maxWinStreak, maxLossStreak, streakConversionRate } = computeStreakStats(rounds);
  const combatStats = computeCombatDamageStats(rounds, meta, activeComp, carryDamage);
  const hpStats = computeHpTrajectoryStats(rounds, context);

  return {
    schemaVersion: 1,

    econBankingPhaseRatio: bankingRatio,
    econPhaseSwitchCount: phaseSwitchCount,
    interestMissedRoundCount: rounds.filter(r => isInterestMissed(r.goldEnd)).length,
    overcapRoundCount: rounds.filter(isOvercapIdle).length,
    preStage3RollGold: computePreStage3RollGold(rounds),

    rolldownLatencyRounds: computeRolldownLatency(rounds),
    postStabilizationOverrollGold: (points.find(p => p.ruleId === 'ROLL_003')?.reasonMetrics.totalWaste as number) ?? 0,
    level6RollDuringLossStreakGold: points
      .filter(p => p.ruleId === 'ROLL_004')
      .reduce((sum, p) => sum + ((p.reasonMetrics.goldRolled as number) ?? 0), 0),

    maxWinStreak,
    maxLossStreak,
    streakBreakCount: points.filter(p => p.ruleId === 'STREAK_001').length,
    streakConversionRate,

    level8DeltaRounds: computeLevelDelta(context, 8, '4-2'),
    level9DeltaRounds: computeLevelDelta(context, 9, '5-2'),

    componentHoldRoundRatio: computeComponentHoldRatio(rounds, meta),
    componentConversionsMissedCount: points.filter(p => p.ruleId === 'ITEM_005').length,
    carryItemCountAt41: computeCarryItemCountAt41(rounds, meta, activeComp, carryDamage),

    positioningNoAdjustStreakAvg: computePositioningNoAdjustAvg(rounds),
    noFrontlineRoundRatio: computeNoFrontlineRatio(rounds),

    carryDamageLeadRate: combatStats.carryDamageLeadRate,
    avgCarryDamageShareOfTeam: combatStats.avgCarryDamageShareOfTeam,

    hpCrisisRoundRatio: rounds.length > 0 ? context.hpCrisisRounds.size / rounds.length : 0,
    hpAtStage3Entry: hpStats.hpAtStage3Entry,
    hpAtStage4Entry: hpStats.hpAtStage4Entry,
    hpAtStage5Entry: hpStats.hpAtStage5Entry,
    hpRecoverySlope: hpStats.hpRecoverySlope,

    isRerollComp: context.isRerollComp ? 1 : 0,
    isFastTempo: context.isFastTempo ? 1 : 0,
    isSlowRoll: context.plan?.econStyle === 'slow_roll' ? 1 : 0,

    totalRounds: rounds.length,
  };
}
