// Unit coverage for src/coach/checkers/combat.ts — the first checker to read
// the player's OWN side of GEP's real per-unit battle_stats (previously only
// positioning.ts read the opponent side, to infer the enemy carry).

import { describe, it, expect } from 'vitest';
import { checkCombat } from '../src/coach/checkers/combat';
import type {
  MatchSnapshot,
  RoundSnapshot,
  MetaData,
  ChampionMeta,
  BoardState,
  BattleStats,
} from '../src/shared/types';

function makeRound(overrides: Partial<RoundSnapshot>): RoundSnapshot {
  return {
    label: '4-1',
    type: 'PVP',
    goldStart: 0,
    goldEnd: 0,
    health: 100,
    level: 8,
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
    augments: {},
    augmentNames: {},
    augmentModifiers: { itemBisOverrides: {}, traitCountBonuses: {}, frontlineExemptions: {} },
    comps: [],
  };
}

const CARRY_ID = 'TFT17_Carry';
const OTHER_ID = 'TFT17_Other';

function itemizedBoard(): BoardState {
  return {
    b1: { name: CARRY_ID, level: 2, item_1: 'TFT_Item_BFSword', item_2: 'TFT_Item_RecurveBow', item_3: '0' },
    b2: { name: OTHER_ID, level: 2, item_1: '0', item_2: '0', item_3: '0' },
  };
}

function battleStats(carryDamage: number, otherDamage: number): BattleStats {
  return {
    own: [
      { name: CARRY_ID, totalDamage: carryDamage, totalBlocked: 0, healed: 0, shielded: 0 },
      { name: OTHER_ID, totalDamage: otherDamage, totalBlocked: 0, healed: 0, shielded: 0 },
    ],
    opponent: [],
  };
}

const CHAMPIONS: Record<string, ChampionMeta> = {
  [CARRY_ID]: { name: 'Carry', tier: 4, role: 'carry', traits: [] },
  [OTHER_ID]: { name: 'Other', tier: 1, role: 'flex', traits: [] },
};

describe('COMBAT_001 — itemized carry not leading own-team damage', () => {
  it('fires when the itemized carry is outdamaged for 2 consecutive stage-4+ fights', () => {
    const meta = makeMeta(CHAMPIONS);
    const rounds = [
      makeRound({ label: '4-1', board: itemizedBoard(), battleStats: battleStats(500, 1500) }),
      makeRound({ label: '4-2', board: itemizedBoard(), battleStats: battleStats(400, 1200) }),
    ];
    const points = checkCombat(makeMatch(rounds), meta);
    const hit = points.find(p => p.ruleId === 'COMBAT_001');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('moderate');
    expect(hit!.observed).toContain('Carry');
    expect(hit!.observed).toContain('Other');
  });

  it('does not fire when the carry leads team damage', () => {
    const meta = makeMeta(CHAMPIONS);
    const rounds = [
      makeRound({ label: '4-1', board: itemizedBoard(), battleStats: battleStats(1500, 500) }),
      makeRound({ label: '4-2', board: itemizedBoard(), battleStats: battleStats(1400, 600) }),
    ];
    const points = checkCombat(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'COMBAT_001')).toBeUndefined();
  });

  it('does not fire below 2 completed items on the carry', () => {
    const meta = makeMeta(CHAMPIONS);
    const underItemized: BoardState = {
      b1: { name: CARRY_ID, level: 2, item_1: 'TFT_Item_BFSword', item_2: '0', item_3: '0' },
      b2: { name: OTHER_ID, level: 2, item_1: '0', item_2: '0', item_3: '0' },
    };
    const rounds = [
      makeRound({ label: '4-1', board: underItemized, battleStats: battleStats(500, 1500) }),
      makeRound({ label: '4-2', board: underItemized, battleStats: battleStats(400, 1200) }),
    ];
    const points = checkCombat(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'COMBAT_001')).toBeUndefined();
  });

  it('does not fire before stage 4', () => {
    const meta = makeMeta(CHAMPIONS);
    const rounds = [
      makeRound({ label: '3-1', board: itemizedBoard(), battleStats: battleStats(500, 1500) }),
      makeRound({ label: '3-2', board: itemizedBoard(), battleStats: battleStats(400, 1200) }),
    ];
    const points = checkCombat(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'COMBAT_001')).toBeUndefined();
  });

  it('does not fire on a single occurrence (below the 2-fight threshold)', () => {
    const meta = makeMeta(CHAMPIONS);
    const rounds = [makeRound({ label: '4-1', board: itemizedBoard(), battleStats: battleStats(500, 1500) })];
    const points = checkCombat(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'COMBAT_001')).toBeUndefined();
  });

  it('does not fire when the outdamaging teammate is also fully itemized (a real second carry)', () => {
    const meta = makeMeta(CHAMPIONS);
    const dualCarryBoard: BoardState = {
      b1: { name: CARRY_ID, level: 2, item_1: 'TFT_Item_BFSword', item_2: 'TFT_Item_RecurveBow', item_3: '0' },
      b2: { name: OTHER_ID, level: 2, item_1: 'TFT_Item_BFSword', item_2: 'TFT_Item_RecurveBow', item_3: '0' },
    };
    const rounds = [
      makeRound({ label: '4-1', board: dualCarryBoard, battleStats: battleStats(500, 1500) }),
      makeRound({ label: '4-2', board: dualCarryBoard, battleStats: battleStats(400, 1200) }),
    ];
    const points = checkCombat(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'COMBAT_001')).toBeUndefined();
  });

  it('resets the streak once the carry leads a fight in between', () => {
    const meta = makeMeta(CHAMPIONS);
    const rounds = [
      makeRound({ label: '4-1', board: itemizedBoard(), battleStats: battleStats(500, 1500) }),
      makeRound({ label: '4-2', board: itemizedBoard(), battleStats: battleStats(1500, 500) }),
      makeRound({ label: '4-3', board: itemizedBoard(), battleStats: battleStats(400, 1200) }),
    ];
    const points = checkCombat(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'COMBAT_001')).toBeUndefined();
  });

  it('ignores a round with no real battle_stats (zero team damage)', () => {
    const meta = makeMeta(CHAMPIONS);
    const rounds = [
      makeRound({ label: '4-1', board: itemizedBoard(), battleStats: battleStats(0, 0) }),
      makeRound({ label: '4-2', board: itemizedBoard(), battleStats: battleStats(0, 0) }),
    ];
    const points = checkCombat(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'COMBAT_001')).toBeUndefined();
  });

  it('does not fire when battleStats is entirely absent for the round', () => {
    const meta = makeMeta(CHAMPIONS);
    const rounds = [
      makeRound({ label: '4-1', board: itemizedBoard() }),
      makeRound({ label: '4-2', board: itemizedBoard() }),
    ];
    const points = checkCombat(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'COMBAT_001')).toBeUndefined();
  });
});
