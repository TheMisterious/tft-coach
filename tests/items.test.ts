// Unit coverage for src/coach/checkers/items.ts — previously had zero
// dedicated tests (only generic golden-match smoke tests). Uses real
// data/core/item-data.json (composition + stats fetched from Community
// Dragon) rather than mocking recipe data, so these tests break for real if
// the fetched item data or the checker's recipe-lookup logic ever drifts.

import { describe, it, expect } from 'vitest';
import { checkItems } from '../src/coach/checkers/items';
import type { MatchSnapshot, RoundSnapshot, MetaData, MatchContext, BoardState, ChampionMeta } from '../src/shared/types';
import itemData from '../data/core/item-data.json';
import itemNames from '../data/core/items.json';

function makeRound(overrides: Partial<RoundSnapshot>): RoundSnapshot {
  return {
    label: '2-1',
    type: 'PVP',
    goldStart: 0,
    goldEnd: 0,
    health: 100,
    level: 4,
    rollsSpent: 0,
    xpBought: false,
    board: {},
    bench: {},
    shop: [],
    augmentsPicked: [],
    opponentBoard: {},
    interestEarned: 0,
    streakCount: 0,
    streakType: 'none',
    ...overrides,
  };
}

function makeMatch(rounds: RoundSnapshot[]): MatchSnapshot {
  return {
    pseudoMatchId: 'test-match',
    setId: 'set17',
    gameMode: 'tft',
    rounds,
    finalPlacement: 4,
    finalBoard: rounds.at(-1)?.board ?? {},
    augments: [],
    godPicks: [],
  };
}

function makeMeta(champions: Record<string, ChampionMeta> = {}): MetaData {
  const { _comment, ...names } = itemNames as Record<string, string>;
  return {
    carryBis: {},
    traitBreakpoints: [],
    econBenchmarks: [],
    champions,
    items: names,
    itemData: itemData as MetaData['itemData'],
    augments: {},
    augmentNames: {},
    augmentModifiers: { itemBisOverrides: {}, traitCountBonuses: {}, frontlineExemptions: {} },
    comps: [],
  };
}

function benchWith(itemsOnCell: string[]): BoardState {
  return {
    bench1: {
      name: 'TFT17_Test',
      level: 1,
      item_1: itemsOnCell[0] ?? '0',
      item_2: itemsOnCell[1] ?? '0',
      item_3: itemsOnCell[2] ?? '0',
    },
  };
}

describe('ITEM_005 — component conversion opportunity', () => {
  it('fires moderate severity when held components match an HP-crisis need', () => {
    const meta = makeMeta();
    const context: MatchContext = {
      isRerollComp: false,
      hpCrisisRounds: new Set(['2-2', '2-3', '2-4']),
      activeComp: new Set(),
      isFastTempo: false,
    };
    const rounds = ['2-2', '2-3', '2-4'].map(label =>
      makeRound({ label, health: 30, bench: benchWith(['TFT_Item_ChainVest', 'TFT_Item_ChainVest']) })
    );
    const points = checkItems(makeMatch(rounds), meta, context);
    const hit = points.find(p => p.ruleId === 'ITEM_005');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('moderate');
    expect(hit!.recommended).toContain('Bramble Vest');
    expect(hit!.recommended).toContain('matches what your board needed');
  });

  it('fires minor severity when held components do not match the round need', () => {
    const meta = makeMeta();
    const context: MatchContext = {
      isRerollComp: false,
      hpCrisisRounds: new Set(['2-2', '2-3', '2-4']), // crisis -> wants tank/sustain
      activeComp: new Set(),
      isFastTempo: false,
    };
    // B.F. Sword + Sparring Gloves -> Infinity Edge, an offense item — doesn't
    // fit the crisis need for tank/sustain.
    const rounds = ['2-2', '2-3', '2-4'].map(label =>
      makeRound({ label, health: 30, bench: benchWith(['TFT_Item_BFSword', 'TFT_Item_SparringGloves']) })
    );
    const points = checkItems(makeMatch(rounds), meta, context);
    const hit = points.find(p => p.ruleId === 'ITEM_005');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('minor');
    expect(hit!.recommended).toContain('Infinity Edge');
  });

  it('fires moderate severity for an offense-matching pair outside a crisis', () => {
    const meta = makeMeta();
    const context: MatchContext = {
      isRerollComp: false,
      hpCrisisRounds: new Set(),
      activeComp: new Set(),
      isFastTempo: false,
    };
    const rounds = ['2-2', '2-3', '2-4'].map(label =>
      makeRound({ label, health: 80, bench: benchWith(['TFT_Item_BFSword', 'TFT_Item_SparringGloves']) })
    );
    const points = checkItems(makeMatch(rounds), meta, context);
    const hit = points.find(p => p.ruleId === 'ITEM_005');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('moderate');
  });

  it('does not fire before 3 consecutive rounds', () => {
    const meta = makeMeta();
    const context: MatchContext = { isRerollComp: false, hpCrisisRounds: new Set(), activeComp: new Set(), isFastTempo: false };
    const rounds = ['2-2', '2-3'].map(label =>
      makeRound({ label, bench: benchWith(['TFT_Item_ChainVest', 'TFT_Item_ChainVest']) })
    );
    const points = checkItems(makeMatch(rounds), meta, context);
    expect(points.find(p => p.ruleId === 'ITEM_005')).toBeUndefined();
  });

  it('fires only once per pair per match, not every round past the threshold', () => {
    const meta = makeMeta();
    const context: MatchContext = { isRerollComp: false, hpCrisisRounds: new Set(), activeComp: new Set(), isFastTempo: false };
    const rounds = ['2-2', '2-3', '2-4', '2-5', '2-6'].map(label =>
      makeRound({ label, bench: benchWith(['TFT_Item_BFSword', 'TFT_Item_SparringGloves']) })
    );
    const points = checkItems(makeMatch(rounds), meta, context);
    expect(points.filter(p => p.ruleId === 'ITEM_005')).toHaveLength(1);
  });
});

describe('ITEM_001 — delayed item slam (real component data)', () => {
  it('fires when 2+ real components sit on the bench for 3+ consecutive rounds', () => {
    const meta = makeMeta();
    const rounds = ['2-2', '2-3', '2-4'].map(label =>
      makeRound({ label, bench: benchWith(['TFT_Item_GiantsBelt', 'TFT_Item_RecurveBow']) })
    );
    const points = checkItems(makeMatch(rounds), meta);
    expect(points.some(p => p.ruleId === 'ITEM_001')).toBe(true);
  });
});

describe('ITEM_002 — offense items on a tank-role unit (real tag data)', () => {
  it('fires when a tank-role unit holds 2+ real offense-tagged items', () => {
    const champions: Record<string, ChampionMeta> = {
      TFT17_Test: { name: 'Test Tank', tier: 1, role: 'tank', traits: [] },
    };
    const meta = makeMeta(champions);
    const board: BoardState = {
      board1: {
        name: 'TFT17_Test', level: 2,
        item_1: 'TFT_Item_InfinityEdge', item_2: 'TFT_Item_GuinsoosRageblade', item_3: '0',
      },
    };
    const rounds = [makeRound({ label: '5-1', board })];
    const points = checkItems(makeMatch(rounds), meta);
    expect(points.some(p => p.ruleId === 'ITEM_002')).toBe(true);
  });
});
