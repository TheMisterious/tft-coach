// Unit coverage for src/profile/trend-model.ts — focused on the sample-size
// gating behavior, since that's the property that actually protects this
// project's "never overstate confidence" rule (see the module's header
// comment). Exact correlation/regression/cluster VALUES are covered by
// profile-stats.test.ts against pure synthetic ground truth; this file
// checks that buildPlayerProfile wires the gating thresholds correctly.

import { describe, it, expect } from 'vitest';
import { buildPlayerProfile, type FeatureRecord } from '../src/profile/trend-model';
import type { FeatureVector, MatchLabels } from '../src/shared/types';

function makeFeatureVector(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    schemaVersion: 1,
    econBankingPhaseRatio: 0.5, econPhaseSwitchCount: 2, interestMissedRoundCount: 1,
    overcapRoundCount: 1, preStage3RollGold: 0,
    rolldownLatencyRounds: null, postStabilizationOverrollGold: 0, level6RollDuringLossStreakGold: 0,
    maxWinStreak: 2, maxLossStreak: 2, streakBreakCount: 0, streakConversionRate: 0.5,
    level8DeltaRounds: 0, level9DeltaRounds: null,
    componentHoldRoundRatio: 0.2, componentConversionsMissedCount: 0, carryItemCountAt41: 2,
    positioningNoAdjustStreakAvg: 1.5, noFrontlineRoundRatio: 0.1,
    carryDamageLeadRate: 0.5, avgCarryDamageShareOfTeam: 0.4,
    hpCrisisRoundRatio: 0.1, hpAtStage3Entry: 80, hpAtStage4Entry: 60, hpAtStage5Entry: 40, hpRecoverySlope: 1,
    isRerollComp: 0, isFastTempo: 0, isSlowRoll: 0,
    totalRounds: 25,
    ...overrides,
  };
}

function makeLabels(overrides: Partial<MatchLabels> = {}): MatchLabels {
  return { setId: 'set17', finalTraits: [], augmentsPicked: [], econStyle: 'standard', ...overrides };
}

function makeRecords(n: number, fvFn?: (i: number) => Partial<FeatureVector>, placementFn?: (i: number) => number): FeatureRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    matchId: `m${i}`,
    featureVector: makeFeatureVector(fvFn?.(i)),
    labels: makeLabels(),
    placement: placementFn ? placementFn(i) : 4,
  }));
}

describe('buildPlayerProfile — sample-size gating', () => {
  it('reports insufficient_data below n=15, with no regression and no clusters', () => {
    const profile = buildPlayerProfile(makeRecords(3));
    expect(profile.confidence).toBe('insufficient_data');
    expect(profile.regression).toBeUndefined();
    expect(profile.clusters).toEqual([]);
    expect(profile.sampleSize).toBe(3);
  });

  it('reports exploratory between n=15 and n=29', () => {
    const profile = buildPlayerProfile(makeRecords(20));
    expect(profile.confidence).toBe('exploratory');
  });

  it('reports moderate at n>=30, never higher', () => {
    const profile = buildPlayerProfile(makeRecords(40));
    expect(profile.confidence).toBe('moderate');
  });

  it('omits regression when n is below 3x the dense feature count even at exploratory/moderate tiers', () => {
    // All records share identical feature vectors here, so the dense feature
    // count is the full ~29 fields — 20 records is nowhere near 3x that.
    const profile = buildPlayerProfile(makeRecords(20));
    expect(profile.regression).toBeUndefined();
  });

  it('carries through skippedStaleSchemaCount so the UI can surface it', () => {
    const profile = buildPlayerProfile(makeRecords(3), 5);
    expect(profile.skippedStaleSchemaCount).toBe(5);
  });

  it('computes correlations even at insufficient_data confidence, once minimum pairs exist', () => {
    // Vary a feature and placement together so a real, non-zero correlation exists.
    const records = makeRecords(
      10,
      i => ({ maxWinStreak: i }),
      i => 8 - i // higher maxWinStreak -> better (lower) placement
    );
    const profile = buildPlayerProfile(records);
    expect(profile.confidence).toBe('insufficient_data'); // n=10 < 15
    const winStreakCorr = profile.correlations.find(c => c.feature === 'maxWinStreak');
    expect(winStreakCorr).toBeDefined();
    expect(winStreakCorr!.r).toBeLessThan(0); // more win-streak correlates with a lower (better) placement
  });

  it('drops clusters smaller than the minimum size instead of padding them', () => {
    // 20 identical records -> k-means on constant data collapses toward
    // fewer real clusters; whatever comes out must respect the size floor.
    const profile = buildPlayerProfile(makeRecords(20));
    for (const cluster of profile.clusters) {
      expect(cluster.size).toBeGreaterThanOrEqual(5);
    }
  });
});
