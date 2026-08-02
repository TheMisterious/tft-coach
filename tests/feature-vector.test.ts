// Unit coverage for src/profile/feature-vector.ts — asserts exact derivation
// against hand-built synthetic matches (same makeRound/makeMatch/makeMeta
// pattern as tests/plan-builder.test.ts and tests/items.test.ts), not real
// golden files, so each field's computation can be isolated and verified
// against an engineered, known-correct value.

import { describe, it, expect } from 'vitest';
import { extractFeatureVector } from '../src/profile/feature-vector';
import { NEUTRAL_CONTEXT } from '../src/coach/match-context';
import type {
  MatchSnapshot, RoundSnapshot, MetaData, MatchContext, DecisionPoint, ChampionMeta, BoardState, ItemData,
} from '../src/shared/types';

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

function makeContext(overrides: Partial<MatchContext> = {}): MatchContext {
  return { ...NEUTRAL_CONTEXT, ...overrides };
}

describe('extractFeatureVector — econ curve', () => {
  it('computes econBankingPhaseRatio and econPhaseSwitchCount from round mode', () => {
    // banking, banking, spending, banking -> ratio 3/4, 2 switches
    const rounds = [
      makeRound({ label: '2-1', goldStart: 10, goldEnd: 20, rollsSpent: 0, xpBought: false }), // banking
      makeRound({ label: '2-2', goldStart: 20, goldEnd: 30, rollsSpent: 0, xpBought: false }), // banking
      makeRound({ label: '2-3', goldStart: 30, goldEnd: 10, rollsSpent: 5, xpBought: false }), // spending
      makeRound({ label: '2-4', goldStart: 10, goldEnd: 20, rollsSpent: 0, xpBought: false }), // banking
    ];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), makeMeta());
    expect(fv.econBankingPhaseRatio).toBeCloseTo(0.75, 5);
    expect(fv.econPhaseSwitchCount).toBe(2);
  });

  it('counts rounds ending 1-3g short of a 10g interest tier', () => {
    const rounds = [
      makeRound({ label: '2-1', goldEnd: 8 }),  // 2g short of 10 -> missed
      makeRound({ label: '2-2', goldEnd: 19 }), // 1g short of 20 -> missed
      makeRound({ label: '2-3', goldEnd: 25 }), // not near a tier -> not missed
      makeRound({ label: '2-4', goldEnd: 60 }), // above cap -> not missed
    ];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), makeMeta());
    expect(fv.interestMissedRoundCount).toBe(2);
  });

  it('counts idle rounds sitting above the actionable overcap threshold', () => {
    const rounds = [
      makeRound({ label: '2-1', goldEnd: 60, rollsSpent: 0, xpBought: false }), // idle overcap
      makeRound({ label: '2-2', goldEnd: 60, rollsSpent: 1, xpBought: false }), // rolled -> not idle
      makeRound({ label: '2-3', goldEnd: 50, rollsSpent: 0, xpBought: false }), // at cap, not actionable surplus
    ];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), makeMeta());
    expect(fv.overcapRoundCount).toBe(1);
  });

  it('sums roll gold spent before stage 3', () => {
    const rounds = [
      makeRound({ label: '2-1', rollsSpent: 3 }), // 6g, pre-stage-3
      makeRound({ label: '2-5', rollsSpent: 2 }), // 4g, pre-stage-3
      makeRound({ label: '3-1', rollsSpent: 5 }), // stage 3, excluded
    ];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), makeMeta());
    expect(fv.preStage3RollGold).toBe(10);
  });
});

describe('extractFeatureVector — roll timing', () => {
  it('measures rounds between the first HP crisis and the first roll response', () => {
    const rounds = [
      makeRound({ label: '3-1', health: 100 }),
      makeRound({ label: '3-2', health: 30, rollsSpent: 0 }), // crisis starts here (index 1)
      makeRound({ label: '3-3', health: 25, rollsSpent: 0 }),
      makeRound({ label: '3-4', health: 40, rollsSpent: 5 }), // first roll response (index 3)
    ];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), makeMeta());
    expect(fv.rolldownLatencyRounds).toBe(2); // index 3 - index 1
  });

  it('is null when the match never entered an HP crisis', () => {
    const rounds = [makeRound({ label: '3-1', health: 90 })];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), makeMeta());
    expect(fv.rolldownLatencyRounds).toBeNull();
  });

  it('reuses ROLL_003/ROLL_004 decision point metrics when present', () => {
    const points: DecisionPoint[] = [
      { ruleId: 'ROLL_003', round: '4-1', category: 'rolling', severity: 'moderate', observed: '', recommended: '', reasonMetrics: { totalWaste: 42 } },
      { ruleId: 'ROLL_004', round: '3-1', category: 'rolling', severity: 'moderate', observed: '', recommended: '', reasonMetrics: { goldRolled: 10 } },
      { ruleId: 'ROLL_004', round: '3-3', category: 'rolling', severity: 'moderate', observed: '', recommended: '', reasonMetrics: { goldRolled: 6 } },
    ];
    const fv = extractFeatureVector(makeMatch([makeRound({})]), points, makeContext(), makeMeta());
    expect(fv.postStabilizationOverrollGold).toBe(42);
    expect(fv.level6RollDuringLossStreakGold).toBe(16);
  });

  it('defaults roll-timing metrics to 0 when no matching decision points exist', () => {
    const fv = extractFeatureVector(makeMatch([makeRound({})]), [], makeContext(), makeMeta());
    expect(fv.postStabilizationOverrollGold).toBe(0);
    expect(fv.level6RollDuringLossStreakGold).toBe(0);
  });
});

