// Unit coverage for src/coach/checkers/rolling.ts — previously had zero
// dedicated tests (only generic golden-match smoke tests).

import { describe, it, expect } from 'vitest';
import { checkRolling } from '../src/coach/checkers/rolling';
import type {
  MatchSnapshot,
  RoundSnapshot,
  MetaData,
  MatchContext,
  BoardState,
  ChampionMeta,
} from '../src/shared/types';

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

const NEUTRAL: MatchContext = {
  isRerollComp: false,
  hpCrisisRounds: new Set(),
  activeComp: new Set(),
  isFastTempo: false,
};

function boardWith(name: string, level: number, items: string[] = []): BoardState {
  return {
    b1: { name, level, item_1: items[0] ?? '0', item_2: items[1] ?? '0', item_3: items[2] ?? '0' },
  };
}

// checkPostStabilizationRoll requires 2+ item-bearing 2-star units to count a
// round as "stabilised" — a single unit isn't enough to trigger it.
function stabilisedBoard(): BoardState {
  return {
    b1: { name: 'TFT17_X', level: 2, item_1: 'TFT_Item_BFSword', item_2: '0', item_3: '0' },
    b2: { name: 'TFT17_Y', level: 2, item_1: 'TFT_Item_BFSword', item_2: '0', item_3: '0' },
  };
}

