// Unit coverage for src/coach/checkers/econ.ts — previously had zero
// dedicated tests (only generic golden-match smoke tests). Focused on the
// pivot-context wiring added 2026-07-28 (checkers/econ.ts now appends a
// clause from plan-builder.ts's pivotContextClause when context.plan shows a
// recent comp pivot) — real user feedback that the Game Plan overview didn't
// connect back to the per-round notes.

import { describe, it, expect } from 'vitest';
import { checkEcon } from '../src/coach/checkers/econ';
import type { MatchSnapshot, RoundSnapshot, MetaData, MatchContext } from '../src/shared/types';

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

function makeMeta(): MetaData {
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
  };
}

const NEUTRAL: MatchContext = {
  isRerollComp: false,
  hpCrisisRounds: new Set(),
  activeComp: new Set(),
  isFastTempo: false,
};

describe('ECON_001 — missed interest bracket', () => {
  it('fires when ending gold is 1-3g below a bracket', () => {
    const rounds = [makeRound({ label: '3-1', goldEnd: 18 })];
    const points = checkEcon(makeMatch(rounds), makeMeta(), NEUTRAL);
    expect(points.find(p => p.ruleId === 'ECON_001')).toBeTruthy();
  });

  it('does not fire when already at or above a bracket', () => {
    const rounds = [makeRound({ label: '3-1', goldEnd: 20 })];
    const points = checkEcon(makeMatch(rounds), makeMeta(), NEUTRAL);
    expect(points.find(p => p.ruleId === 'ECON_001')).toBeUndefined();
  });

  it('appends a pivot-context clause when the note fires shortly after a detected comp pivot', () => {
    const rounds = [makeRound({ label: '4-1', goldEnd: 18 })];
    const context: MatchContext = {
      ...NEUTRAL,
      plan: {
        headline: 'test', finalTraits: [], econStyle: 'standard', econPhases: [], levelMilestones: [],
        pivots: [{ round: '4-1', from: ['Anima'], to: ['Bastion', 'Sniper'] }],
      },
    };
    const points = checkEcon(makeMatch(rounds), makeMeta(), context);
    const hit = points.find(p => p.ruleId === 'ECON_001');
    expect(hit?.coaching_text).toContain('pivoted from Anima to Bastion/Sniper at 4-1');
  });

  it('does not append a pivot clause when no pivot is recent', () => {
    const rounds = [makeRound({ label: '4-1', goldEnd: 18 })];
    const context: MatchContext = {
      ...NEUTRAL,
      plan: { headline: 'test', finalTraits: [], econStyle: 'standard', econPhases: [], levelMilestones: [], pivots: [] },
    };
    const points = checkEcon(makeMatch(rounds), makeMeta(), context);
    const hit = points.find(p => p.ruleId === 'ECON_001');
    expect(hit?.coaching_text).not.toContain('pivoted');
  });
});
