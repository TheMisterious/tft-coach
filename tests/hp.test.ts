// Unit coverage for src/coach/checkers/hp.ts — previously had zero dedicated
// tests (only generic golden-match smoke tests).

import { describe, it, expect } from 'vitest';
import { checkHp } from '../src/coach/checkers/hp';
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

describe('HP_001 — stage 2 excessive HP bleed', () => {
  it('fires moderate when 16-25 HP lost between 2-1 and 3-1', () => {
    const rounds = [
      makeRound({ label: '2-1', health: 100 }),
      makeRound({ label: '3-1', health: 80 }),
    ];
    const points = checkHp(makeMatch(rounds));
    const hit = points.find(p => p.ruleId === 'HP_001');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('moderate');
  });

  it('fires critical when more than 25 HP lost', () => {
    const rounds = [
      makeRound({ label: '2-1', health: 100 }),
      makeRound({ label: '3-1', health: 70 }),
    ];
    const points = checkHp(makeMatch(rounds));
    const hit = points.find(p => p.ruleId === 'HP_001');
    expect(hit!.severity).toBe('critical');
  });

  it('does not fire at or below the 15 HP benchmark', () => {
    const rounds = [
      makeRound({ label: '2-1', health: 100 }),
      makeRound({ label: '3-1', health: 85 }),
    ];
    const points = checkHp(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'HP_001')).toBeUndefined();
  });

  it('does not fire when either checkpoint round is missing', () => {
    const rounds = [makeRound({ label: '3-1', health: 70 })];
    const points = checkHp(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'HP_001')).toBeUndefined();
  });
});

describe('HP_002 — stage 3 critical threshold', () => {
  it('fires moderate when entering stage 4 between 40 and 59 HP', () => {
    const rounds = [
      makeRound({ label: '3-1', health: 70 }),
      makeRound({ label: '4-1', health: 50 }),
    ];
    const points = checkHp(makeMatch(rounds));
    const hit = points.find(p => p.ruleId === 'HP_002');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('moderate');
  });

  it('fires critical when entering stage 4 below 40 HP', () => {
    const rounds = [
      makeRound({ label: '3-1', health: 70 }),
      makeRound({ label: '4-1', health: 35 }),
    ];
    const points = checkHp(makeMatch(rounds));
    const hit = points.find(p => p.ruleId === 'HP_002');
    expect(hit!.severity).toBe('critical');
  });

  it('does not fire at or above the 60 HP safe zone', () => {
    const rounds = [
      makeRound({ label: '3-1', health: 70 }),
      makeRound({ label: '4-1', health: 60 }),
    ];
    const points = checkHp(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'HP_002')).toBeUndefined();
  });
});

describe('HP_003 — stage 5 lethal zone', () => {
  it('fires critical at or below 25 HP entering stage 5', () => {
    const rounds = [
      makeRound({ label: '4-1', health: 50 }),
      makeRound({ label: '5-1', health: 25 }),
    ];
    const points = checkHp(makeMatch(rounds));
    const hit = points.find(p => p.ruleId === 'HP_003');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('critical');
  });

  it('does not fire above 25 HP entering stage 5', () => {
    const rounds = [
      makeRound({ label: '4-1', health: 50 }),
      makeRound({ label: '5-1', health: 26 }),
    ];
    const points = checkHp(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'HP_003')).toBeUndefined();
  });
});
