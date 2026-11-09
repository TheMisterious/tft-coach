// A made-up PlayerProfile, shown only as a labelled preview while the player
// has too few matches for a real one (Overwolf QA: "show how this would look
// even if there is no data"). Never persisted, never mixed with real matches,
// and always rendered under an "Example" label — the numbers describe no one.
//
// Shaped like a 'moderate' profile so every section the view can show is
// filled in: placement correlations, the combined predictors, and two
// play-style clusters.

import type { PlayerProfile } from '../../shared/types';

export const SAMPLE_PLAYER_PROFILE: PlayerProfile = {
  computedAt: 0,
  sampleSize: 40,
  confidence: 'moderate',
  correlations: [
    { feature: 'hpCrisisRoundRatio',       r:  0.48, meaningfulAtN: true },
    { feature: 'carryItemCountAt41',       r: -0.41, meaningfulAtN: true },
    { feature: 'level8DeltaRounds',        r:  0.36, meaningfulAtN: true },
    { feature: 'streakConversionRate',     r: -0.27, meaningfulAtN: true },
    { feature: 'interestMissedRoundCount', r:  0.22, meaningfulAtN: true },
    { feature: 'preStage3RollGold',        r:  0.09, meaningfulAtN: false },
  ],
  regression: {
    coefficients: {
      hpCrisisRoundRatio:      0.42,
      carryItemCountAt41:     -0.35,
      level8DeltaRounds:       0.28,
      componentHoldRoundRatio: 0.19,
      maxWinStreak:           -0.16,
    },
    rSquared: 0.34,
    sampleSize: 40,
    sufficientData: true,
  },
  clusters: [
    {
      clusterId: 0,
      matchIds: [],
      size: 23,
      avgPlacement: 3.4,
      centroid: {
        econBankingPhaseRatio: 0.62,
        maxWinStreak: 4,
        maxLossStreak: 2,
        hpCrisisRoundRatio: 0.08,
        isRerollComp: 0,
        isFastTempo: 1,
      },
      dominantLabels: ['fast_tempo', 'standard'],
    },
    {
      clusterId: 1,
      matchIds: [],
      size: 17,
      avgPlacement: 5.6,
      centroid: {
        econBankingPhaseRatio: 0.31,
        maxWinStreak: 2,
        maxLossStreak: 5,
        hpCrisisRoundRatio: 0.29,
        isRerollComp: 1,
        isFastTempo: 0,
      },
      dominantLabels: ['reroll', 'slow_roll'],
    },
  ],
  skippedStaleSchemaCount: 0,
};
