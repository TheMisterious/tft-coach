import { describe, it, expect } from 'vitest';
import { checkAugments } from '../src/coach/checkers/augments';
import type { MatchSnapshot, RoundSnapshot, MetaData, BoardState, ChampionMeta } from '../src/shared/types';
import itemData from '../data/core/item-data.json';

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
    benchItems: [],
    shop: [],
    augmentsPicked: [],
    opponentBoard: {},
    interestEarned: 0,
    streakCount: 0,
    streakType: 'none',
    ...overrides,
  };
}

function makeMatch(overrides: Partial<MatchSnapshot>): MatchSnapshot {
  return {
    pseudoMatchId: 'test-match',
    setId: 'set17',
    gameMode: 'tft',
    rounds: [makeRound({})],
    finalPlacement: 4,
    finalBoard: {},
    augments: [],
    godPicks: [],
    ...overrides,
  };
}

function makeMeta(overrides: Partial<MetaData> = {}): MetaData {
  return {
    carryBis: {},
    traitBreakpoints: [],
    econBenchmarks: [],
    champions: {},
    items: {},
    itemData: itemData as MetaData['itemData'],
    augments: { economy: [], combat: [], items: [], units: [] },
    augmentNames: {},
    augmentModifiers: { itemBisOverrides: {}, traitCountBonuses: {}, frontlineExemptions: {} },
    comps: [],
    ...overrides,
  };
}

function cell(name: string, items: string[] = []): BoardState[string] {
  return { name, level: 1, item_1: items[0] ?? '0', item_2: items[1] ?? '0', item_3: items[2] ?? '0' };
}

const NASUS: ChampionMeta = { name: 'Nasus', tier: 3, role: 'carry', traits: [] };

describe('AUGMENT_003 — carry augment payoff unrealised', () => {
  it('fires when the named champion never made the final board', () => {
    const meta = makeMeta({ champions: { TFT17_Nasus: NASUS } });
    const match = makeMatch({ augments: ['TFT17_Augment_NasusCarry'], finalBoard: {} });
    const points = checkAugments(match, meta);
    const hit = points.find(p => p.ruleId === 'AUGMENT_003');
    expect(hit).toBeTruthy();
    expect(hit!.observed).toContain('Nasus');
    expect(hit!.observed).toContain('not on the final board');
  });

  it('fires (minor) when the champion is on board but under-itemised', () => {
    const meta = makeMeta({ champions: { TFT17_Nasus: NASUS } });
    const match = makeMatch({
      augments: ['TFT17_Augment_NasusCarry'],
      finalBoard: { cell_1: cell('TFT17_Nasus', ['TFT_Item_BFSword']) },
    });
    const points = checkAugments(match, meta);
    const hit = points.find(p => p.ruleId === 'AUGMENT_003');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('minor');
  });

  it('does not fire when the champion is on board with 2+ completed items', () => {
    const meta = makeMeta({ champions: { TFT17_Nasus: NASUS } });
    const match = makeMatch({
      augments: ['TFT17_Augment_NasusCarry'],
      finalBoard: {
        cell_1: cell('TFT17_Nasus', ['TFT_Item_Bloodthirster', 'TFT_Item_GuinsoosRageblade', 'TFT_Item_TitansResolve']),
      },
    });
    const points = checkAugments(match, meta);
    expect(points.find(p => p.ruleId === 'AUGMENT_003')).toBeUndefined();
  });

  it('does not fire for augment ids that are not the "<Champion>Carry" shape', () => {
    const meta = makeMeta({ champions: { TFT17_Nasus: NASUS } });
    const match = makeMatch({ augments: ['TFT17_Augment_Arbiter_DivineAmendment'], finalBoard: {} });
    const points = checkAugments(match, meta);
    expect(points.find(p => p.ruleId === 'AUGMENT_003')).toBeUndefined();
  });
});

describe('AUGMENT_004 — item-shaping augment without a built carry', () => {
  it('fires when an "items"-category augment was picked but no unit has 2+ completed items', () => {
    const meta = makeMeta({ augments: { economy: [], combat: [], items: ['TFT15_Augment_ChallengerCrest'], units: [] } });
    const match = makeMatch({
      augments: ['TFT15_Augment_ChallengerCrest'],
      finalBoard: { cell_1: cell('TFT17_Nasus', ['TFT_Item_BFSword']) },
    });
    const points = checkAugments(match, meta);
    const hit = points.find(p => p.ruleId === 'AUGMENT_004');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('moderate');
  });

  it('does not fire when some unit ended with 2+ completed items', () => {
    const meta = makeMeta({ augments: { economy: [], combat: [], items: ['TFT15_Augment_ChallengerCrest'], units: [] } });
    const match = makeMatch({
      augments: ['TFT15_Augment_ChallengerCrest'],
      finalBoard: { cell_1: cell('TFT17_Nasus', ['TFT_Item_Bloodthirster', 'TFT_Item_GuinsoosRageblade']) },
    });
    const points = checkAugments(match, meta);
    expect(points.find(p => p.ruleId === 'AUGMENT_004')).toBeUndefined();
  });

  it('does not fire when no items-category augment was picked', () => {
    const meta = makeMeta({ augments: { economy: [], combat: [], items: ['TFT15_Augment_ChallengerCrest'], units: [] } });
    const match = makeMatch({ augments: ['TFT_Augment_SomeOtherAugment'], finalBoard: {} });
    const points = checkAugments(match, meta);
    expect(points.find(p => p.ruleId === 'AUGMENT_004')).toBeUndefined();
  });
});
