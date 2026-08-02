// Unit coverage for src/coach/plan-builder.ts — the whole-match synthesis
// layer that replaces isolated per-round notes with an overview of what the
// player was building (comp trajectory, econ arc, leveling curve). Uses
// hand-built synthetic matches (same pattern as tests/items.test.ts) rather
// than real golden files, since goldens are gitignored and this needs
// specific, controlled trait/econ/level shapes to exercise each branch.

import { describe, it, expect } from 'vitest';
import { buildMatchPlan, mostRecentPivot, pivotContextClause } from '../src/coach/plan-builder';
import type { MatchSnapshot, RoundSnapshot, MetaData, ChampionMeta, BoardState, CompArchetype, MatchPlan } from '../src/shared/types';

function makeRound(overrides: Partial<RoundSnapshot>): RoundSnapshot {
  return {
    label: '2-1',
    type: 'PVP',
    goldStart: 0,
    goldEnd: 0,
    health: 100,
    level: 1,
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

function makeMeta(overrides: Partial<MetaData> = {}): MetaData {
  return {
    carryBis: {},
    traitBreakpoints: [],
    econBenchmarks: [],
    champions: {},
    items: {},
    itemData: {},
    augments: {},
    augmentNames: {},
    augmentModifiers: { itemBisOverrides: {}, traitCountBonuses: {}, frontlineExemptions: {} },
    comps: [],
    ...overrides,
  };
}

function boardOf(...names: string[]): BoardState {
  const board: BoardState = {};
  names.forEach((name, i) => {
    board[`board${i}`] = { name, level: 1, item_1: '0', item_2: '0', item_3: '0' };
  });
  return board;
}

const CHAMPIONS: Record<string, ChampionMeta> = {
  TFT17_Alpha: { name: 'Alpha', tier: 1, role: 'carry', traits: ['TraitA', 'TraitShared'] },
  TFT17_Beta:  { name: 'Beta',  tier: 1, role: 'carry', traits: ['TraitA', 'TraitShared'] },
  TFT17_Gamma: { name: 'Gamma', tier: 1, role: 'tank',  traits: ['TraitB'] },
  TFT17_Delta: { name: 'Delta', tier: 1, role: 'tank',  traits: ['TraitB'] },
  TFT17_Epsilon: { name: 'Epsilon', tier: 1, role: 'flex', traits: ['TraitC'] },
  TFT17_Zeta:  { name: 'Zeta',  tier: 1, role: 'flex', traits: ['TraitC'] },
};

const TRAIT_BREAKPOINTS = [
  { trait: 'TraitA', tiers: [2] },
  { trait: 'TraitB', tiers: [2] },
  { trait: 'TraitC', tiers: [2] },
  { trait: 'TraitShared', tiers: [2] },
];

describe('buildMatchPlan — comp trajectory', () => {
  it('identifies the final active trait set from the last stage-3+ board', () => {
    const meta = makeMeta({ champions: CHAMPIONS, traitBreakpoints: TRAIT_BREAKPOINTS });
    const rounds = [
      makeRound({ label: '3-1', board: boardOf('TFT17_Alpha', 'TFT17_Beta') }),
      makeRound({ label: '3-2', board: boardOf('TFT17_Alpha', 'TFT17_Beta') }),
    ];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.finalTraits.sort()).toEqual(['TraitA', 'TraitShared']);
  });

  it('records a pivot when the active trait set changes by 2+ traits at stage 3+', () => {
    const meta = makeMeta({ champions: CHAMPIONS, traitBreakpoints: TRAIT_BREAKPOINTS });
    const rounds = [
      makeRound({ label: '3-1', board: boardOf('TFT17_Alpha', 'TFT17_Beta') }), // TraitA, TraitShared
      makeRound({ label: '3-2', board: boardOf('TFT17_Alpha', 'TFT17_Beta') }), // same — no pivot
      makeRound({ label: '4-1', board: boardOf('TFT17_Gamma', 'TFT17_Delta') }), // TraitB only — diff of 3
    ];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.pivots).toHaveLength(1);
    expect(plan.pivots[0].round).toBe('4-1');
    expect(plan.pivots[0].from.sort()).toEqual(['TraitA', 'TraitShared']);
    expect(plan.pivots[0].to).toEqual(['TraitB']);
  });

  it('does not record a pivot for a single-trait fluctuation', () => {
    const meta = makeMeta({ champions: CHAMPIONS, traitBreakpoints: TRAIT_BREAKPOINTS });
    const rounds = [
      // TraitA + TraitShared, then TraitA + TraitShared + TraitB (adds one trait, diff=1)
      makeRound({ label: '3-1', board: boardOf('TFT17_Alpha', 'TFT17_Beta') }),
      makeRound({ label: '3-2', board: boardOf('TFT17_Alpha', 'TFT17_Beta', 'TFT17_Gamma', 'TFT17_Delta') }),
    ];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.pivots).toHaveLength(0);
  });

  it('returns an empty trait set when the board never meets any breakpoint', () => {
    const meta = makeMeta({ champions: CHAMPIONS, traitBreakpoints: TRAIT_BREAKPOINTS });
    const rounds = [makeRound({ label: '3-1', board: boardOf('TFT17_Epsilon') })]; // 1 unit, needs 2 for TraitC
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.finalTraits).toEqual([]);
  });
});

