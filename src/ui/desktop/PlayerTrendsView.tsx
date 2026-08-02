// Cross-match "Player Trends" view — the Player Trends model's report
// surface, separate from the single-match CoachingReportView. Reads the
// PlayerProfile directly from persistence (same direct-access pattern
// index.tsx already uses for loadMatch/listRecentMatches — no IPC needed,
// localStorage is shared across windows in this extension origin).
//
// Deliberately conservative in tone: confidence is never overstated (see
// src/profile/trend-model.ts's header comment) — the banner always states
// the real sample size, and regression/cluster sections simply don't render
// when the model didn't have enough data to compute them, rather than
// showing a hedged placeholder.

import React from 'react';
import type { FeatureVector, PlayerProfile } from '../../shared/types';
import styles from './PlayerTrendsView.module.css';

const FEATURE_LABELS: Partial<Record<keyof FeatureVector, string>> = {
  econBankingPhaseRatio: 'Time spent banking (not spending)',
  econPhaseSwitchCount: 'Banking/spending switches',
  interestMissedRoundCount: 'Rounds missing interest by 1-3g',
  overcapRoundCount: 'Rounds idle above the interest cap',
  preStage3RollGold: 'Gold rolled before stage 3',
  rolldownLatencyRounds: 'Rounds to respond to an HP crisis',
  postStabilizationOverrollGold: 'Gold over-rolled after stabilizing',
  level6RollDuringLossStreakGold: 'Gold rolled at level 6 mid loss-streak',
  maxWinStreak: 'Longest win streak',
  maxLossStreak: 'Longest loss streak',
  streakBreakCount: 'Win streaks of 3+ broken',
  streakConversionRate: 'Win streaks that reached 3+ (of those reaching 2+)',
  level8DeltaRounds: 'Level 8 timing vs. 4-2 benchmark',
  level9DeltaRounds: 'Level 9 timing vs. 5-2 benchmark',
  componentHoldRoundRatio: 'Rounds holding 2+ unbuilt components',
  componentConversionsMissedCount: 'Missed component conversions',
  carryItemCountAt41: 'Carry completed items at 4-1',
  positioningNoAdjustStreakAvg: 'Avg fights before repositioning vs. a static opponent carry',
  noFrontlineRoundRatio: 'Stage 4+ rounds with no frontline',
  carryDamageLeadRate: 'Rounds itemized carry led team damage',
  avgCarryDamageShareOfTeam: 'Avg carry share of team damage',
  hpCrisisRoundRatio: 'Rounds spent in an HP crisis',
  hpAtStage3Entry: 'HP entering stage 3',
  hpAtStage4Entry: 'HP entering stage 4',
  hpAtStage5Entry: 'HP entering stage 5',
  hpRecoverySlope: 'HP recovery rate after a crisis',
  isRerollComp: 'Playing a reroll comp',
  isFastTempo: 'Fast-tempo leveling',
  isSlowRoll: 'Slow-rolling',
  totalRounds: 'Match length (rounds)',
};

const HEADLINE_CLUSTER_FEATURES: Array<keyof FeatureVector> = [
  'econBankingPhaseRatio', 'maxWinStreak', 'maxLossStreak', 'hpCrisisRoundRatio', 'isRerollComp', 'isFastTempo',
];

function featureLabel(key: keyof FeatureVector): string {
  return FEATURE_LABELS[key] ?? String(key);
}

