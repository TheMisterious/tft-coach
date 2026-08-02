// Unit coverage for src/coach/checkers/comp.ts — previously had zero
// dedicated tests (only generic golden-match smoke tests).

import { describe, it, expect } from 'vitest';
import { checkComp } from '../src/coach/checkers/comp';
import type { MatchSnapshot, RoundSnapshot, BoardState, MetaData, ChampionMeta } from '../src/shared/types';

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

const ACTIVE_COMP_BOARD: BoardState = {
  b1: { name: 'TFT17_Core', level: 2, item_1: '0', item_2: '0', item_3: '0' },
};

function benchOf(names: string[]): BoardState {
  const bench: BoardState = {};
  names.forEach((name, i) => {
    bench[`bn${i}`] = { name, level: 1, item_1: '0', item_2: '0', item_3: '0' };
  });
  return bench;
}

const CLUTTER_NAMES = ['TFT17_A', 'TFT17_B', 'TFT17_C', 'TFT17_D', 'TFT17_E'];

describe('COMP_002 — bench clutter', () => {
  it('fires after 3 consecutive stage-3+ rounds with 5+ off-comp bench units', () => {
    const rounds = ['3-1', '3-2', '3-3', '3-4'].map(label =>
      makeRound({ label, board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) })
    );
    const points = checkComp(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'COMP_002')).toBeTruthy();
  });

  it('does not fire below the 5 off-comp unit threshold', () => {
    const rounds = ['3-1', '3-2', '3-3', '3-4'].map(label =>
      makeRound({ label, board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES.slice(0, 4)) })
    );
    const points = checkComp(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'COMP_002')).toBeUndefined();
  });

  it('does not fire before 3 consecutive clutter rounds', () => {
    const rounds = ['3-1', '3-2'].map(label =>
      makeRound({ label, board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) })
    );
    const points = checkComp(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'COMP_002')).toBeUndefined();
  });

  it('resets the streak once bench clutter drops below the threshold', () => {
    const rounds = [
      makeRound({ label: '3-1', board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) }),
      makeRound({ label: '3-2', board: ACTIVE_COMP_BOARD, bench: benchOf([]) }),
      makeRound({ label: '3-3', board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) }),
      makeRound({ label: '3-4', board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) }),
    ];
    const points = checkComp(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'COMP_002')).toBeUndefined();
  });

  it('does not fire before stage 3', () => {
    const rounds = ['2-1', '2-2', '2-3'].map(label =>
      makeRound({ label, board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) })
    );
    const points = checkComp(makeMatch(rounds));
    expect(points.find(p => p.ruleId === 'COMP_002')).toBeUndefined();
  });

  function makeMeta(champions: Record<string, ChampionMeta>): MetaData {
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

  it('regression: gold-locked estimate uses real per-champion cost data instead of a flat 2g guess', () => {
    // Real gap: the old estimate added a flat 2g per bench unit regardless of
    // actual cost, and `meta` wasn't even passed into the checker so real
    // champion tier data was never available to use instead.
    const meta = makeMeta({
      TFT17_A: { name: 'A', tier: 1, role: 'flex', traits: [] },
      TFT17_B: { name: 'B', tier: 5, role: 'flex', traits: [] },
      TFT17_C: { name: 'C', tier: 4, role: 'flex', traits: [] },
      TFT17_D: { name: 'D', tier: 3, role: 'flex', traits: [] },
      TFT17_E: { name: 'E', tier: 2, role: 'flex', traits: [] },
    });
    const rounds = ['3-1', '3-2', '3-3'].map(label =>
      makeRound({ label, board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) })
    );
    const points = checkComp(makeMatch(rounds), meta);
    const hit = points.find(p => p.ruleId === 'COMP_002');
    expect(hit).toBeTruthy();
    // 1 + 5 + 4 + 3 + 2 = 15g, not the old flat 5 units * 2g = 10g.
    expect(hit!.reasonMetrics.goldLocked).toBe(15);
    expect(hit!.recommended).toContain('15g');
  });

  it('regression: fires again for a second clutter streak later in the same match, not just the first', () => {
    // Real bug: the old checker `return`ed on the very first qualifying
    // streak, so a player who cleared their bench and then let it clutter up
    // again later (e.g. after a comp pivot) never got a second notification —
    // same silent-swallow bug already fixed for ECON_002's idle-overcap streak.
    const rounds = [
      makeRound({ label: '3-1', board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) }),
      makeRound({ label: '3-2', board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) }),
      makeRound({ label: '3-3', board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) }), // 1st fire
      makeRound({ label: '3-4', board: ACTIVE_COMP_BOARD, bench: benchOf([]) }),            // cleared
      makeRound({ label: '4-1', board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) }),
      makeRound({ label: '4-2', board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) }),
      makeRound({ label: '4-3', board: ACTIVE_COMP_BOARD, bench: benchOf(CLUTTER_NAMES) }), // 2nd fire
    ];
    const points = checkComp(makeMatch(rounds));
    const hits = points.filter(p => p.ruleId === 'COMP_002');
    expect(hits).toHaveLength(2);
    expect(hits[0].round).toBe('3-3');
    expect(hits[1].round).toBe('4-3');
  });
});
