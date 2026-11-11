// The four candidate rules written on 2026-11-11 on the per-roll shops,
// scouting, item offers and roster rank the reconstruction now keeps
// (SHOP_001, SCOUT_001, LOBBY_003, ITEM_006). Each fires only when EVERY
// condition holds; these pin each condition by breaking it alone.

import { describe, it, expect } from 'vitest';
import { checkShop } from '../src/coach/checkers/shop';
import { checkScouting } from '../src/coach/checkers/scouting';
import { checkOffers } from '../src/coach/checkers/offers';
import { checkLobby } from '../src/coach/checkers/lobby';
import type { MatchSnapshot, MetaData, RoundSnapshot, BoardState, LobbyPlayerState } from '../src/shared/types';

const meta = {
  champions: {
    Veigar: { name: 'Veigar', tier: 3, role: 'carry', traits: [] },
    Ornn:   { name: 'Ornn',   tier: 4, role: 'tank',  traits: [] },
    Teemo:  { name: 'Teemo',  tier: 2, role: 'flex',  traits: [] },
  },
  carryBis: {
    Veigar: { role: 'carry', items_bis: [], items_alt: [], components_priority: ['TFT_Item_TearOfTheGoddess', 'TFT_Item_NeedlesslyLargeRod'], notes: 'Most built on Veigar in 50 top-4 boards: Blue Buff 60%.' },
  },
  traitBreakpoints: [],
  itemData: {
    TFT_Item_TearOfTheGoddess:  { name: 'Tear of the Goddess', isComponent: true, composition: [], tags: ['offense'], keyStats: {} },
    TFT_Item_NeedlesslyLargeRod: { name: 'Needlessly Large Rod', isComponent: true, composition: [], tags: ['offense'], keyStats: {} },
    TFT_Item_ChainVest:         { name: 'Chain Vest', isComponent: true, composition: [], tags: ['tank'], keyStats: {} },
    TFT_Item_GiantsBelt:        { name: "Giant's Belt", isComponent: true, composition: [], tags: ['tank'], keyStats: {} },
    TFT_Item_BlueBuff:          { name: 'Blue Buff', isComponent: false, composition: ['TFT_Item_TearOfTheGoddess', 'TFT_Item_TearOfTheGoddess'], tags: ['offense'], keyStats: {} },
    TFT_Item_Artifact_X:        { name: 'An Artifact', isComponent: false, composition: [], tags: ['offense'], keyStats: {} },
  },
  items: {},
} as unknown as MetaData;

const cell = (name: string, level = 1, ...items: string[]) => ({ name, level, item_1: items[0] ?? '', item_2: items[1] ?? '', item_3: items[2] ?? '' });
const board = (...names: string[]): BoardState => Object.fromEntries(names.map((n, i) => [`cell_${i}`, cell(n)]));

function round(label: string, over: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    label, type: 'PVP', goldStart: 40, goldEnd: 40, health: 60, level: 7,
    rollsSpent: 0, xpBought: false, board: board('Veigar', 'Ornn'), bench: {}, benchItems: [], shop: [],
    augmentsPicked: [], opponentBoard: {}, interestEarned: 0, streakCount: 0, streakType: 'none',
    ...over,
  };
}

const match = (rounds: RoundSnapshot[]): MatchSnapshot =>
  ({ pseudoMatchId: 't', setId: 'set18', gameMode: 'tft', rounds, finalPlacement: 6, placementSource: 'rank', finalBoard: {}, augments: [], godPicks: [] });

const count = (points: Array<{ ruleId?: string }>, rule: string) => points.filter(p => p.ruleId === rule).length;