describe('buildMatchPlan — econ arc', () => {
  it('classifies banking vs spending rounds and collapses consecutive rounds into phases', () => {
    const meta = makeMeta();
    const rounds = [
      makeRound({ label: '2-1', goldStart: 0,  goldEnd: 10, rollsSpent: 0, xpBought: false }), // banking
      makeRound({ label: '2-2', goldStart: 10, goldEnd: 21, rollsSpent: 0, xpBought: false }), // banking
      makeRound({ label: '2-3', goldStart: 21, goldEnd: 15, rollsSpent: 3, xpBought: false }), // spending
      makeRound({ label: '2-4', goldStart: 15, goldEnd: 26, rollsSpent: 0, xpBought: false }), // banking
    ];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.econPhases).toEqual([
      { startRound: '2-1', endRound: '2-2', mode: 'banking' },
      { startRound: '2-3', endRound: '2-3', mode: 'spending' },
      { startRound: '2-4', endRound: '2-4', mode: 'banking' },
    ]);
  });

  it('classifies a round with no rolls/XP but falling gold as spending (unit purchase)', () => {
    const meta = makeMeta();
    const rounds = [makeRound({ label: '2-1', goldStart: 20, goldEnd: 12, rollsSpent: 0, xpBought: false })];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.econPhases).toEqual([{ startRound: '2-1', endRound: '2-1', mode: 'spending' }]);
  });

  it('labels econStyle reroll when the match context detects a known reroll comp', () => {
    const comps: CompArchetype[] = [{
      id: 'test_reroll', name: 'Test Reroll', type: 'reroll', optimal_level: 6,
      primary_carry_ids: ['TFT17_Alpha'], key_traits: ['TraitA'], notes: '',
    }];
    const meta = makeMeta({ champions: CHAMPIONS, comps });
    const rounds = [
      makeRound({ label: '3-1', board: boardOf('TFT17_Alpha') }),
    ];
    // 2-star Alpha by stage 3 — matches detectRerollComp's requirement.
    rounds[0].board['board0'].level = 2;
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.econStyle).toBe('reroll');
  });

  it('labels econStyle fast_tempo when level 8 is hit by 4-2', () => {
    const meta = makeMeta();
    const rounds = [makeRound({ label: '4-2', level: 8 })];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.econStyle).toBe('fast_tempo');
  });

  it('labels econStyle slow_roll when rolling persists across 4+ rounds with no level change', () => {
    const meta = makeMeta();
    const rounds = [
      makeRound({ label: '3-1', level: 6, rollsSpent: 0 }),
      makeRound({ label: '3-2', level: 6, rollsSpent: 2 }),
      makeRound({ label: '3-3', level: 6, rollsSpent: 3 }),
      makeRound({ label: '3-4', level: 6, rollsSpent: 2 }),
      makeRound({ label: '3-5', level: 6, rollsSpent: 4 }),
    ];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.econStyle).toBe('slow_roll');
  });

  it('defaults econStyle to standard otherwise', () => {
    const meta = makeMeta();
    const rounds = [makeRound({ label: '2-1', level: 3 })];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.econStyle).toBe('standard');
  });
});

