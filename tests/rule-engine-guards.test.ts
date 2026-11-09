// Guards in the rule engine that keep a note from contradicting the game the
// player chose to play.

import { describe, it, expect } from 'vitest';
import { isRerollLine } from '../src/coach/rule-engine';
import type { MatchSnapshot, MetaData, RoundSnapshot } from '../src/shared/types';

const meta = {
  champions: {
    Veigar: { name: 'Veigar', tier: 3, role: 'carry', traits: [] },
    Ornn:   { name: 'Ornn',   tier: 4, role: 'tank',  traits: [] },
  },
} as unknown as MetaData;

function round(label: string, level: number, over: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    label, type: 'PVP', goldStart: 30, goldEnd: 30, health: 60, level,
    rollsSpent: 0, xpBought: false, board: {}, bench: {}, benchItems: [], shop: [],
    augmentsPicked: [], opponentBoard: {}, interestEarned: 0, streakCount: 0, streakType: 'none',
    ...over,
  };
}

const match = (rounds: RoundSnapshot[]): MatchSnapshot =>
  ({ pseudoMatchId: 't', setId: 'set18', gameMode: 'tft', rounds, finalPlacement: 6, finalBoard: {}, augments: [], godPicks: [] });

const threeStarVeigar = { a: { name: 'Veigar', level: 3, item_1: '', item_2: '', item_3: '' } };
const threeStarOrnn   = { a: { name: 'Ornn',   level: 3, item_1: '', item_2: '', item_3: '' } };

describe('isRerollLine', () => {
  it('reads level 6 or lower at 4-1 with a cheap 3-star as reroll', () => {
    expect(isRerollLine(match([round('3-5', 5, { board: threeStarVeigar }), round('4-1', 5)]), meta)).toBe(true);
  });

  it('reads heavy mid-game rolling at a low level as reroll', () => {
    expect(isRerollLine(match([round('3-2', 6, { rollsSpent: 10 }), round('4-1', 6, { rollsSpent: 6 })]), meta)).toBe(true);
  });

  it('is not reroll at level 7 or higher at 4-1, or with only a 4-cost 3-star', () => {
    expect(isRerollLine(match([round('3-5', 6, { board: threeStarVeigar }), round('4-1', 7)]), meta)).toBe(false);
    expect(isRerollLine(match([round('3-5', 6, { board: threeStarOrnn }), round('4-1', 6)]), meta)).toBe(false);
  });
});
