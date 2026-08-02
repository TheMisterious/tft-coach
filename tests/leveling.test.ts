// Unit coverage for src/coach/checkers/leveling.ts — previously had zero
// dedicated tests (only generic golden-match smoke tests).

import { describe, it, expect } from 'vitest';
import { checkLeveling } from '../src/coach/checkers/leveling';
import type { MatchSnapshot, RoundSnapshot } from '../src/shared/types';

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

describe('LEVEL_001 — late level 6', () => {
  it('fires critical at level 4 or below at 3-2', () => {
    const rounds = [makeRound({ label: '3-2', level: 4, goldEnd: 10 })];
    const points = checkLeveling(makeMatch(rounds));
    const hit = points.find(p => p.ruleId === 'LEVEL_001');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('critical');
  });

  it('fires moderate at level 5 at 3-2', () => {
    const rounds = [makeRound({ label: '3-2', level: 5, goldEnd: 10 })];
    const points = checkLeveling(makeMatch(rounds));
    const hit = points.find(p => p.ruleId === 'LEVEL_001');
    expect(hit!.severity).toBe('moderate');
  });

  it('does not fire at level 6+ at 3-2', () => {
    const rounds = [makeRound({ label: '3-2', level: 6, goldEnd: 10 })];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_001')).toBeUndefined();
  });
});

describe('LEVEL_002 — late level 7', () => {
  it('fires critical below level 7 at 4-1', () => {
    const rounds = [makeRound({ label: '4-1', level: 6, goldEnd: 10 })];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_002')?.severity).toBe('critical');
  });

  it('does not fire at level 7+ at 4-1', () => {
    const rounds = [makeRound({ label: '4-1', level: 7, goldEnd: 10 })];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_002')).toBeUndefined();
  });
});

describe('LEVEL_003 — fast-8 delay', () => {
  it('fires when 50g+ was available at 4-1, HP stable, and still below level 8 at 4-2', () => {
    const rounds = [
      makeRound({ label: '4-1', goldEnd: 60, health: 60 }),
      makeRound({ label: '4-2', level: 7 }),
    ];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_003')).toBeTruthy();
  });

  it('does not fire when gold at 4-1 was below 50', () => {
    const rounds = [
      makeRound({ label: '4-1', goldEnd: 20, health: 60 }),
      makeRound({ label: '4-2', level: 7 }),
    ];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_003')).toBeUndefined();
  });

  it('does not fire during an HP crisis at 4-1', () => {
    const rounds = [
      makeRound({ label: '4-1', goldEnd: 60, health: 25 }),
      makeRound({ label: '4-2', level: 7 }),
    ];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_003')).toBeUndefined();
  });

  it('does not fire when already level 8 at 4-2', () => {
    const rounds = [
      makeRound({ label: '4-1', goldEnd: 60, health: 60 }),
      makeRound({ label: '4-2', level: 8 }),
    ];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_003')).toBeUndefined();
  });
});

describe('LEVEL_004 — naked level (buying XP without a cushion)', () => {
  it('fires when XP bought with <10g remaining and fewer than 3 two-star units', () => {
    const rounds = [
      makeRound({
        label: '3-3',
        xpBought: true,
        goldEnd: 4,
        board: { b1: { name: 'TFT17_Test', level: 1, item_1: '0', item_2: '0', item_3: '0' } },
      }),
    ];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_004')).toBeTruthy();
  });

  it('does not fire when 10g+ remains after buying XP', () => {
    const rounds = [makeRound({ label: '3-3', xpBought: true, goldEnd: 15 })];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_004')).toBeUndefined();
  });

  it('does not fire when XP was not bought this round', () => {
    const rounds = [makeRound({ label: '3-3', xpBought: false, goldEnd: 2 })];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_004')).toBeUndefined();
  });
});

describe('LEVEL_005 — late level 9', () => {
  it('fires when resources/HP were available at 5-1 but still below level 9 at 5-2', () => {
    const rounds = [
      makeRound({ label: '5-1', goldEnd: 50, health: 50 }),
      makeRound({ label: '5-2', level: 8 }),
    ];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_005')).toBeTruthy();
  });

  it('does not fire when HP was below the survival threshold at 5-1', () => {
    const rounds = [
      makeRound({ label: '5-1', goldEnd: 50, health: 20 }),
      makeRound({ label: '5-2', level: 8 }),
    ];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_005')).toBeUndefined();
  });
});

describe('LEVEL_006 — streak-adjusted level targets', () => {
  it('fires when on a 3+ win streak but below level 6 at 3-1', () => {
    const rounds = [makeRound({ label: '3-1', level: 5, streakType: 'win', streakCount: 3 })];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_006' && p.round === '3-1')).toBeTruthy();
  });

  it('does not fire on a win streak below the 3-streak threshold', () => {
    const rounds = [makeRound({ label: '3-1', level: 5, streakType: 'win', streakCount: 2 })];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_006' && p.round === '3-1')).toBeUndefined();
  });

  it('fires when on a 3+ loss streak but exactly level 7 at 4-1', () => {
    const rounds = [makeRound({ label: '4-1', level: 7, streakType: 'loss', streakCount: 3 })];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_006' && p.round === '4-1')).toBeTruthy();
  });

  it('does not fire the loss-streak variant below level 7 (LEVEL_002 already covers it)', () => {
    const rounds = [makeRound({ label: '4-1', level: 6, streakType: 'loss', streakCount: 3 })];
    const points = checkLeveling(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'LEVEL_006' && p.round === '4-1')).toBeUndefined();
  });
});
