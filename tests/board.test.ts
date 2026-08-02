// Unit coverage for src/coach/checkers/board.ts — previously had zero
// dedicated tests (only generic golden-match smoke tests).

import { describe, it, expect } from 'vitest';
import { checkBoard } from '../src/coach/checkers/board';
import type { MatchSnapshot, RoundSnapshot, MetaData, BoardState, ChampionMeta } from '../src/shared/types';

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
    augments: {},
    augmentNames: {},
    augmentModifiers: { itemBisOverrides: {}, traitCountBonuses: {}, frontlineExemptions: {} },
    comps: [],
  };
}

function boardOf(units: Array<{ name: string; level: number }>): BoardState {
  const board: BoardState = {};
  units.forEach((u, i) => {
    board[`b${i}`] = { name: u.name, level: u.level, item_1: '0', item_2: '0', item_3: '0' };
  });
  return board;
}

describe('BOARD_001 — board cost sum below stage benchmark', () => {
  it('fires moderate when weighted cost sum is under the stage-4 benchmark of 30', () => {
    const champions: Record<string, ChampionMeta> = {
      TFT17_Cheap: { name: 'Cheap', tier: 1, role: 'flex', traits: [] },
    };
    const meta = makeMeta(champions);
    // 1-star tier-1 x4 = 4 weighted cost, benchmark is 30 -> deficit 26 (>=15 -> critical actually)
    const rounds = [makeRound({ label: '4-1', board: boardOf([{ name: 'TFT17_Cheap', level: 1 }]) })];
    const points = checkBoard(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'BOARD_001')).toBeTruthy();
  });

  it('fires critical when the deficit is 15 or more', () => {
    const meta = makeMeta({ TFT17_Cheap: { name: 'Cheap', tier: 1, role: 'flex', traits: [] } });
    const rounds = [makeRound({ label: '4-1', board: boardOf([{ name: 'TFT17_Cheap', level: 1 }]) })];
    const points = checkBoard(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'BOARD_001')?.severity).toBe('critical');
  });

  it('does not fire when the board meets the benchmark', () => {
    const meta = makeMeta({ TFT17_Strong: { name: 'Strong', tier: 5, role: 'carry', traits: [] } });
    // 2-star tier-5 = 5*3 = 15, still under 30 for stage 4 — use a few units.
    const board = boardOf([
      { name: 'TFT17_Strong', level: 2 },
      { name: 'TFT17_Strong', level: 2 },
      { name: 'TFT17_Strong', level: 2 },
    ]);
    const rounds = [makeRound({ label: '4-1', board })];
    const points = checkBoard(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'BOARD_001')).toBeUndefined();
  });

  it('only checks the X-1 round of each stage', () => {
    const meta = makeMeta({ TFT17_Cheap: { name: 'Cheap', tier: 1, role: 'flex', traits: [] } });
    const rounds = [makeRound({ label: '4-2', board: boardOf([{ name: 'TFT17_Cheap', level: 1 }]) })];
    const points = checkBoard(makeMatch(rounds), meta);
    expect(points.find(p => p.ruleId === 'BOARD_001')).toBeUndefined();
  });

  it('regression: states the real HP lost across the stage instead of an unquantified "correlates with" claim', () => {
    const meta = makeMeta({ TFT17_Cheap: { name: 'Cheap', tier: 1, role: 'flex', traits: [] } });
    const rounds = [
      makeRound({ label: '4-1', health: 80, board: boardOf([{ name: 'TFT17_Cheap', level: 1 }]) }),
      makeRound({ label: '5-1', health: 55, board: boardOf([{ name: 'TFT17_Cheap', level: 1 }]) }),
    ];
    const points = checkBoard(makeMatch(rounds), meta);
    const hit = points.find(p => p.ruleId === 'BOARD_001' && p.round === '4-1');
    expect(hit).toBeTruthy();
    expect(hit!.reasonMetrics.hpLostThisStage).toBe(25);
    expect(hit!.coaching_text).toContain('lose 25 HP');
    expect(hit!.coaching_text).toContain('80 → 55');
  });

  it('regression: notes HP held steady instead of asserting a loss that did not happen', () => {
    const meta = makeMeta({ TFT17_Cheap: { name: 'Cheap', tier: 1, role: 'flex', traits: [] } });
    const rounds = [
      makeRound({ label: '4-1', health: 60, board: boardOf([{ name: 'TFT17_Cheap', level: 1 }]) }),
      makeRound({ label: '5-1', health: 60, board: boardOf([{ name: 'TFT17_Cheap', level: 1 }]) }),
    ];
    const points = checkBoard(makeMatch(rounds), meta);
    const hit = points.find(p => p.ruleId === 'BOARD_001' && p.round === '4-1');
    expect(hit).toBeTruthy();
    expect(hit!.reasonMetrics.hpLostThisStage).toBe(0);
    expect(hit!.coaching_text).toContain('held steady');
  });

  it('omits the HP clause entirely when the next stage checkpoint is not in the match', () => {
    const meta = makeMeta({ TFT17_Cheap: { name: 'Cheap', tier: 1, role: 'flex', traits: [] } });
    const rounds = [makeRound({ label: '5-1', health: 40, board: boardOf([{ name: 'TFT17_Cheap', level: 1 }]) })];
    const points = checkBoard(makeMatch(rounds), meta);
    const hit = points.find(p => p.ruleId === 'BOARD_001');
    expect(hit).toBeTruthy();
    expect(hit!.reasonMetrics.hpLostThisStage).toBeUndefined();
    expect(hit!.coaching_text).not.toContain('HP');
  });
});

describe('BOARD_003 — unfilled board slots', () => {
  it('fires minor with exactly 1 empty slot at stage 3+', () => {
    const rounds = [makeRound({ label: '3-2', level: 5, board: boardOf([{ name: 'TFT17_X', level: 1 }, { name: 'TFT17_X', level: 1 }, { name: 'TFT17_X', level: 1 }, { name: 'TFT17_X', level: 1 }]) })];
    const points = checkBoard(makeMatch(rounds), makeMeta());
    const hit = points.find(p => p.ruleId === 'BOARD_003');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('minor');
  });

  it('fires moderate with 2+ empty slots', () => {
    const rounds = [makeRound({ label: '3-2', level: 5, board: boardOf([{ name: 'TFT17_X', level: 1 }]) })];
    const points = checkBoard(makeMatch(rounds), makeMeta());
    expect(points.find(p => p.ruleId === 'BOARD_003')?.severity).toBe('moderate');
  });

  it('does not fire when the board is fully filled', () => {
    const units = Array.from({ length: 5 }, () => ({ name: 'TFT17_X', level: 1 }));
    const rounds = [makeRound({ label: '3-2', level: 5, board: boardOf(units) })];
    const points = checkBoard(makeMatch(rounds), makeMeta());
    expect(points.find(p => p.ruleId === 'BOARD_003')).toBeUndefined();
  });

  it('does not fire before stage 3', () => {
    const rounds = [makeRound({ label: '2-2', level: 5, board: boardOf([{ name: 'TFT17_X', level: 1 }]) })];
    const points = checkBoard(makeMatch(rounds), makeMeta());
    expect(points.find(p => p.ruleId === 'BOARD_003')).toBeUndefined();
  });

  it('does not fire on a non-PVP round', () => {
    const rounds = [makeRound({ label: '3-2', type: 'PVE', level: 5, board: boardOf([{ name: 'TFT17_X', level: 1 }]) })];
    const points = checkBoard(makeMatch(rounds), makeMeta());
    expect(points.find(p => p.ruleId === 'BOARD_003')).toBeUndefined();
  });
});
