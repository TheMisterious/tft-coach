// Unit coverage for src/coach/match-context.ts's computeActiveComp —
// previously only exercised indirectly through golden-match smoke tests.

import { describe, it, expect } from 'vitest';
import { computeActiveComp } from '../src/coach/match-context';
import type { MatchSnapshot, RoundSnapshot, BoardState } from '../src/shared/types';

function board(names: string[]): BoardState {
  const b: BoardState = {};
  names.forEach((name, i) => {
    b[`cell_${i}`] = { name, level: 1, item_1: '0', item_2: '0', item_3: '0' };
  });
  return b;
}

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

describe('computeActiveComp', () => {
  it('includes a unit present every round since round one', () => {
    const rounds = ['2-1', '2-2', '2-3', '2-4'].map(label => makeRound({ label, board: board(['TFT17_A']) }));
    expect(computeActiveComp(makeMatch(rounds)).has('TFT17_A')).toBe(true);
  });

  it('excludes a unit present in under half of the whole match, with no window justification', () => {
    const rounds = [
      makeRound({ label: '2-1', board: board(['TFT17_A']) }),
      makeRound({ label: '2-2', board: board([]) }),
      makeRound({ label: '2-3', board: board([]) }),
      makeRound({ label: '2-4', board: board([]) }),
    ];
    expect(computeActiveComp(makeMatch(rounds)).has('TFT17_A')).toBe(false);
  });

  it('regression: a unit introduced by a mid-match pivot counts as committed once she clears 50% of her OWN window, even if she is under 50% of the whole match', () => {
    // Real bug: a champion who joined at the game's midpoint and was on
    // board every round since was still being excluded from "committed"
    // because her total presence (half the match) fell just under 50% of
    // the *whole* match's PvP round count — a bar nobody who joins mid-match
    // can ever clear. Mirrors the real match: Nami present in 10 of 21 total
    // PvP rounds (47.6%, would fail the old whole-match bar) but 10 of 10
    // rounds since she first appeared (100% of her own window).
    const early = ['2-1', '2-2', '2-3', '2-4', '2-5'].map(label => makeRound({ label, board: board(['TFT17_Old']) }));
    const late = ['3-1', '3-2', '3-3', '3-4', '3-5'].map(label => makeRound({ label, board: board(['TFT17_Old', 'TFT17_New']) }));
    const rounds = [...early, ...late];

    const activeComp = computeActiveComp(makeMatch(rounds));
    expect(activeComp.has('TFT17_New')).toBe(true);
    // The long-standing unit (present all 10 rounds) is of course still committed.
    expect(activeComp.has('TFT17_Old')).toBe(true);
  });

  it('a unit that joins late and is still frequently absent afterward is correctly excluded', () => {
    const early = ['2-1', '2-2', '2-3', '2-4'].map(label => makeRound({ label, board: board(['TFT17_Old']) }));
    // TFT17_Sporadic only shows up in 1 of the last 4 rounds — under 50% of her own window too.
    const late = [
      makeRound({ label: '3-1', board: board(['TFT17_Old', 'TFT17_Sporadic']) }),
      makeRound({ label: '3-2', board: board(['TFT17_Old']) }),
      makeRound({ label: '3-3', board: board(['TFT17_Old']) }),
      makeRound({ label: '3-4', board: board(['TFT17_Old']) }),
    ];
    const activeComp = computeActiveComp(makeMatch([...early, ...late]));
    expect(activeComp.has('TFT17_Sporadic')).toBe(false);
  });

  it('ignores PVE rounds entirely, for both the denominator and presence counting', () => {
    const rounds = [
      makeRound({ label: '2-1', type: 'PVP', board: board(['TFT17_A']) }),
      makeRound({ label: '2-2', type: 'PVE', board: board(['TFT17_PVE_Minion']) }),
      makeRound({ label: '2-3', type: 'PVP', board: board(['TFT17_A']) }),
    ];
    const activeComp = computeActiveComp(makeMatch(rounds));
    expect(activeComp.has('TFT17_A')).toBe(true);
    expect(activeComp.has('TFT17_PVE_Minion')).toBe(false);
  });

  it('returns an empty set when there are no PvP rounds', () => {
    const rounds = [makeRound({ label: '1-2', type: 'PVE', board: board(['TFT17_A']) })];
    expect(computeActiveComp(makeMatch(rounds)).size).toBe(0);
  });
});