describe('SHOP_001 — a third copy of a held pair shown and passed while losing', () => {
  // Two 1-star Teemos held through 3-4; the 3-5 shops show a Teemo; not bought.
  const pair = { board: board('Veigar', 'Ornn', 'Teemo'), bench: board('Teemo') };
  const base = (over: Partial<RoundSnapshot>[] = []) => match([
    round('3-2', { health: 70, outcome: 'loss', ...pair, ...over[0] }),
    round('3-3', { health: 60, outcome: 'loss', ...pair, ...over[1] }),
    round('3-4', { health: 60, outcome: 'win', ...pair, ...over[2] }),
    round('3-5', { ...pair, goldEnd: 30, shopsSeen: [['Veigar', 'Ornn', 'Teemo', 'Ornn', 'Veigar']], bought: [], ...over[3] }),
  ]);
  const fire = (m: MatchSnapshot) => count(checkShop(m, meta), 'SHOP_001');

  it('fires when every condition holds', () => {
    const pts = checkShop(base(), meta);
    expect(count(pts, 'SHOP_001')).toBe(1);
    expect(pts[0].observed).toContain('Teemo');
    expect(pts[0].round).toBe('3-5');
  });

  it('does not fire when the copy was bought', () => {
    expect(fire(base([{}, {}, {}, { bought: ['Teemo'], board: board('Veigar', 'Ornn', 'Teemo'), bench: board('Teemo', 'Teemo') }]))).toBe(0);
  });

  it('does not fire when the pair became a 2-star by round end', () => {
    expect(fire(base([{}, {}, {}, { board: { ...board('Veigar', 'Ornn'), t: cell('Teemo', 2) }, bench: {} }]))).toBe(0);
  });

  it('does not fire without two losses in the last three fights', () => {
    expect(fire(base([{ outcome: 'win' }]))).toBe(0);
  });

  it('does not fire without the gold to cover the unit', () => {
    expect(fire(base([{}, {}, {}, { goldEnd: 1 }]))).toBe(0);
  });

  it('does not fire when no shop showed the unit', () => {
    expect(fire(base([{}, {}, {}, { shopsSeen: [['Veigar', 'Ornn', 'Ornn', 'Ornn', 'Veigar']] }]))).toBe(0);
  });
});

describe('SCOUT_001 — no scouting through stages 3-4 while contested or losing', () => {
  const lobby: LobbyPlayerState[] = [
    { name: 'me', health: 60, level: 7, isLocal: true, rank: 0 },
    { name: 'A', health: 70, level: 7, isLocal: false, rank: 0 },
    { name: 'B', health: 70, level: 7, isLocal: false, rank: 0 },
  ];
  const fights = (scouted: string[] = [], outcome: 'win' | 'loss' = 'loss') => [
    round('3-1', { outcome, scouted, lobby, opponentName: 'A', opponentBoardFresh: true, opponentBoard: board('Veigar', 'Teemo', 'Teemo') }),
    round('3-2', { outcome, scouted, lobby, opponentName: 'B', opponentBoardFresh: true, opponentBoard: board('Veigar', 'Ornn', 'Teemo') }),
    round('3-3', { outcome, scouted, lobby }),
    round('3-5', { outcome, scouted, lobby }),
  ];
  const fire = (rs: RoundSnapshot[]) => count(checkScouting(match(rs), meta), 'SCOUT_001');

  it('fires with no scouting, a contested unit and the losses', () => {
    const pts = checkScouting(match(fights()), meta);
    expect(count(pts, 'SCOUT_001')).toBe(1);
    expect(pts[0].observed).toContain('Veigar was on the boards of 2 opponents');
    expect(pts[0].observed).toContain('lost 4 of those 4 fights');
  });

  it('fires on contest alone, and on losses alone', () => {
    expect(fire(fights([], 'win'))).toBe(1);      // contested, not losing
    const uncontested = fights().map(r => ({ ...r, opponentBoard: board('Teemo', 'Teemo', 'Teemo') }));
    expect(fire(uncontested)).toBe(1);             // losing, not contested
    const neither = fights([], 'win').map(r => ({ ...r, opponentBoard: board('Teemo', 'Teemo', 'Teemo') }));
    expect(fire(neither)).toBe(0);
  });

  it('does not fire once any fight was scouted', () => {
    const rs = fights();
    rs[2] = { ...rs[2], scouted: ['A'] };
    expect(fire(rs)).toBe(0);
  });

  it('does not fire without the feed, or with too few rounds of it', () => {
    expect(fire(fights().map(r => { const { scouted: _s, ...rest } = r; return rest as RoundSnapshot; }))).toBe(0);
    expect(fire(fights().slice(0, 3))).toBe(0);
  });
});

