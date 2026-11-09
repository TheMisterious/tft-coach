// Fight reading (src/coach/fights.ts): what each player fight's boards were
// worth, and who did the damage.

import { describe, it, expect } from 'vitest';
import { readBoard, readFights } from '../src/coach/fights';
import type { BoardState, MatchSnapshot, MetaData, RoundSnapshot } from '../src/shared/types';

const meta = {
  champions: {
    Veigar: { name: 'Veigar', tier: 3, role: 'carry', traits: [] },
    Ornn:   { name: 'Ornn',   tier: 4, role: 'tank',  traits: [] },
    Teemo:  { name: 'Teemo',  tier: 2, role: 'carry', traits: [] },
  },
  itemData: {
    TFT_Item_BlueBuff:   { name: 'Blue Buff', isComponent: false, composition: [], tags: ['offense'], keyStats: {} },
    TFT_Item_RecurveBow: { name: 'Recurve Bow', isComponent: true, composition: [], tags: ['offense'], keyStats: {} },
  },
  items: {},
} as unknown as MetaData;

const cell = (name: string, level: number, ...items: string[]) =>
  ({ name, level, item_1: items[0] ?? '', item_2: items[1] ?? '', item_3: items[2] ?? '' });

function round(label: string, over: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    label, type: 'PVP', goldStart: 30, goldEnd: 30, health: 60, level: 7,
    rollsSpent: 0, xpBought: false, board: {}, bench: {}, benchItems: [], shop: [],
    augmentsPicked: [], opponentBoard: {}, interestEarned: 0, streakCount: 0, streakType: 'none',
    ...over,
  };
}

const match = (rounds: RoundSnapshot[]): MatchSnapshot =>
  ({ pseudoMatchId: 't', setId: 'set18', gameMode: 'tft', rounds, finalPlacement: 6, finalBoard: {}, augments: [], godPicks: [] });

describe('readBoard', () => {
  it('values units at cost times copies and splits items from components', () => {
    const board: BoardState = {
      a: cell('Veigar', 3, 'TFT_Item_BlueBuff', 'TFT_Item_RecurveBow'),
      b: cell('Ornn', 2),
      c: cell('Teemo', 1, 'TFT_Item_BlueBuff'),
    };
    expect(readBoard(board, meta)).toEqual({ units: 3, value: 3 * 9 + 4 * 3 + 2, twoStars: 1, threeStars: 1, items: 2, components: 1 });
  });

  it("leaves out summons that aren't champions", () => {
    const board: BoardState = { a: cell('Veigar', 1), tree: cell('DA_Elderwood18_StonebarkTree', 1) };
    expect(readBoard(board, meta).units).toBe(1);
  });
});

describe('readFights', () => {
  const mine: BoardState = { a: cell('Veigar', 2, 'TFT_Item_BlueBuff'), b: cell('Ornn', 1), c: cell('Teemo', 1) };
  const theirs: BoardState = { a: cell('Teemo', 2, 'TFT_Item_BlueBuff'), b: cell('Ornn', 2), c: cell('Veigar', 1) };

  it('reads a fight with no reported result from the HP it cost', () => {
    const [f] = readFights(match([round('3-1', { health: 52, board: mine })]), meta);
    expect(f.result).toBe('loss');
    expect(f.hpBefore).toBe(100);
  });

  it("uses the opponent's board only when it was sent that round", () => {
    const stale = readFights(match([round('3-1', { board: mine, opponentBoard: theirs })]), meta)[0];
    const fresh = readFights(match([round('3-1', { board: mine, opponentBoard: theirs, opponentBoardFresh: true })]), meta)[0];
    expect(stale.opp).toBeUndefined();
    expect(fresh.opp?.twoStars).toBe(2);
  });

  it('ignores a partial opponent board', () => {
    const full: BoardState = { ...mine, d: cell('Teemo', 1), e: cell('Ornn', 1), f: cell('Veigar', 1), g: cell('Teemo', 1) };
    const [f] = readFights(match([round('4-1', { board: full, opponentBoard: { a: cell('Teemo', 2) }, opponentBoardFresh: true })]), meta);
    expect(f.opp).toBeUndefined();
  });

  it('names the unit that did most of each side\'s damage', () => {
    const [f] = readFights(match([round('3-2', {
      board: mine, opponentBoard: theirs, opponentBoardFresh: true,
      battleStats: {
        own: [{ name: 'Veigar', totalDamage: 600, totalBlocked: 0, healed: 0, shielded: 0 }, { name: 'Ornn', totalDamage: 400, totalBlocked: 0, healed: 0, shielded: 0 }],
        opponent: [{ name: 'Teemo', totalDamage: 900, totalBlocked: 0, healed: 0, shielded: 0 }, { name: 'Ornn', totalDamage: 100, totalBlocked: 0, healed: 0, shielded: 0 }],
      },
    })]), meta);
    expect(f.ownLead).toMatchObject({ name: 'Veigar', stars: 2, share: 0.6 });
    expect(f.oppLead).toMatchObject({ name: 'Teemo', stars: 2, share: 0.9, items: ['Blue Buff'] });
  });
});
