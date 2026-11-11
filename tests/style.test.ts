// The player style (src/profile/style.ts) and its match read
// (src/coach/style-context.ts): averages over the recent window with their
// sample sizes, the tempo split, the favourite lines, and which of this
// match's readings sat far enough from the average to be named.

import { describe, it, expect } from 'vitest';
import { buildPlayerStyle, STYLE_MIN_MATCHES, STYLE_WINDOW } from '../src/profile/style';
import { readStyleForMatch } from '../src/coach/style-context';
import type { MatchHistoryEntry } from '../src/coach/history-context';
import { FEATURE_SCHEMA_VERSION, type FeatureVector, type MatchLabels } from '../src/shared/types';

function vector(over: Partial<FeatureVector> = {}): FeatureVector {
  return {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    econBankingPhaseRatio: 0.5, econPhaseSwitchCount: 2, interestMissedRoundCount: 1,
    overcapRoundCount: 0, preStage3RollGold: 0,
    rolldownLatencyRounds: null, postStabilizationOverrollGold: 0, level6RollDuringLossStreakGold: 0,
    maxWinStreak: 2, maxLossStreak: 2, streakBreakCount: 0, streakConversionRate: 0.5,
    level8DeltaRounds: 0, level9DeltaRounds: null,
    componentHoldRoundRatio: 0.2, componentConversionsMissedCount: 0, carryItemCountAt41: 2,
    positioningNoAdjustStreakAvg: 1.5, noFrontlineRoundRatio: 0.1,
    carryDamageLeadRate: 0.5, avgCarryDamageShareOfTeam: 0.4,
    hpCrisisRoundRatio: 0.1, hpAtStage3Entry: 80, hpAtStage4Entry: 60, hpAtStage5Entry: 40, hpRecoverySlope: 1,
    isRerollComp: 0, isFastTempo: 0, isSlowRoll: 0,
    scoutedRoundRatio: 0.2, contestedCoreMaxHolders: 1, boardValueVsOpponentsRatio: 0.9,
    pairCopiesPassedCount: 0, lowestHpWithBankRounds: 0, itemOfferPriorityMissCount: 0, rolldownWindowRollGold: 20,
    totalRounds: 25,
    ...over,
  };
}

const labels = (traits: string[]): MatchLabels => ({ setId: 'set18', finalTraits: traits, augmentsPicked: [], econStyle: 'standard' });

function entry(i: number, over: Partial<FeatureVector> = {}, traits: string[] = [], placement = 4): MatchHistoryEntry {
  return { matchId: `m${i}`, featureVector: vector(over), placement, labels: labels(traits) };
}

describe('buildPlayerStyle', () => {
  it('is undefined below the minimum', () => {
    const few = Array.from({ length: STYLE_MIN_MATCHES - 1 }, (_, i) => entry(i));
    expect(buildPlayerStyle(few)).toBeUndefined();
    expect(buildPlayerStyle([...few, entry(99)])).toBeDefined();
  });

  it('splits the tempo and averages each trait with its sample size', () => {
    const style = buildPlayerStyle([
      entry(0, { isRerollComp: 1, hpAtStage4Entry: 40 }),
      entry(1, { isFastTempo: 1, hpAtStage4Entry: 50 }),
      entry(2, { isSlowRoll: 1, hpAtStage4Entry: 60 }),
      entry(3, { hpAtStage4Entry: 70 }),
      entry(4, { hpAtStage4Entry: 80 }),
      entry(5, { hpAtStage4Entry: null }),
    ])!;
    expect(style.sampleSize).toBe(6);
    expect(style.tempo).toEqual({ reroll: 1, fastTempo: 1, slowRoll: 1, standard: 3 });
    const hp = style.traits.find(t => t.key === 'hpAtStage4Entry')!;
    expect(hp.mean).toBe(60);
    expect(hp.n).toBe(5);
    expect(hp.text).toBe('60 HP');
    expect(style.summary[0]).toBe('Over your last 6 recorded games: reroll lines in 1, fast tempo in 1, slow-roll in 1, a standard curve in 3.');
    expect(style.summary).toContain('HP entering stage 4: 60 HP on average (5 games).');
  });

  it('leaves out a trait known in too few matches', () => {
    const style = buildPlayerStyle(Array.from({ length: 6 }, (_, i) => entry(i, { scoutedRoundRatio: i < 2 ? 0.5 : null })))!;
    expect(style.traits.find(t => t.key === 'scoutedRoundRatio')).toBeUndefined();
  });

  it('names the lines played most, with how they placed', () => {
    const style = buildPlayerStyle([
      entry(0, {}, ['Mage', 'Guardian'], 2), entry(1, {}, ['Guardian', 'Mage'], 4),
      entry(2, {}, ['Brawler', 'Ravager'], 7), entry(3, {}, ['Brawler', 'Ravager'], 5),
      entry(4, {}, ['Sorcerer'], 1), entry(5, {}, [], 3),
    ])!;
    expect(style.favouriteLines).toEqual([
      { line: 'Guardian/Mage', games: 2, avgPlacement: 3 },
      { line: 'Brawler/Ravager', games: 2, avgPlacement: 6 },
    ]);
    expect(style.summary).toContain('Most played: Guardian/Mage (2 games, average finish 3.0).');
  });

  it('reads only the most recent window', () => {
    const old = Array.from({ length: 10 }, (_, i) => entry(i, { hpAtStage4Entry: 20 }));
    const recent = Array.from({ length: STYLE_WINDOW }, (_, i) => entry(100 + i, { hpAtStage4Entry: 70 }));
    const style = buildPlayerStyle([...old, ...recent])!;
    expect(style.sampleSize).toBe(STYLE_WINDOW);
    expect(style.traits.find(t => t.key === 'hpAtStage4Entry')!.mean).toBe(70);
  });
});

describe('readStyleForMatch', () => {
  const history = Array.from({ length: 8 }, (_, i) => entry(i, { hpAtStage4Entry: 60, scoutedRoundRatio: 0.3, rolldownWindowRollGold: 20 }));

  it('names the readings that sit away from the usual, and only those', () => {
    const read = readStyleForMatch(history, vector({ hpAtStage4Entry: 31, scoutedRoundRatio: 0.35, rolldownWindowRollGold: 50 }))!;
    expect(read.sampleSize).toBe(8);
    expect(read.thisGame).toEqual([
      'HP entering stage 4: 31 HP this game against your usual 60 HP (8 games).',
      'Gold rolled at 3-2, 4-1 and 4-2: 50g this game against your usual 20g (8 games).',
    ]);
  });

  it('gives the usual game alone when this match has no vector', () => {
    const read = readStyleForMatch(history)!;
    expect(read.usual.length).toBeGreaterThan(1);
    expect(read.thisGame).toEqual([]);
  });

  it('is undefined with too little history', () => {
    expect(readStyleForMatch(history.slice(0, 3), vector())).toBeUndefined();
  });
});
