// Unit coverage for src/persistence/db.ts's match-history cap. Previously the
// index capped at 200 entries but the underlying tft:match:<id> blobs for
// anything older were never deleted — this covers the fix (trimIndex /
// evictOldest) plus the quota-exceeded retry path.
//
// Vitest's default environment has no `localStorage` global (that's a jsdom
// thing, not configured here) — this installs a minimal in-memory mock
// before importing db.ts, which reads the real global directly.

import { describe, it, expect, beforeEach } from 'vitest';

class MemoryStorage {
  private store = new Map<string, string>();
  quotaBytes = Infinity;

  private size(): number {
    let total = 0;
    for (const [k, v] of this.store) total += k.length + v.length;
    return total;
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    const existing = this.store.get(key)?.length ?? 0;
    const projected = this.size() - existing + key.length + value.length;
    if (projected > this.quotaBytes) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get length(): number {
    return this.store.size;
  }
}

let mockStorage: MemoryStorage;

beforeEach(() => {
  mockStorage = new MemoryStorage();
  (globalThis as any).localStorage = mockStorage;
});

import { saveMatch, loadMatch, listRecentMatches, loadAllFeatureRecords, savePlayerProfile, loadPlayerProfile } from '../src/persistence/db';
import type { MatchRecord, FeatureVector, MatchLabels, PlayerProfile } from '../src/shared/types';

function makeRecord(id: string, overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    pseudoMatchId: id,
    datePlayed: Date.now(),
    setId: 'set17',
    placement: 4,
    lastRound: '5-1',
    ...overrides,
  };
}

describe('saveMatch — history cap and blob eviction', () => {
  it('caps the index at 200 entries and deletes the evicted blobs', () => {
    for (let i = 0; i < 205; i++) {
      saveMatch(makeRecord(`m${i}`));
    }
    expect(listRecentMatches(1000)).toHaveLength(200);

    // The 5 oldest (m0..m4) should be evicted from both index and blob storage.
    expect(loadMatch('m0')).toBeNull();
    expect(loadMatch('m4')).toBeNull();
    // The newest should still be there.
    expect(loadMatch('m204')).not.toBeNull();
  });

  it('does not leave an orphaned blob for an index entry that fell off the cap', () => {
    for (let i = 0; i < 201; i++) {
      saveMatch(makeRecord(`m${i}`));
    }
    // m0 was the very first saved and should be the one evicted (index unshifts newest-first).
    expect(mockStorage.getItem('tft:match:m0')).toBeNull();
  });

  it('evicts the oldest matches and retries once when localStorage quota is exceeded', () => {
    mockStorage.quotaBytes = 2000;
    for (let i = 0; i < 20; i++) {
      saveMatch(makeRecord(`m${i}`, { lastRound: 'x'.repeat(100) }));
    }
    // Newest match must have made it in despite hitting quota along the way.
    expect(loadMatch('m19')).not.toBeNull();
    // Some of the oldest matches must have been evicted to make room.
    expect(loadMatch('m0')).toBeNull();
  });
});

function makeFeatureVector(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    schemaVersion: 1,
    econBankingPhaseRatio: 0.5, econPhaseSwitchCount: 0, interestMissedRoundCount: 0,
    overcapRoundCount: 0, preStage3RollGold: 0,
    rolldownLatencyRounds: null, postStabilizationOverrollGold: 0, level6RollDuringLossStreakGold: 0,
    maxWinStreak: 0, maxLossStreak: 0, streakBreakCount: 0, streakConversionRate: 0,
    level8DeltaRounds: null, level9DeltaRounds: null,
    componentHoldRoundRatio: 0, componentConversionsMissedCount: 0, carryItemCountAt41: 0,
    positioningNoAdjustStreakAvg: 0, noFrontlineRoundRatio: 0,
    carryDamageLeadRate: null, avgCarryDamageShareOfTeam: null,
    hpCrisisRoundRatio: 0, hpAtStage3Entry: null, hpAtStage4Entry: null, hpAtStage5Entry: null, hpRecoverySlope: null,
    isRerollComp: 0, isFastTempo: 0, isSlowRoll: 0,
    totalRounds: 25,
    ...overrides,
  };
}

function makeLabels(overrides: Partial<MatchLabels> = {}): MatchLabels {
  return { setId: 'set17', finalTraits: [], augmentsPicked: [], econStyle: 'standard', ...overrides };
}

describe('loadAllFeatureRecords / savePlayerProfile / loadPlayerProfile', () => {
  it('only returns matches that have both featureVector and matchLabels', () => {
    saveMatch(makeRecord('with-fv', { featureVector: makeFeatureVector(), matchLabels: makeLabels() }));
    saveMatch(makeRecord('without-fv'));

    const { records, skippedStaleSchemaCount } = loadAllFeatureRecords();
    expect(records).toHaveLength(1);
    expect(records[0].matchId).toBe('with-fv');
    expect(skippedStaleSchemaCount).toBe(0);
  });

  it('skips and counts records with a stale schemaVersion instead of including them', () => {
    const staleFv = { ...makeFeatureVector(), schemaVersion: 0 as unknown as 1 };
    saveMatch(makeRecord('stale', { featureVector: staleFv, matchLabels: makeLabels() }));
    saveMatch(makeRecord('current', { featureVector: makeFeatureVector(), matchLabels: makeLabels() }));

    const { records, skippedStaleSchemaCount } = loadAllFeatureRecords();
    expect(records).toHaveLength(1);
    expect(records[0].matchId).toBe('current');
    expect(skippedStaleSchemaCount).toBe(1);
  });

  it('round-trips a PlayerProfile through save/load', () => {
    const profile: PlayerProfile = {
      computedAt: Date.now(),
      sampleSize: 20,
      confidence: 'exploratory',
      correlations: [],
      clusters: [],
      skippedStaleSchemaCount: 0,
    };
    expect(loadPlayerProfile()).toBeNull();
    savePlayerProfile(profile);
    expect(loadPlayerProfile()).toEqual(profile);
  });
});