describe('LOBBY_003 — lowest HP in the lobby with gold banked', () => {
  const roster = (me: number): LobbyPlayerState[] => [
    { name: 'me', health: me, level: 7, isLocal: true, rank: 0 },
    { name: 'A', health: 70, level: 7, isLocal: false, rank: 0 },
    { name: 'B', health: 50, level: 7, isLocal: false, rank: 0 },
    { name: 'C', health: 40, level: 7, isLocal: false, rank: 0 },
  ];
  const base = (over: Partial<RoundSnapshot> = {}, me = 30) => match([
    round('4-1', { health: me, lobby: roster(me) }),
    round('4-2', { health: me - 12, outcome: 'loss', goldStart: 45, goldEnd: 48, rollsSpent: 0, lobby: roster(me - 12), ...over }),
  ]);
  const fire = (m: MatchSnapshot) => count(checkLobby(m), 'LOBBY_003');

  it('fires when the lowest HP player entered with a bank, spent nothing and lost', () => {
    const pts = checkLobby(base());
    expect(count(pts, 'LOBBY_003')).toBe(1);
    expect(pts.find(p => p.ruleId === 'LOBBY_003')!.observed).toContain('lowest HP of the 4 players still in');
  });

  it('does not fire when another player was lower, or tied', () => {
    expect(fire(base({}, 45))).toBe(0);
    expect(fire(base({}, 40))).toBe(0);
  });

  it('does not fire after a roll-down or a level, or without the bank', () => {
    expect(fire(base({ rollsSpent: 6 }))).toBe(0);
    expect(fire(base({ xpBought: true }))).toBe(0);
    expect(fire(base({ goldStart: 20 }))).toBe(0);
  });

  it('does not fire on a won fight, before stage 4, or with too few players left', () => {
    expect(fire(base({ outcome: 'win', health: 30 }))).toBe(0);
    const early = match([round('3-6', { health: 30, lobby: roster(30) }), round('3-7', { health: 18, outcome: 'loss', goldStart: 45, lobby: roster(18) })]);
    expect(fire(early)).toBe(0);
    const thin = match([round('4-1', { health: 30, lobby: roster(30).slice(0, 3) }), round('4-2', { health: 18, outcome: 'loss', goldStart: 45, lobby: roster(18).slice(0, 3) })]);
    expect(fire(thin)).toBe(0);
  });

  it('fires once per run of such rounds', () => {
    const m = match([
      round('4-1', { health: 30, lobby: roster(30) }),
      round('4-2', { health: 20, outcome: 'loss', goldStart: 45, lobby: roster(20) }),
      round('4-3', { health: 10, outcome: 'loss', goldStart: 50, lobby: roster(10) }),
    ]);
    expect(fire(m)).toBe(1);
  });
});

describe('ITEM_006 — item choice passed on the carry\'s priority component', () => {
  const offer = (picked: string, offered = ['TFT_Item_TearOfTheGoddess', 'TFT_Item_ChainVest', 'TFT_Item_GiantsBelt', 'TFT_Item_Artifact_X']) =>
    [{ offered, picked }];
  const base = (over: Partial<RoundSnapshot> = {}) => match([round('3-4', { itemOffers: offer('TFT_Item_ChainVest'), ...over })]);
  const fire = (m: MatchSnapshot) => count(checkOffers(m, meta), 'ITEM_006');

  it('fires when a priority component was offered and another component taken', () => {
    const pts = checkOffers(base(), meta);
    expect(count(pts, 'ITEM_006')).toBe(1);
    expect(pts[0].observed).toBe('The item choice at 3-4 offered Tear of the Goddess, a priority component for Veigar in top-4 boards, and you took Chain Vest; Veigar held 0 completed items');
  });

  it('does not fire when the priority component was taken', () => {
    expect(fire(base({ itemOffers: offer('TFT_Item_TearOfTheGoddess') }))).toBe(0);
  });

  it('does not fire when an artifact or finished item was taken instead', () => {
    expect(fire(base({ itemOffers: offer('TFT_Item_Artifact_X') }))).toBe(0);
  });

  it('does not fire when no priority component was on offer', () => {
    expect(fire(base({ itemOffers: offer('TFT_Item_ChainVest', ['TFT_Item_ChainVest', 'TFT_Item_GiantsBelt']) }))).toBe(0);
  });

  it('does not fire once the carry holds three completed items, or has no priority list', () => {
    const full = { ...board('Ornn'), v: cell('Veigar', 2, 'TFT_Item_BlueBuff', 'TFT_Item_BlueBuff', 'TFT_Item_BlueBuff') };
    expect(fire(base({ board: full }))).toBe(0);
    expect(fire(base({ board: board('Ornn', 'Teemo') }))).toBe(0);
  });

  it('does not fire without a pick recorded, or without carry-bis data', () => {
    expect(fire(base({ itemOffers: [{ offered: ['TFT_Item_TearOfTheGoddess'] }] }))).toBe(0);
    expect(count(checkOffers(base(), { ...meta, carryBis: {} }), 'ITEM_006')).toBe(0);
  });
});
