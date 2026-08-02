// Unit coverage for src/coach/meta-blend.ts — the contextual-blending logic
// that's the core requirement of this feature: meta stats must stay neutral
// reference info, and "you had a better option" (missedChampion) may only
// ever be claimed when real RoundSnapshot.shop evidence backs it up.

import { describe, it, expect } from 'vitest';
import { buildMetaContext, metaAugmentClause } from '../src/coach/meta-blend';
import type {
  MatchSnapshot, RoundSnapshot, MetaData, AggregateMetaTable, BoardState,
} from '../src/shared/types';

function makeRound(overrides: Partial<RoundSnapshot>): RoundSnapshot {
  return {
    label: '2-1', type: 'PVP', goldStart: 0, goldEnd: 0, health: 100, level: 1,
    rollsSpent: 0, xpBought: false, board: {}, bench: {}, benchItems: [], shop: [],
    augmentsPicked: [], opponentBoard: {}, interestEarned: 0, streakCount: 0, streakType: 'none',
    ...overrides,
  };
}

function makeMatch(rounds: RoundSnapshot[], finalPlacement = 6): MatchSnapshot {
  return {
    pseudoMatchId: 'test', setId: 'set17', gameMode: 'tft', rounds,
    finalPlacement, finalBoard: rounds.at(-1)?.board ?? {}, augments: [], godPicks: [],
  };
}

function makeMeta(metaTierTable?: AggregateMetaTable): MetaData {
  return {
    carryBis: {}, traitBreakpoints: [], econBenchmarks: [], champions: {}, items: {}, itemData: {},
    augments: {}, augmentNames: {}, augmentModifiers: { itemBisOverrides: {}, traitCountBonuses: {}, frontlineExemptions: {} },
    comps: [], metaTierTable,
  };
}

function bucket(samples: number, avgPlacement: number, top4Rate = 0.5) {
  return { samples, avgPlacement, top4Rate };
}

function boardOf(name: string): BoardState {
  return { c0: { name, level: 1, item_1: '0', item_2: '0', item_3: '0' } };
}

