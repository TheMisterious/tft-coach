// Unit coverage for src/coach/checkers/streak.ts — previously had zero
// dedicated tests (only generic golden-match smoke tests).

import { describe, it, expect } from 'vitest';
import { checkStreak } from '../src/coach/checkers/streak';
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

describe('STREAK_001 — win streak of 3+ broken', () => {
  it('fires moderate when a 3-4 win streak breaks', () => {
    const rounds = [
      makeRound({ label: '3-1', streakType: 'win', streakCount: 3 }),
      makeRound({ label: '3-2', outcome: 'loss' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    const hit = points.find(p => p.ruleId === 'STREAK_001');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('moderate');
  });

  it('fires critical when a 5+ win streak breaks', () => {
    const rounds = [
      makeRound({ label: '3-1', streakType: 'win', streakCount: 5 }),
      makeRound({ label: '3-2', outcome: 'loss' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_001')?.severity).toBe('critical');
  });

  it('does not fire below the 3-streak threshold', () => {
    const rounds = [
      makeRound({ label: '3-1', streakType: 'win', streakCount: 2 }),
      makeRound({ label: '3-2', outcome: 'loss' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_001')).toBeUndefined();
  });

  it('does not fire when the streak continues (still a win)', () => {
    const rounds = [
      makeRound({ label: '3-1', streakType: 'win', streakCount: 3 }),
      makeRound({ label: '3-2', outcome: 'win' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_001')).toBeUndefined();
  });

  it('does not fire on a PVE round following the streak', () => {
    const rounds = [
      makeRound({ label: '3-1', streakType: 'win', streakCount: 3 }),
      makeRound({ label: '3-2', type: 'PVE', outcome: 'loss' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_001')).toBeUndefined();
  });
});

describe('STREAK_002 — loss streak spend that still lost', () => {
  it('fires when 8g+ is spent trying to break a 2-4 loss streak but the next round still loses', () => {
    const rounds = [
      makeRound({ label: '3-1', streakType: 'loss', streakCount: 3, rollsSpent: 5, health: 60 }),
      makeRound({ label: '3-2', outcome: 'loss' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_002')).toBeTruthy();
  });

  it('does not fire when the next round wins', () => {
    const rounds = [
      makeRound({ label: '3-1', streakType: 'loss', streakCount: 3, rollsSpent: 5, health: 60 }),
      makeRound({ label: '3-2', outcome: 'win' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_002')).toBeUndefined();
  });

  it('does not fire when HP was critical (forced stabilisation attempt)', () => {
    const rounds = [
      makeRound({ label: '3-1', streakType: 'loss', streakCount: 3, rollsSpent: 5, health: 15 }),
      makeRound({ label: '3-2', outcome: 'loss' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_002')).toBeUndefined();
  });

  it('does not fire below the spend threshold', () => {
    const rounds = [
      makeRound({ label: '3-1', streakType: 'loss', streakCount: 3, rollsSpent: 1, health: 60 }),
      makeRound({ label: '3-2', outcome: 'loss' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_002')).toBeUndefined();
  });

  it('does not fire at stage 5+ even with HP above the crisis threshold — late game, spending to try to win is correct regardless of streak-econ math', () => {
    const rounds = [
      makeRound({ label: '5-1', streakType: 'loss', streakCount: 3, rollsSpent: 11, health: 60 }),
      makeRound({ label: '5-2', outcome: 'loss' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_002')).toBeUndefined();
  });

  it('still fires at stage 4', () => {
    const rounds = [
      makeRound({ label: '4-1', streakType: 'loss', streakCount: 3, rollsSpent: 11, health: 60 }),
      makeRound({ label: '4-2', outcome: 'loss' }),
    ];
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_002')).toBeTruthy();
  });
});

describe('STREAK_003 — never reached a 5+ streak', () => {
  it('fires when the longest streak across 5+ PvP rounds never reaches 5', () => {
    const rounds = ['2-1', '2-2', '2-3', '2-4', '2-5', '3-1'].map((label, i) =>
      makeRound({ label, streakType: i % 2 === 0 ? 'win' : 'loss', streakCount: 2 })
    );
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_003')).toBeTruthy();
  });

  it('does not fire once a 5+ streak was reached', () => {
    const rounds = ['2-1', '2-2', '2-3', '2-4', '2-5', '3-1'].map((label, i) =>
      makeRound({ label, streakType: 'win', streakCount: i === 4 ? 5 : i + 1 })
    );
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_003')).toBeUndefined();
  });

  it('does not fire with fewer than 5 PvP rounds played', () => {
    const rounds = ['2-1', '2-2'].map(label => makeRound({ label, streakType: 'win', streakCount: 2 }));
    const points = checkStreak(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'STREAK_003')).toBeUndefined();
  });
});
