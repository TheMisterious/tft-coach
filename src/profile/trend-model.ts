// Cross-match Player Trends model — turns a set of per-match FeatureVectors
// into a PlayerProfile: correlations, an optional regression, and optional
// play-style clusters. Deliberately conservative about confidence: this is
// single-user data in the tens-to-low-hundreds of matches, not the scale
// classical ML papers assume, and this project's whole history (see
// data/sets/set17/*.json's source_tier/confidence fields, rule-engine.ts's
// applyConfidenceHedge) is built around never overstating what the data
// actually supports.

import type { FeatureVector, MatchLabels, PlayerProfile, FeatureCorrelation, PlayStyleCluster } from '../shared/types';
import { pearsonCorrelation, ridgeRegression, kMeans } from './stats';

export interface FeatureRecord {
  matchId: string;
  featureVector: FeatureVector;
  labels: MatchLabels;
  placement: number;
}

const MIN_PAIRS_FOR_CORRELATION = 5;
const RIDGE_LAMBDA = 1.0;
const MIN_CLUSTER_SIZE = 5;

// Below this many eligible matches a profile is 'insufficient_data': raw
// correlations only, no regression or clusters. Exported so the Player Trends
// view can show progress toward it.
export const TRENDS_MIN_MATCHES = 15;

const FEATURE_KEYS: Array<keyof FeatureVector> = [
  'econBankingPhaseRatio', 'econPhaseSwitchCount', 'interestMissedRoundCount',
  'overcapRoundCount', 'preStage3RollGold',
  'rolldownLatencyRounds', 'postStabilizationOverrollGold', 'level6RollDuringLossStreakGold',
  'maxWinStreak', 'maxLossStreak', 'streakBreakCount', 'streakConversionRate',
  'level8DeltaRounds', 'level9DeltaRounds',
  'componentHoldRoundRatio', 'componentConversionsMissedCount', 'carryItemCountAt41',
  'positioningNoAdjustStreakAvg', 'noFrontlineRoundRatio',
  'carryDamageLeadRate', 'avgCarryDamageShareOfTeam',
  'hpCrisisRoundRatio', 'hpAtStage3Entry', 'hpAtStage4Entry', 'hpAtStage5Entry', 'hpRecoverySlope',
  'isRerollComp', 'isFastTempo', 'isSlowRoll',
  'scoutedRoundRatio', 'contestedCoreMaxHolders', 'boardValueVsOpponentsRatio',
  'pairCopiesPassedCount', 'lowestHpWithBankRounds', 'itemOfferPriorityMissCount', 'rolldownWindowRollGold',
  'totalRounds',
];

function computeCorrelations(records: FeatureRecord[]): FeatureCorrelation[] {
  const placements = records.map(r => r.placement);
  const out: FeatureCorrelation[] = [];

  for (const feature of FEATURE_KEYS) {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < records.length; i++) {
      const v = records[i].featureVector[feature];
      if (typeof v === 'number' && !Number.isNaN(v)) pairs.push([v, placements[i]]);
    }
    if (pairs.length < MIN_PAIRS_FOR_CORRELATION) continue;

    const r = pearsonCorrelation(pairs.map(p => p[0]), pairs.map(p => p[1]));
    const meaningfulAtN = Math.abs(r) > 2 / Math.sqrt(pairs.length);
    out.push({ feature, r, meaningfulAtN });
  }

  return out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}

// Regression/clustering both need complete rows — rather than imputing
// missing values (which would fabricate signal, e.g. a null "never reached
// level 8" reading as 0 = "reached it exactly on curve"), both are restricted
// to whichever features have a real numeric value on every record in the
// current sample. This subset shrinks/grows naturally as the match history
// does; it's recomputed fresh each time, never hardcoded.
function denseFeatureKeys(records: FeatureRecord[]): Array<keyof FeatureVector> {
  return FEATURE_KEYS.filter(key =>
    records.every(r => {
      const v = r.featureVector[key];
      return typeof v === 'number' && !Number.isNaN(v);
    })
  );
}

function buildMatrix(records: FeatureRecord[], keys: Array<keyof FeatureVector>): number[][] {
  return records.map(r => keys.map(k => r.featureVector[k] as number));
}

function computeRegression(records: FeatureRecord[], keys: Array<keyof FeatureVector>) {
  const X = buildMatrix(records, keys);
  const y = records.map(r => r.placement);
  const { coefficients, rSquared } = ridgeRegression(X, y, RIDGE_LAMBDA);

  const coefficientMap: Partial<Record<keyof FeatureVector, number>> = {};
  keys.forEach((k, i) => { coefficientMap[k] = coefficients[i]; });

  return {
    coefficients: coefficientMap,
    rSquared,
    sampleSize: records.length,
    sufficientData: records.length >= 3 * keys.length,
  };
}

function topLabels(records: FeatureRecord[]): string[] {
  const counts: Record<string, number> = {};
  for (const r of records) {
    for (const trait of r.labels.finalTraits) counts[trait] = (counts[trait] ?? 0) + 1;
    counts[r.labels.econStyle] = (counts[r.labels.econStyle] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label]) => label);
}

function computeClusters(records: FeatureRecord[], keys: Array<keyof FeatureVector>, k: number): PlayStyleCluster[] {
  if (keys.length === 0 || records.length < k) return [];
  const points = buildMatrix(records, keys);
  const { assignments } = kMeans(points, k);

  const clusters: PlayStyleCluster[] = [];
  for (let c = 0; c < k; c++) {
    const memberIdx = assignments.map((a, i) => (a === c ? i : -1)).filter(i => i >= 0);
    if (memberIdx.length < MIN_CLUSTER_SIZE) continue; // too small to call a real pattern rather than one outlier match

    const members = memberIdx.map(i => records[i]);
    const centroid: Partial<Record<keyof FeatureVector, number>> = {};
    for (const key of keys) {
      centroid[key] = members.reduce((s, r) => s + (r.featureVector[key] as number), 0) / members.length;
    }

    clusters.push({
      clusterId: c,
      matchIds: members.map(r => r.matchId),
      size: members.length,
      avgPlacement: members.reduce((s, r) => s + r.placement, 0) / members.length,
      centroid,
      dominantLabels: topLabels(members),
    });
  }
  return clusters;
}

export function buildPlayerProfile(records: FeatureRecord[], skippedStaleSchemaCount = 0): PlayerProfile {
  const n = records.length;
  const correlations = n > 0 ? computeCorrelations(records) : [];

  if (n < TRENDS_MIN_MATCHES) {
    return {
      computedAt: Date.now(),
      sampleSize: n,
      confidence: 'insufficient_data',
      correlations,
      clusters: [],
      skippedStaleSchemaCount,
    };
  }

  const keys = denseFeatureKeys(records);

  if (n < 30) {
    const regression = n >= 3 * keys.length ? computeRegression(records, keys) : undefined;
    return {
      computedAt: Date.now(),
      sampleSize: n,
      confidence: 'exploratory',
      correlations,
      regression,
      clusters: computeClusters(records, keys, 2),
      skippedStaleSchemaCount,
    };
  }

  const regression = n >= 3 * keys.length ? computeRegression(records, keys) : undefined;
  return {
    computedAt: Date.now(),
    sampleSize: n,
    // Capped at 'moderate' even here — single-user data in this range still
    // doesn't warrant a 'high' confidence tier. See module header.
    confidence: 'moderate',
    correlations,
    regression,
    clusters: computeClusters(records, keys, 3),
    skippedStaleSchemaCount,
  };
}