describe('buildMetaContext', () => {
  it('returns undefined when no metaTierTable exists yet', () => {
    const match = makeMatch([makeRound({})]);
    expect(buildMetaContext(match, ['TraitA'], makeMeta(undefined))).toBeUndefined();
  });

  it('surfaces compStanding when the final trait combo has enough samples', () => {
    const table: AggregateMetaTable = {
      champions: {}, augments: {}, computedAt: 0, matchSampleCount: 20,
      traitCombos: { 'TraitA,TraitB': bucket(20, 4.5) },
    };
    const match = makeMatch([makeRound({})]);
    const ctx = buildMetaContext(match, ['TraitB', 'TraitA'], makeMeta(table)); // unsorted input, key must still resolve
    expect(ctx?.compStanding).toEqual({ avgPlacement: 4.5, samples: 20 });
  });

  it('omits compStanding when the trait combo has too few samples', () => {
    const table: AggregateMetaTable = {
      champions: {}, augments: {}, computedAt: 0, matchSampleCount: 5,
      traitCombos: { TraitA: bucket(3, 4.5) },
    };
    const match = makeMatch([makeRound({})]);
    const ctx = buildMetaContext(match, ['TraitA'], makeMeta(table));
    expect(ctx?.compStanding).toBeUndefined();
  });

  it('surfaces missedChampion only with real shop-offer evidence: offered 3+ times, never owned, meaningfully better meta placement', () => {
    const table: AggregateMetaTable = {
      champions: { TFT17_Stronger: bucket(20, 3.0) }, // avg 3.0 vs this match's 6th place -> margin 3.0
      traitCombos: {}, augments: {}, computedAt: 0, matchSampleCount: 20,
    };
    const rounds = [
      makeRound({ label: '2-1', shop: ['TFT17_Stronger'] }),
      makeRound({ label: '2-2', shop: ['TFT17_Stronger'] }),
      makeRound({ label: '2-3', shop: ['TFT17_Stronger'] }),
    ];
    const match = makeMatch(rounds, 6);
    const ctx = buildMetaContext(match, [], makeMeta(table));
    // getChampionName falls back to a humanized id when the champion isn't
    // in meta.champions (this test's meta has an empty champions map) —
    // "Stronger" is the correct humanized form of "TFT17_Stronger".
    expect(ctx?.missedChampion).toEqual({ name: 'Stronger', avgPlacement: 3.0, offeredCount: 3 });
  });

  it('does NOT surface missedChampion when the champion was actually bought at any point (owned, not "missed")', () => {
    const table: AggregateMetaTable = {
      champions: { TFT17_Stronger: bucket(20, 3.0) },
      traitCombos: {}, augments: {}, computedAt: 0, matchSampleCount: 20,
    };
    const rounds = [
      makeRound({ label: '2-1', shop: ['TFT17_Stronger'] }),
      makeRound({ label: '2-2', shop: ['TFT17_Stronger'] }),
      makeRound({ label: '2-3', shop: ['TFT17_Stronger'], board: boardOf('TFT17_Stronger') }), // bought it
    ];
    const match = makeMatch(rounds, 6);
    const ctx = buildMetaContext(match, [], makeMeta(table));
    expect(ctx?.missedChampion).toBeUndefined();
  });

  it('does NOT surface missedChampion below the offer-count floor (avoids noise from a single shop sighting)', () => {
    const table: AggregateMetaTable = {
      champions: { TFT17_Stronger: bucket(20, 3.0) },
      traitCombos: {}, augments: {}, computedAt: 0, matchSampleCount: 20,
    };
    const rounds = [makeRound({ label: '2-1', shop: ['TFT17_Stronger'] })]; // only offered once
    const match = makeMatch(rounds, 6);
    const ctx = buildMetaContext(match, [], makeMeta(table));
    expect(ctx?.missedChampion).toBeUndefined();
  });

  it('does NOT surface missedChampion when the margin is too small to be meaningful', () => {
    const table: AggregateMetaTable = {
      champions: { TFT17_Similar: bucket(20, 5.7) }, // this match finished 6th -> margin only 0.3
      traitCombos: {}, augments: {}, computedAt: 0, matchSampleCount: 20,
    };
    const rounds = [
      makeRound({ label: '2-1', shop: ['TFT17_Similar'] }),
      makeRound({ label: '2-2', shop: ['TFT17_Similar'] }),
      makeRound({ label: '2-3', shop: ['TFT17_Similar'] }),
    ];
    const match = makeMatch(rounds, 6);
    const ctx = buildMetaContext(match, [], makeMeta(table));
    expect(ctx?.missedChampion).toBeUndefined();
  });
});

describe('metaAugmentClause', () => {
  it('returns an empty string when no metaTierTable exists', () => {
    expect(metaAugmentClause(makeMeta(undefined), 'TFT_Augment_Foo')).toBe('');
  });

  it('returns an empty string when the augment has too few samples', () => {
    const table: AggregateMetaTable = {
      champions: {}, traitCombos: {}, augments: { TFT_Augment_Foo: bucket(3, 4.0) },
      computedAt: 0, matchSampleCount: 3,
    };
    expect(metaAugmentClause(makeMeta(table), 'TFT_Augment_Foo')).toBe('');
  });

  it('returns an informational (never directive) sentence when enough samples exist', () => {
    const table: AggregateMetaTable = {
      champions: {}, traitCombos: {}, augments: { TFT_Augment_Foo: bucket(20, 4.2) },
      computedAt: 0, matchSampleCount: 20,
    };
    const clause = metaAugmentClause(makeMeta(table), 'TFT_Augment_Foo');
    expect(clause).toContain('4.2');
    expect(clause).toContain('20');
    expect(clause.toLowerCase()).not.toContain('should');
    expect(clause.toLowerCase()).not.toContain('mistake');
  });
});