describe('ROLL_001 — over-rolling at bad odds', () => {
  it('fires when 15g+ is rolled at a level where the inferred carry cost has ≤10% odds', () => {
    const meta = makeMeta({ TFT17_Carry: { name: 'Carry', tier: 4, role: 'carry', traits: [] } });
    const rounds = [makeRound({ label: '3-3', level: 6, rollsSpent: 10, board: boardWith('TFT17_Carry', 1) })];
    const points = checkRolling(makeMatch(rounds), meta, NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_001')).toBeTruthy();
  });

  it('does not fire when odds are above 10% at the current level', () => {
    const meta = makeMeta({ TFT17_Carry: { name: 'Carry', tier: 4, role: 'carry', traits: [] } });
    const rounds = [makeRound({ label: '3-3', level: 9, rollsSpent: 10, board: boardWith('TFT17_Carry', 1) })];
    const points = checkRolling(makeMatch(rounds), meta, NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_001')).toBeUndefined();
  });

  it('is suppressed for a detected reroll comp', () => {
    const meta = makeMeta({ TFT17_Carry: { name: 'Carry', tier: 4, role: 'carry', traits: [] } });
    const rounds = [makeRound({ label: '3-3', level: 6, rollsSpent: 10, board: boardWith('TFT17_Carry', 1) })];
    const context: MatchContext = { ...NEUTRAL, isRerollComp: true };
    const points = checkRolling(makeMatch(rounds), meta, context);
    expect(points.find(p => p.ruleId === 'ROLL_001')).toBeUndefined();
  });

  it('is suppressed for a slow_roll econ style even without a curated reroll comp match', () => {
    const meta = makeMeta({ TFT17_Carry: { name: 'Carry', tier: 4, role: 'carry', traits: [] } });
    const rounds = [makeRound({ label: '3-3', level: 6, rollsSpent: 10, board: boardWith('TFT17_Carry', 1) })];
    const context: MatchContext = {
      ...NEUTRAL,
      plan: {
        headline: 'test', finalTraits: [], econStyle: 'slow_roll', econPhases: [], levelMilestones: [],
        pivots: [],
      },
    };
    const points = checkRolling(makeMatch(rounds), meta, context);
    expect(points.find(p => p.ruleId === 'ROLL_001')).toBeUndefined();
  });

  it('does not fire below the 15g spend threshold', () => {
    const meta = makeMeta({ TFT17_Carry: { name: 'Carry', tier: 4, role: 'carry', traits: [] } });
    const rounds = [makeRound({ label: '3-3', level: 6, rollsSpent: 5, board: boardWith('TFT17_Carry', 1) })];
    const points = checkRolling(makeMatch(rounds), meta, NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_001')).toBeUndefined();
  });

  it('appends a pivot-context clause when the note fires shortly after a detected comp pivot', () => {
    const meta = makeMeta({ TFT17_Carry: { name: 'Carry', tier: 4, role: 'carry', traits: [] } });
    const rounds = [makeRound({ label: '3-3', level: 6, rollsSpent: 10, board: boardWith('TFT17_Carry', 1) })];
    const context: MatchContext = {
      ...NEUTRAL,
      plan: {
        headline: 'test', finalTraits: [], econStyle: 'standard', econPhases: [], levelMilestones: [],
        pivots: [{ round: '3-2', from: ['Anima'], to: ['Bastion'] }],
      },
    };
    const points = checkRolling(makeMatch(rounds), meta, context);
    const hit = points.find(p => p.ruleId === 'ROLL_001');
    expect(hit?.coaching_text).toContain('pivoted from Anima to Bastion at 3-2');
  });
});

describe('ROLL_002 — under-rolling at the stabilisation window', () => {
  it('fires when HP is under 40 at 4-1, roll spend is light, and no 2-star itemized carry exists', () => {
    const rounds = [
      makeRound({ label: '4-1', health: 30, rollsSpent: 2, goldEnd: 40, board: boardWith('TFT17_X', 1) }),
      makeRound({ label: '4-2', rollsSpent: 2, board: boardWith('TFT17_X', 1) }),
    ];
    const points = checkRolling(makeMatch(rounds), makeMeta(), NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_002')).toBeTruthy();
  });

  it('does not fire when a 2-star itemized carry is already on board', () => {
    const rounds = [
      makeRound({ label: '4-1', health: 30, rollsSpent: 2, goldEnd: 40, board: boardWith('TFT17_X', 2, ['TFT_Item_BFSword']) }),
      makeRound({ label: '4-2', rollsSpent: 2, board: boardWith('TFT17_X', 2, ['TFT_Item_BFSword']) }),
    ];
    const points = checkRolling(makeMatch(rounds), makeMeta(), NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_002')).toBeUndefined();
  });

  it('does not fire when HP is at or above 40 entering stage 4', () => {
    const rounds = [makeRound({ label: '4-1', health: 40, rollsSpent: 2, board: boardWith('TFT17_X', 1) })];
    const points = checkRolling(makeMatch(rounds), makeMeta(), NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_002')).toBeUndefined();
  });
});

describe('ROLL_003 — post-stabilisation over-roll', () => {
  it('fires when 20g+ is spent rolling 2+ rounds after stabilisation with no new 3-star', () => {
    const board = stabilisedBoard();
    const rounds = [
      makeRound({ label: '3-1', board }),
      makeRound({ label: '3-2', board }),
      makeRound({ label: '3-3', rollsSpent: 15, board }),
    ];
    const points = checkRolling(makeMatch(rounds), makeMeta(), NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_003')).toBeTruthy();
  });

  it('is suppressed for a detected reroll comp', () => {
    const board = stabilisedBoard();
    const rounds = [
      makeRound({ label: '3-1', board }),
      makeRound({ label: '3-2', board }),
      makeRound({ label: '3-3', rollsSpent: 15, board }),
    ];
    const context: MatchContext = { ...NEUTRAL, isRerollComp: true };
    const points = checkRolling(makeMatch(rounds), makeMeta(), context);
    expect(points.find(p => p.ruleId === 'ROLL_003')).toBeUndefined();
  });

  it('does not fire when the board never stabilises (no 2-star itemized units)', () => {
    const board = boardWith('TFT17_X', 1);
    const rounds = [
      makeRound({ label: '3-1', board }),
      makeRound({ label: '3-2', board }),
      makeRound({ label: '3-3', rollsSpent: 15, board }),
    ];
    const points = checkRolling(makeMatch(rounds), makeMeta(), NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_003')).toBeUndefined();
  });
});

describe('ROLL_004 — Fast-8 roll discipline broken on a loss streak', () => {
  it('fires when rolling 8g+ at level 6 during a real 3+ loss streak outside HP crisis', () => {
    const rounds = [makeRound({ label: '3-5', level: 6, streakType: 'loss', streakCount: 3, rollsSpent: 5 })];
    const points = checkRolling(makeMatch(rounds), makeMeta(), NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_004')).toBeTruthy();
  });

  it('does not fire during an HP-crisis round', () => {
    const rounds = [makeRound({ label: '3-5', level: 6, streakType: 'loss', streakCount: 3, rollsSpent: 5 })];
    const context: MatchContext = { ...NEUTRAL, hpCrisisRounds: new Set(['3-5']) };
    const points = checkRolling(makeMatch(rounds), makeMeta(), context);
    expect(points.find(p => p.ruleId === 'ROLL_004')).toBeUndefined();
  });

  it('does not fire below the 3-streak threshold', () => {
    const rounds = [makeRound({ label: '3-5', level: 6, streakType: 'loss', streakCount: 2, rollsSpent: 5 })];
    const points = checkRolling(makeMatch(rounds), makeMeta(), NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_004')).toBeUndefined();
  });
});

describe('ROLL_005 — slow-roll gold floor violation', () => {
  it('fires after 3 consecutive stage-3+ rounds below the 50g interest cap for a reroll comp', () => {
    const context: MatchContext = { ...NEUTRAL, isRerollComp: true };
    const rounds = [
      makeRound({ label: '3-1', goldEnd: 30 }),
      makeRound({ label: '3-2', goldEnd: 20 }),
      makeRound({ label: '3-3', goldEnd: 40 }),
    ];
    const points = checkRolling(makeMatch(rounds), makeMeta(), context);
    expect(points.find(p => p.ruleId === 'ROLL_005')).toBeTruthy();
  });

  it('does not fire for a non-reroll comp', () => {
    const rounds = [
      makeRound({ label: '3-1', goldEnd: 30 }),
      makeRound({ label: '3-2', goldEnd: 20 }),
      makeRound({ label: '3-3', goldEnd: 40 }),
    ];
    const points = checkRolling(makeMatch(rounds), makeMeta(), NEUTRAL);
    expect(points.find(p => p.ruleId === 'ROLL_005')).toBeUndefined();
  });

  it('resets the streak once gold is rebuilt above the cap', () => {
    const context: MatchContext = { ...NEUTRAL, isRerollComp: true };
    const rounds = [
      makeRound({ label: '3-1', goldEnd: 30 }),
      makeRound({ label: '3-2', goldEnd: 60 }),
      makeRound({ label: '3-3', goldEnd: 40 }),
    ];
    const points = checkRolling(makeMatch(rounds), makeMeta(), context);
    expect(points.find(p => p.ruleId === 'ROLL_005')).toBeUndefined();
  });
});