describe('extractFeatureVector — streaks', () => {
  it('computes max win/loss streak and conversion rate across episodes', () => {
    const rounds = [
      makeRound({ label: '2-1', streakType: 'win', streakCount: 1 }),
      makeRound({ label: '2-2', streakType: 'win', streakCount: 2 }), // episode 1 peaks at 2 (reaches 2+, not 3+)
      makeRound({ label: '2-3', streakType: 'loss', streakCount: 1 }), // breaks episode 1
      makeRound({ label: '2-4', streakType: 'loss', streakCount: 2 }),
      makeRound({ label: '2-5', streakType: 'win', streakCount: 1 }),
      makeRound({ label: '2-6', streakType: 'win', streakCount: 2 }),
      makeRound({ label: '2-7', streakType: 'win', streakCount: 3 }), // episode 2 peaks at 3 (reaches 3+)
    ];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), makeMeta());
    expect(fv.maxWinStreak).toBe(3);
    expect(fv.maxLossStreak).toBe(2);
    // 2 win episodes reached 2+, 1 of those reached 3+ -> 0.5
    expect(fv.streakConversionRate).toBeCloseTo(0.5, 5);
  });

  it('counts STREAK_001 firings as streakBreakCount', () => {
    const points: DecisionPoint[] = [
      { ruleId: 'STREAK_001', round: '3-1', category: 'streak', severity: 'moderate', observed: '', recommended: '', reasonMetrics: {} },
      { ruleId: 'STREAK_001', round: '4-1', category: 'streak', severity: 'moderate', observed: '', recommended: '', reasonMetrics: {} },
    ];
    const fv = extractFeatureVector(makeMatch([makeRound({})]), points, makeContext(), makeMeta());
    expect(fv.streakBreakCount).toBe(2);
  });
});

describe('extractFeatureVector — leveling', () => {
  it('computes signed level-8/level-9 deltas against the 4-2/5-2 benchmarks', () => {
    const context = makeContext({
      plan: {
        headline: '', finalTraits: [], pivots: [], econStyle: 'standard', econPhases: [],
        levelMilestones: [{ level: 8, round: '4-1' }, { level: 9, round: '5-4' }],
      },
    });
    const fv = extractFeatureVector(makeMatch([makeRound({})]), [], context, makeMeta());
    expect(fv.level8DeltaRounds).toBe(401 - 402); // ahead of the 4-2 benchmark by 1 round
    expect(fv.level9DeltaRounds).toBe(504 - 502); // behind the 5-2 benchmark by 2 rounds
  });

  it('is null when a level was never reached', () => {
    const context = makeContext({
      plan: { headline: '', finalTraits: [], pivots: [], econStyle: 'standard', econPhases: [], levelMilestones: [] },
    });
    const fv = extractFeatureVector(makeMatch([makeRound({})]), [], context, makeMeta());
    expect(fv.level8DeltaRounds).toBeNull();
    expect(fv.level9DeltaRounds).toBeNull();
  });
});

const COMP_META: Record<string, ItemData> = {
  COMP_A: { name: 'Comp A', isComponent: true, composition: [], tags: [], keyStats: {} },
  COMP_B: { name: 'Comp B', isComponent: true, composition: [], tags: [], keyStats: {} },
  ITEM_X: { name: 'Item X', isComponent: false, composition: ['COMP_A', 'COMP_B'], tags: ['offense'], keyStats: { AD: 10 } },
};

