import { describe, it, expect } from 'vitest';
import { checkPositioning } from '../src/coach/checkers/positioning';
import type { MatchSnapshot, RoundSnapshot, MetaData, BoardState, ChampionMeta, BattleStats } from '../src/shared/types';

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
  return {
    carryBis: {},
    traitBreakpoints: [],
    econBenchmarks: [],
    champions,
    items: {},
    itemData: {},
    augments: { economy: [], combat: [], items: [], units: [] },
    augmentNames: {},
    augmentModifiers: { itemBisOverrides: {}, traitCountBonuses: {}, frontlineExemptions: {} },
    comps: [],
  };
}

function opponentBoard(units: Array<[string, string, number]>): BoardState {
  // [hex, champId, itemCount]
  const board: BoardState = {};
  for (const [hex, name, itemCount] of units) {
    board[hex] = {
      name, level: 1,
      item_1: itemCount >= 1 ? 'TFT_Item_BFSword' : '0',
      item_2: itemCount >= 2 ? 'TFT_Item_RecurveBow' : '0',
      item_3: itemCount >= 3 ? 'TFT_Item_ChainVest' : '0',
    };
  }
  return board;
}

const JINX: ChampionMeta = { name: 'Jinx', tier: 4, role: 'carry', traits: [] };
const LEONA: ChampionMeta = { name: 'Leona', tier: 3, role: 'tank', traits: [] };

describe('POSITION_001 — carry identification via real damage data', () => {
  it('picks the top-damage unit over the most-itemised unit when battleStats is present', () => {
    const meta = makeMeta({ TFT17_Jinx: JINX, TFT17_Leona: LEONA });
    // Leona has more items (2) than Jinx (1), but Jinx dealt far more damage —
    // battle_stats should override the items-based proxy.
    const board = opponentBoard([['cell_36', 'TFT17_Jinx', 1], ['cell_37', 'TFT17_Leona', 2]]);
    const battleStats: BattleStats = {
      own: [],
      opponent: [
        { name: 'TFT17_Jinx', totalDamage: 5000, totalBlocked: 0, healed: 0, shielded: 0 },
        { name: 'TFT17_Leona', totalDamage: 300, totalBlocked: 2000, healed: 0, shielded: 0 },
      ],
    };
    const rounds = ['2-1', '2-2'].map(label =>
      makeRound({ label, opponentBoard: board, battleStats })
    );
    const points = checkPositioning(makeMatch(rounds), meta);
    const hit = points.find(p => p.ruleId === 'POSITION_001');
    expect(hit).toBeTruthy();
    expect(hit!.observed).toContain('Jinx');
    expect(hit!.reasonMetrics.carryDetection).toBe('damage');
  });

  it('falls back to the items heuristic when battleStats is absent', () => {
    const meta = makeMeta({ TFT17_Jinx: JINX, TFT17_Leona: LEONA });
    const board = opponentBoard([['cell_36', 'TFT17_Jinx', 1], ['cell_37', 'TFT17_Leona', 2]]);
    const rounds = ['2-1', '2-2'].map(label => makeRound({ label, opponentBoard: board }));
    const points = checkPositioning(makeMatch(rounds), meta);
    const hit = points.find(p => p.ruleId === 'POSITION_001');
    expect(hit).toBeTruthy();
    expect(hit!.observed).toContain('Leona');
    expect(hit!.reasonMetrics.carryDetection).toBe('items');
  });

  it('includes the real opponent name in the coaching text when available', () => {
    const meta = makeMeta({ TFT17_Jinx: JINX });
    const board = opponentBoard([['cell_36', 'TFT17_Jinx', 1]]);
    const rounds = ['2-1', '2-2'].map(label =>
      makeRound({ label, opponentBoard: board, opponentName: 'Ham Doughcat' })
    );
    const points = checkPositioning(makeMatch(rounds), meta);
    const hit = points.find(p => p.ruleId === 'POSITION_001');
    expect(hit!.coaching_text).toContain('Ham Doughcat');
  });
});