function formatFeatureValue(key: keyof FeatureVector, value: number): string {
  const k = String(key);
  if (k.startsWith('is')) return value >= 0.5 ? 'Yes' : 'No';
  if (/Ratio|Rate|Share/.test(k)) return `${Math.round(value * 100)}%`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const CONFIDENCE_COPY: Record<PlayerProfile['confidence'], string> = {
  insufficient_data: 'Not enough matches yet — patterns need at least 15 Player-Trends-eligible matches before anything reliable can show up here.',
  exploratory: 'Exploratory — patterns below are directional, not statistically reliable yet. More matches will sharpen this.',
  moderate: 'Based on your match history so far. Still single-player data — treat this as a strong hint, not a verdict.',
};

function ConfidenceBanner({ profile }: { profile: PlayerProfile }) {
  return (
    <div className={styles.banner}>
      <span className={styles.bannerSample}>{profile.sampleSize} matches analyzed</span>
      <p className={styles.bannerText}>{CONFIDENCE_COPY[profile.confidence]}</p>
      {profile.skippedStaleSchemaCount > 0 && (
        <p className={styles.bannerStale}>
          {profile.skippedStaleSchemaCount} older match(es) need reprocessing before they can count toward this.
        </p>
      )}
    </div>
  );
}

function CorrelationsList({ profile }: { profile: PlayerProfile }) {
  const shown = profile.correlations.filter(c => c.meaningfulAtN);
  const hidden = profile.correlations.length - shown.length;
  if (profile.correlations.length === 0) return null;

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>What correlates with your placement</h3>
      <p className={styles.sectionNote}>
        Positive means higher values here tend to show up in your worse finishes; negative means your better ones.
      </p>
      {shown.length === 0 ? (
        <p className={styles.sectionNote}>No signal clears the noise floor yet at this sample size.</p>
      ) : (
        <ul className={styles.correlationList}>
          {shown.slice(0, 8).map(c => (
            <li key={c.feature} className={styles.correlationRow}>
              <span className={styles.correlationLabel}>{featureLabel(c.feature)}</span>
              <span className={c.r > 0 ? styles.correlationNeg : styles.correlationPos}>
                {c.r > 0 ? '+' : ''}{c.r.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && <p className={styles.sectionNote}>{hidden} weaker signal(s) hidden.</p>}
    </section>
  );
}

function RegressionSection({ profile }: { profile: PlayerProfile }) {
  if (!profile.regression) return null;
  const entries = Object.entries(profile.regression.coefficients) as Array<[keyof FeatureVector, number]>;
  const top = entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6);

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Strongest combined predictors</h3>
      <p className={styles.sectionNote}>
        R² {profile.regression.rSquared.toFixed(2)} across {profile.regression.sampleSize} matches — higher means these
        features together explain more of your placement swings.
      </p>
      <ul className={styles.correlationList}>
        {top.map(([feature, coef]) => (
          <li key={feature} className={styles.correlationRow}>
            <span className={styles.correlationLabel}>{featureLabel(feature)}</span>
            <span className={coef > 0 ? styles.correlationNeg : styles.correlationPos}>
              {coef > 0 ? '+' : ''}{coef.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ClusterCards({ profile }: { profile: PlayerProfile }) {
  if (profile.clusters.length === 0) return null;

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Play-style patterns</h3>
      <div className={styles.clusterGrid}>
        {profile.clusters.map(cluster => (
          <div key={cluster.clusterId} className={styles.clusterCard}>
            <div className={styles.clusterHeader}>
              <span className={styles.clusterSize}>{cluster.size} matches</span>
              <span className={styles.clusterPlacement}>avg placement {cluster.avgPlacement.toFixed(1)}</span>
            </div>
            {cluster.dominantLabels.length > 0 && (
              <div className={styles.pillRow}>
                {cluster.dominantLabels.map(l => <span key={l} className={styles.pill}>{l}</span>)}
              </div>
            )}
            <ul className={styles.clusterFeatureList}>
              {HEADLINE_CLUSTER_FEATURES.filter(k => cluster.centroid[k] !== undefined).map(k => (
                <li key={k}>
                  <span className={styles.clusterFeatureLabel}>{featureLabel(k)}</span>
                  <span className={styles.clusterFeatureValue}>{formatFeatureValue(k, cluster.centroid[k]!)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PlayerTrendsView({ profile }: { profile: PlayerProfile | null }) {
  if (!profile) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>No Player Trends data yet</div>
        <div className={styles.emptySubtext}>Play (or reprocess) a match to start building your profile.</div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.title}>Player Trends</div>
      <ConfidenceBanner profile={profile} />
      <CorrelationsList profile={profile} />
      <RegressionSection profile={profile} />
      <ClusterCards profile={profile} />
    </div>
  );
}