describe('extractFeatureVector — itemization', () => {
  it('computes componentHoldRoundRatio over stage>=2 rounds', () => {
    const rounds = [
      makeRound({ label: '2-1', benchItems: ['COMP_A', 'COMP_B'] }), // holding
      makeRound({ label: '2-2', benchItems: ['COMP_A', 'COMP_B'] }), // holding
      makeRound({ label: '2-3', benchItems: [] }),                    // not holding
    ];
    const meta = makeMeta({ itemData: COMP_META });
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), meta);
    expect(fv.componentHoldRoundRatio).toBeCloseTo(2 / 3, 5);
  });

  it('counts ITEM_005 firings as componentConversionsMissedCount', () => {
    const points: DecisionPoint[] = [
      { ruleId: 'ITEM_005', round: '3-1', category: 'items', severity: 'moderate', observed: '', recommended: '', reasonMetrics: {} },
      { ruleId: 'ITEM_001', round: '3-2', category: 'items', severity: 'moderate', observed: '', recommended: '', reasonMetrics: {} },
    ];
    const fv = extractFeatureVector(makeMatch([makeRound({})]), points, makeContext(), makeMeta());
    expect(fv.componentConversionsMissedCount).toBe(1);
  });

  it('counts completed (non-component) items on the identified carry at 4-1', () => {
    const board: BoardState = {
      c0: { name: 'TFT17_Carry', level: 2, item_1: 'ITEM_X', item_2: 'ITEM_X', item_3: '0' },
    };
    const champions: Record<string, ChampionMeta> = {
      TFT17_Carry: { name: 'Carry', tier: 3, role: 'carry', traits: [] },
    };
    const meta = makeMeta({ itemData: COMP_META, champions });
    const rounds = [makeRound({ label: '4-1', board })];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), meta);
    expect(fv.carryItemCountAt41).toBe(2);
  });

  it('returns 0 when round 4-1 does not exist', () => {
    const fv = extractFeatureVector(makeMatch([makeRound({ label: '3-1' })]), [], makeContext(), makeMeta());
    expect(fv.carryItemCountAt41).toBe(0);
  });
});

describe('extractFeatureVector — positioning', () => {
  it('averages consecutive-fight run lengths of a static opponent carry hex', () => {
    const foo = { name: 'TFT17_Foo', level: 1, item_1: '0', item_2: '0', item_3: '0' };
    const rounds = [
      makeRound({ label: '2-1', opponentBoard: { slotA: foo } }),
      makeRound({ label: '2-2', opponentBoard: { slotA: foo } }), // run of 2 (same key)
      makeRound({ label: '2-3', opponentBoard: { slotB: foo } }),
      makeRound({ label: '2-4', opponentBoard: { slotB: foo } }), // run of 2 (same key)
    ];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), makeMeta());
    expect(fv.positioningNoAdjustStreakAvg).toBeCloseTo(2, 5);
  });

  it('computes noFrontlineRoundRatio using real hex row orientation (cell_1-7 = back, cell_22-28 = front)', () => {
    const rounds = [
      makeRound({ label: '4-1', board: { cell_1: { name: 'TFT17_A', level: 1, item_1: '0', item_2: '0', item_3: '0' } } }), // back only -> no frontline
      makeRound({ label: '4-2', board: { cell_22: { name: 'TFT17_A', level: 1, item_1: '0', item_2: '0', item_3: '0' } } }), // front -> has frontline
    ];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), makeMeta());
    expect(fv.noFrontlineRoundRatio).toBeCloseTo(0.5, 5);
  });
});

describe('extractFeatureVector — HP trajectory', () => {
  it('reads HP at stage 3/4/5 entry rounds, null when absent', () => {
    const rounds = [
      makeRound({ label: '3-1', health: 80 }),
      makeRound({ label: '4-1', health: 50 }),
    ];
    const fv = extractFeatureVector(makeMatch(rounds), [], makeContext(), makeMeta());
    expect(fv.hpAtStage3Entry).toBe(80);
    expect(fv.hpAtStage4Entry).toBe(50);
    expect(fv.hpAtStage5Entry).toBeNull();
  });

  it('computes hpCrisisRoundRatio from context.hpCrisisRounds', () => {
    const rounds = [makeRound({ label: '3-1' }), makeRound({ label: '3-2' }), makeRound({ label: '3-3' })];
    const context = makeContext({ hpCrisisRounds: new Set(['3-2']) });
    const fv = extractFeatureVector(makeMatch(rounds), [], context, makeMeta());
    expect(fv.hpCrisisRoundRatio).toBeCloseTo(1 / 3, 5);
  });
});

describe('extractFeatureVector — situational flags and totals', () => {
  it('carries isRerollComp/isFastTempo/isSlowRoll from context as 0/1', () => {
    const context = makeContext({
      isRerollComp: true,
      isFastTempo: false,
      plan: { headline: '', finalTraits: [], pivots: [], econStyle: 'slow_roll', econPhases: [], levelMilestones: [] },
    });
    const fv = extractFeatureVector(makeMatch([makeRound({})]), [], context, makeMeta());
    expect(fv.isRerollComp).toBe(1);
    expect(fv.isFastTempo).toBe(0);
    expect(fv.isSlowRoll).toBe(1);
  });

  it('sets totalRounds to the match round count and schemaVersion to 1', () => {
    const fv = extractFeatureVector(makeMatch([makeRound({}), makeRound({})]), [], makeContext(), makeMeta());
    expect(fv.totalRounds).toBe(2);
    expect(fv.schemaVersion).toBe(1);
  });
});