describe('buildMatchPlan — leveling curve', () => {
  it('records the first round each level was reached, including skipped levels', () => {
    const meta = makeMeta();
    const rounds = [
      makeRound({ label: '2-1', level: 1 }),
      makeRound({ label: '2-5', level: 3 }), // jumped 1 -> 3 in one snapshot
      makeRound({ label: '4-1', level: 5 }),
    ];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.levelMilestones).toEqual([
      { level: 1, round: '2-1' },
      { level: 2, round: '2-5' },
      { level: 3, round: '2-5' },
      { level: 4, round: '4-1' },
      { level: 5, round: '4-1' },
    ]);
  });

  it('marks level8Timing ahead when 8 is reached before 4-2', () => {
    const meta = makeMeta();
    const rounds = [
      makeRound({ label: '4-1', level: 8 }),
      makeRound({ label: '4-2', level: 8 }),
    ];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.level8Timing).toBe('ahead');
  });

  it('marks level8Timing on_curve when 8 is reached exactly at 4-2', () => {
    const meta = makeMeta();
    const rounds = [
      makeRound({ label: '4-1', level: 7 }),
      makeRound({ label: '4-2', level: 8 }),
    ];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.level8Timing).toBe('on_curve');
  });

  it('marks level8Timing behind when 8 is never reached by match end', () => {
    const meta = makeMeta();
    const rounds = [
      makeRound({ label: '4-1', level: 7 }),
      makeRound({ label: '4-2', level: 7 }),
    ];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.level8Timing).toBe('behind');
  });

  it('leaves level8Timing undefined when the match ended before the benchmark round existed', () => {
    const meta = makeMeta();
    const rounds = [makeRound({ label: '2-1', level: 3 })];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.level8Timing).toBeUndefined();
  });
});

describe('buildMatchPlan — headline', () => {
  it('produces a non-empty headline referencing comp, econ, and level', () => {
    const meta = makeMeta({ champions: CHAMPIONS, traitBreakpoints: TRAIT_BREAKPOINTS });
    const rounds = [
      makeRound({ label: '3-1', board: boardOf('TFT17_Alpha', 'TFT17_Beta'), level: 6, goldStart: 0, goldEnd: 10 }),
      makeRound({ label: '4-2', board: boardOf('TFT17_Alpha', 'TFT17_Beta'), level: 8, goldStart: 10, goldEnd: 5, rollsSpent: 2 }),
    ];
    const plan = buildMatchPlan(makeMatch(rounds), meta);
    expect(plan.headline.length).toBeGreaterThan(0);
    expect(plan.headline).toContain('TraitA');
    expect(plan.headline).toContain('level 8');
  });
});

// Real user feedback (2026-07-28): the Game Plan overview didn't help other
// advice be more useful, it just described itself. mostRecentPivot/
// pivotContextClause are the mechanism checkers use (via context.plan) to
// connect a per-round note back to a recent comp pivot instead of judging
// the round in total isolation.
function makePlan(pivots: MatchPlan['pivots']): MatchPlan {
  return {
    headline: 'test',
    finalTraits: [],
    pivots,
    econStyle: 'standard',
    econPhases: [],
    levelMilestones: [],
  };
}

describe('mostRecentPivot', () => {
  it('finds a pivot from the same stage', () => {
    const plan = makePlan([{ round: '4-1', from: ['Anima'], to: ['Bastion', 'Sniper'] }]);
    expect(mostRecentPivot(plan, '4-3')?.round).toBe('4-1');
  });

  it('finds a pivot from the immediately preceding stage', () => {
    const plan = makePlan([{ round: '3-6', from: ['Anima'], to: ['Bastion', 'Sniper'] }]);
    expect(mostRecentPivot(plan, '4-1')?.round).toBe('3-6');
  });

  it('ignores a pivot more than 1 stage in the past', () => {
    const plan = makePlan([{ round: '2-1', from: ['Anima'], to: ['Bastion', 'Sniper'] }]);
    expect(mostRecentPivot(plan, '4-1')).toBeUndefined();
  });

  it('ignores a pivot that has not happened yet', () => {
    const plan = makePlan([{ round: '5-1', from: ['Anima'], to: ['Bastion', 'Sniper'] }]);
    expect(mostRecentPivot(plan, '4-1')).toBeUndefined();
  });

  it('picks the latest of multiple qualifying pivots', () => {
    const plan = makePlan([
      { round: '4-1', from: ['A'], to: ['B'] },
      { round: '4-3', from: ['B'], to: ['C'] },
    ]);
    expect(mostRecentPivot(plan, '4-5')?.round).toBe('4-3');
  });
});

describe('pivotContextClause', () => {
  it('returns a non-empty clause naming the pivot when one is recent', () => {
    const plan = makePlan([{ round: '4-1', from: ['Anima'], to: ['Bastion', 'Sniper'] }]);
    const clause = pivotContextClause(plan, '4-2');
    expect(clause.length).toBeGreaterThan(0);
    expect(clause).toContain('Anima');
    expect(clause).toContain('Bastion/Sniper');
    expect(clause).toContain('4-1');
  });

  it('returns an empty string when there is no recent pivot', () => {
    expect(pivotContextClause(makePlan([]), '4-2')).toBe('');
  });

  it('returns an empty string when plan is undefined', () => {
    expect(pivotContextClause(undefined, '4-2')).toBe('');
  });
});
