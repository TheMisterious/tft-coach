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
//
// Below TRENDS_MIN_MATCHES the page shows progress toward that bar plus a
// made-up example profile (player-trends-sample.ts) in its own box, labelled
// "Example", so a new player can see what the page will hold (Overwolf QA).
// The example is never blended into the player's own sections.

import React from 'react';
import type { FeatureVector, PlayerProfile } from '../../shared/types';
import { TRENDS_MIN_MATCHES } from '../../profile/trend-model';
import { SAMPLE_PLAYER_PROFILE } from './player-trends-sample';
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
  scoutedRoundRatio: 'Stage 3+ rounds with a scout before the fight',
  contestedCoreMaxHolders: 'Opponents on your most contested unit',
  boardValueVsOpponentsRatio: 'Your board value against the boards you met',
  pairCopiesPassedCount: 'Pair upgrades shown and passed while losing',
  lowestHpWithBankRounds: 'Rounds entered as lowest HP with a bank',
  itemOfferPriorityMissCount: "Item choices passed on the carry's component",
  rolldownWindowRollGold: 'Gold rolled at 3-2, 4-1 and 4-2',
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

function correlationPhrase(value: number): string {
  const abs = Math.abs(value);
  const strength = abs >= 0.5 ? 'Strongly' : abs >= 0.3 ? 'Moderately' : abs >= 0.15 ? 'Slightly' : 'Barely';
  return `${strength} linked to ${value > 0 ? 'worse' : 'better'} finishes`;
}

const CONFIDENCE_COPY: Record<PlayerProfile['confidence'], string> = {
  insufficient_data: `Not enough matches yet — patterns need at least ${TRENDS_MIN_MATCHES} Player-Trends-eligible matches before anything reliable can show up here.`,
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
      {shown.length === 0 ? (
        <p className={styles.sectionNote}>No signal clears the noise floor yet at this sample size.</p>
      ) : (
        <ul className={styles.correlationList}>
          {shown.slice(0, 8).map(c => (
            <li key={c.feature} className={styles.correlationRow}>
              <span className={styles.correlationLabel}>{featureLabel(c.feature)}</span>
              <span
                className={c.r > 0 ? styles.correlationNeg : styles.correlationPos}
                title={`r = ${c.r.toFixed(2)}`}
              >
                {correlationPhrase(c.r)}
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
            <span
              className={coef > 0 ? styles.correlationNeg : styles.correlationPos}
              title={`coefficient = ${coef.toFixed(2)}`}
            >
              {correlationPhrase(coef)}
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

// Shown instead of ConfidenceBanner until the profile has enough matches.
// `profile` is null before the first match is ever saved.
function ProgressBanner({ profile }: { profile: PlayerProfile | null }) {
  const recorded = profile?.sampleSize ?? 0;
  const pct = Math.min(100, Math.round((recorded / TRENDS_MIN_MATCHES) * 100));
  return (
    <div className={styles.banner}>
      <span className={styles.bannerSample}>{recorded} of {TRENDS_MIN_MATCHES} matches recorded</span>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={TRENDS_MIN_MATCHES}
        aria-valuenow={recorded}
      >
        <div className={styles.progressFill} style={{ width: `${pct}%` }} />
      </div>
      <p className={styles.bannerText}>
        Player Trends is built from the matches coachv records on this PC — no account or sign-in needed.
        Keep coachv running while you play, and your own patterns replace the example below
        after {TRENDS_MIN_MATCHES} recorded matches.
      </p>
      {profile && profile.skippedStaleSchemaCount > 0 && (
        <p className={styles.bannerStale}>
          {profile.skippedStaleSchemaCount} older match(es) need reprocessing before they can count toward this.
        </p>
      )}
    </div>
  );
}

function SamplePreview() {
  return (
    <section className={styles.preview} aria-label="Example Player Trends, not your data">
      <div className={styles.previewHeader}>
        <span className={styles.previewTag}>Example</span>
        <span className={styles.previewNote}>
          What this page shows after {TRENDS_MIN_MATCHES} matches. Made-up numbers, not your data.
        </span>
      </div>
      <div className={styles.previewBody}>
        <CorrelationsList profile={SAMPLE_PLAYER_PROFILE} />
        <RegressionSection profile={SAMPLE_PLAYER_PROFILE} />
        <ClusterCards profile={SAMPLE_PLAYER_PROFILE} />
      </div>
    </section>
  );
}

export function PlayerTrendsView({ profile }: { profile: PlayerProfile | null }) {
  if (!profile || profile.confidence === 'insufficient_data') {
    return (
      <div className={styles.root}>
        <div className={styles.title}>Player Trends</div>
        <ProgressBanner profile={profile} />
        {/* The player's own early correlations, if any, before the example. */}
        {profile && <CorrelationsList profile={profile} />}
        <SamplePreview />
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
