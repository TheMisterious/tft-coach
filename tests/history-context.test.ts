// Self-relative context (src/coach/history-context.ts) — the "is this my
// habit?" half of the report. Uses synthetic feature vectors rather than golden
// ledgers: the goldens are six matches from one player with no persisted
// feature history, and what needs testing here is the frequency arithmetic and
// its refusal thresholds, not ledger reconstruction.

import { describe, it, expect } from 'vitest';
import { historyClause, attachHistoryContext } from '../src/coach/history-context';
import type { MatchHistoryEntry } from '../src/coach/history-context';
import type { DecisionPoint, FeatureVector } from '../src/shared/types';

function vector(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    schemaVersion: 2,
    econBankingPhaseRatio: 0,
    econPhaseSwitchCount: 0,
    interestMissedRoundCount: 0,
    overcapRoundCount: 0,
    preStage3RollGold: 0,
    rolldownLatencyRounds: null,
    postStabilizationOverrollGold: 0,
    level6RollDuringLossStreakGold: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    streakBreakCount: 0,
    streakConversionRate: 0,
    level8DeltaRounds: null,
    level9DeltaRounds: null,
    componentHoldRoundRatio: 0,
    componentConversionsMissedCount: 0,
    carryItemCountAt41: 3,
    positioningNoAdjustStreakAvg: 0,
    noFrontlineRoundRatio: 0,
    carryDamageLeadRate: null,
    avgCarryDamageShareOfTeam: null,
    hpCrisisRoundRatio: 0,
    hpAtStage3Entry: null,
    hpAtStage4Entry: null,
    hpAtStage5Entry: null,
    hpRecoverySlope: null,
    isRerollComp: false,
    isFastTempo: false,
    isSlowRoll: false,
    totalRounds: 30,
    ...overrides,
  } as FeatureVector;
}

function history(flags: boolean[], overridesFor: (bad: boolean) => Partial<FeatureVector>): MatchHistoryEntry[] {
  return flags.map((bad, i) => ({
    matchId: `m${i}`,
    featureVector: vector(overridesFor(bad)),
    placement: 4,
  }));
}

const missedInterest = (bad: boolean) => ({ interestMissedRoundCount: bad ? 3 : 0 });

function point(ruleId: string): DecisionPoint {
  return {
    ruleId,
    round: '3-1',
    category: 'econ',
    severity: 'moderate',
    observed: 'observed',
    recommended: 'recommended',
    reasonMetrics: {},
    coaching_text: 'Base text.',
  } as DecisionPoint;
}

describe('historyClause', () => {
  it('says nothing below the minimum sample size', () => {
    // 4 matches, all bad — still refuses, because "4 of your last 4" from a
    // sample this small is noise dressed as a pattern.
    const h = history([true, true, true, true], missedInterest);
    expect(historyClause('ECON_001', h)).toBe('');
  });

  it('says nothing when the behaviour occurred only once before', () => {
    const h = history([true, false, false, false, false, false], missedInterest);
    expect(historyClause('ECON_001', h)).toBe('');
  });

  it('reports a recurrence once it has happened at least twice', () => {
    const h = history([true, true, false, false, false, false], missedInterest);
    const clause = historyClause('ECON_001', h);
    expect(clause).toContain('2 of your previous 6 matches');
    expect(clause).not.toContain('habit');
  });

  it('escalates to habit wording past the 60% rate', () => {
    const h = history([true, true, true, true, true, true, false, false, false, false], missedInterest);
    const clause = historyClause('ECON_001', h);
    expect(clause).toContain('habit');
    expect(clause).toContain('6 of your previous 10');
  });

  it('only counts the most recent 10 matches', () => {
    // 12 matches: the 6 oldest are bad, the 6 newest are clean. The window
    // holds 4 bad + 6 clean, so it must report 4 of 10, not 6 of 12 — a leak
    // the player has since fixed should stop being mentioned.
    const flags = [true, true, true, true, true, true, false, false, false, false, false, false];
    const clause = historyClause('ECON_001', history(flags, missedInterest));
    expect(clause).toContain('4 of your previous 10 matches');
  });

  it('mirrors each rule’s own threshold, not an approximation of it', () => {
    // HP_002 fires below 60 HP at 4-1. A history of exactly-60 matches is
    // therefore NOT a recurrence of it.
    const at60 = history([true, true, true, true, true, true], () => ({ hpAtStage4Entry: 60 }));
    expect(historyClause('HP_002', at60)).toBe('');

    const at59 = history([true, true, true, true, true, true], () => ({ hpAtStage4Entry: 59 }));
    expect(historyClause('HP_002', at59)).toContain('6 of your previous 6');
  });

  it('has no opinion on rules with no matching feature', () => {
    const h = history([true, true, true, true, true, true], missedInterest);
    // Lobby rules compare against a different table every game; augment and
    // set-mechanic rules have no feature-vector counterpart at all.
    for (const ruleId of ['LOBBY_001', 'LOBBY_002', 'AUGMENT_003', 'SET17_001', 'TRAIT_001']) {
      expect(historyClause(ruleId, h), ruleId).toBe('');
    }
  });

  it('survives a record missing a field an older schema did not have', () => {
    const h = history([true, true, true, true, true, true], missedInterest);
    delete (h[2].featureVector as unknown as Record<string, unknown>).interestMissedRoundCount;
    expect(() => historyClause('ECON_001', h)).not.toThrow();
    expect(historyClause('ECON_001', h)).toContain('5 of your previous 6');
  });
});

describe('attachHistoryContext', () => {
  const h = history([true, true, true, true, true, true], missedInterest);

  it('annotates only the first note of each rule', () => {
    const points = [point('ECON_001'), point('ECON_001'), point('ECON_001')];
    const out = attachHistoryContext(points, h);
    expect(out[0].coaching_text).toContain('previous 6 matches');
    expect(out[1].coaching_text).toBe('Base text.');
    expect(out[2].coaching_text).toBe('Base text.');
  });

  it('leaves severity, ruleId and reasonMetrics untouched', () => {
    const [before] = [point('ECON_001')];
    const [after] = attachHistoryContext([before], h);
    expect(after.severity).toBe(before.severity);
    expect(after.ruleId).toBe(before.ruleId);
    expect(after.reasonMetrics).toEqual(before.reasonMetrics);
  });

  it('is a no-op on a fresh install with too little history', () => {
    const points = [point('ECON_001')];
    expect(attachHistoryContext(points, [])).toEqual(points);
    expect(attachHistoryContext(points, h.slice(0, 3))).toEqual(points);
  });
});
