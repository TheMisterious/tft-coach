// Decision windows (src/coach/decision-windows.ts): the spot at each planning
// round, what the player did there, and the usual lines with their
// conditions. The lines are conditional on the state, so each case below
// sets one state and checks the line that fits it appears and its opposite
// does not.

import { describe, it, expect } from 'vitest';
import { readDecisionWindows } from '../src/coach/decision-windows';
import type { MatchSnapshot, MetaData, RoundSnapshot, LobbyPlayerState, BoardState } from '../src/shared/types';

const meta = {
  champions: {
    Veigar: { name: 'Veigar', tier: 3, role: 'carry', traits: [] },
    Ornn:   { name: 'Ornn',   tier: 4, role: 'tank',  traits: [] },
    Teemo:  { name: 'Teemo',  tier: 2, role: 'carry', traits: [] },
  },
  traitBreakpoints: [],
  itemData: { TFT_Item_BFSword: { name: 'B.F. Sword', isComponent: true, composition: [], tags: ['offense'], keyStats: {} } },
  items: {},
} as unknown as MetaData;

const cell = (name: string, level = 1) => ({ name, level, item_1: '', item_2: '', item_3: '' });
const board = (...names: string[]): BoardState => Object.fromEntries(names.map((n, i) => [`cell_${i}`, cell(n)]));

function lobby(me: number, level: number, others: Array<[number, number]>): LobbyPlayerState[] {
  return [
    { name: 'me', health: me, level, isLocal: true, rank: 0 },
    ...others.map(([health, lv], i) => ({ name: `p${i}`, health, level: lv, isLocal: false, rank: 0 })),
  ];
}

function round(label: string, over: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    label, type: 'PVP', goldStart: 30, goldEnd: 30, health: 60, level: 7,
    rollsSpent: 0, xpBought: false, board: board('Veigar', 'Ornn'), bench: {}, benchItems: [], shop: [],
    augmentsPicked: [], opponentBoard: {}, interestEarned: 0, streakCount: 0, streakType: 'none',
    ...over,
  };
}

const match = (rounds: RoundSnapshot[], placement = 5): MatchSnapshot =>
  ({ pseudoMatchId: 't', setId: 'set18', gameMode: 'tft', rounds, finalPlacement: placement, placementSource: 'rank', finalBoard: {}, augments: [], godPicks: [] });

const at = (windows: ReturnType<typeof readDecisionWindows>, label: string) => windows.find(w => w.round === label)!;

describe('readDecisionWindows', () => {
  it('reads the planning rounds present, plus the round the player went out', () => {
    const w = readDecisionWindows(match([round('2-1'), round('3-1'), round('3-2'), round('4-1'), round('4-3')]), meta);
    expect(w.map(x => x.round)).toEqual(['2-1', '3-2', '4-1', '4-3']);
    expect(at(w, '4-3').title).toBe('the round you went out');
    const winner = readDecisionWindows(match([round('2-1'), round('4-3')], 1), meta);
    expect(winner.map(x => x.round)).toEqual(['2-1']);
  });

  it('reads HP entering the round, losses left at Set 18 prices, and the lobby standing', () => {
    const w = readDecisionWindows(match([
      round('3-7', { health: 24, lobby: lobby(24, 7, [[80, 8], [60, 7], [50, 7], [20, 6]]) }),
      round('4-1', { health: 14, lobby: lobby(14, 7, [[80, 8], [60, 7], [50, 7], [20, 6]]) }),
    ]), meta);
    const s = at(w, '4-1').state;
    expect(s.hp).toBe(24);
    expect(s.lossesLeft).toBe(2);        // 24 / (7 + 3) rounded up, minus one
    expect(s.hpRank).toBe(4);
    expect(s.alive).toBe(5);
    expect(s.playersBelow).toBe(1);
    expect(s.medianLevel).toBe(7);
  });

  it('says what the player did: rolls, XP, buys, upgrade copies shown and scouting', () => {
    const w = readDecisionWindows(match([round('3-2', {
      goldStart: 60, goldEnd: 40, rollsSpent: 8, xpBought: true, bought: ['Teemo'],
      shopsSeen: [['Veigar', 'Teemo', 'Ornn', 'Teemo', 'Veigar'], ['Teemo', 'Teemo', 'Teemo', 'Teemo', 'Teemo']],
      scouted: ['p1', 'p2'],
    })]), meta);
    const did = at(w, '3-2').did;
    expect(did[0]).toBe('Rolled 8 times (16g), 2 shops seen; 60g → 40g.');
    expect(did).toContain('Bought XP (level 7 at round end).');
    expect(did).toContain('Bought Teemo.');
    expect(did.find(x => x.startsWith('Shops showed'))).toBe('Shops showed 3 copies of units you held (Veigar ×2, Ornn ×1); you bought 0 of them.');
    expect(did).toContain('Looked at 2 other boards before the fight.');
  });

  it('gives the forced-roll line only with two or fewer losses left', () => {
    const forced = readDecisionWindows(match([round('3-7', { health: 20 }), round('4-1', { health: 10 })]), meta);
    expect(at(forced, '4-1').lines.some(l => l.startsWith('About 1 loss left'))).toBe(true);
    const healthy = readDecisionWindows(match([round('3-7', { health: 80 }), round('4-1', { health: 70 })]), meta);
    expect(at(healthy, '4-1').lines.some(l => l.includes('left at this stage'))).toBe(false);
  });

  it('gives the idle-bank line only when losing with 50g+ and nothing spent', () => {
    const losses = [round('3-4', { health: 50, outcome: 'loss' }), round('3-5', { health: 40, outcome: 'loss' }), round('3-6', { health: 30, outcome: 'loss' })];
    const idle = readDecisionWindows(match([...losses, round('4-1', { goldStart: 55, goldEnd: 60 })]), meta);
    expect(at(idle, '4-1').lines.some(l => l.includes('above 50 the gold earns no interest'))).toBe(true);
    const spent = readDecisionWindows(match([...losses, round('4-1', { goldStart: 55, goldEnd: 30, rollsSpent: 12 })]), meta);
    expect(at(spent, '4-1').lines.some(l => l.includes('above 50 the gold earns no interest'))).toBe(false);
  });

  it('reads pairs and gives the short-roll line with three or more and gold to roll', () => {
    const w = readDecisionWindows(match([round('4-2', {
      goldStart: 40, board: board('Veigar', 'Ornn', 'Teemo'), bench: board('Veigar', 'Ornn', 'Teemo'),
    })]), meta);
    expect(at(w, '4-2').state.pairs).toEqual(['Veigar', 'Ornn', 'Teemo']);
    expect(at(w, '4-2').lines.some(l => l.startsWith('Holding 3 pairs'))).toBe(true);
  });

  it('separates behind-on-level with and without an HP lead', () => {
    const noLead = readDecisionWindows(match([round('4-1', { level: 6, lobby: lobby(40, 6, [[80, 8], [70, 8], [60, 7]]) })]), meta);
    expect(at(noLead, '4-1').lines.some(l => l.includes('without an HP lead'))).toBe(true);
    const lead = readDecisionWindows(match([round('4-1', { level: 6, lobby: lobby(90, 6, [[80, 8], [70, 8], [60, 7]]) })]), meta);
    expect(at(lead, '4-1').lines.some(l => l.includes('top half on HP'))).toBe(true);
    expect(at(lead, '4-1').lines.some(l => l.includes('without an HP lead'))).toBe(false);
  });

  it('names a contested unit from the boards met', () => {
    const w = readDecisionWindows(match([
      round('3-1', { opponentName: 'p0', opponentBoardFresh: true, opponentBoard: board('Veigar', 'Teemo', 'Teemo'), lobby: lobby(60, 7, [[70, 7]]) }),
      round('3-2', { lobby: lobby(60, 7, [[70, 7]]) }),
    ]), meta);
    expect(at(w, '3-2').state.contested).toEqual(['Veigar (1 opponent)']);
    expect(at(w, '3-2').lines.some(l => l.startsWith('Veigar (1 opponent) was on other boards'))).toBe(true);
  });

  it('gives the level-without-rolls line only for a level taken with little rolled behind it', () => {
    const naked = readDecisionWindows(match([round('4-1', { level: 8, xpBought: true, rollsSpent: 2, lobby: lobby(40, 8, [[80, 7], [70, 7], [60, 7]]) })]), meta);
    expect(at(naked, '4-1').lines.some(l => l.startsWith('Took level 8 this round and rolled 4g'))).toBe(true);
    const rolled = readDecisionWindows(match([round('4-1', { level: 8, xpBought: true, rollsSpent: 15, lobby: lobby(40, 8, [[80, 7], [70, 7], [60, 7]]) })]), meta);
    expect(at(rolled, '4-1').lines.some(l => l.startsWith('Took level 8'))).toBe(false);
  });

  it('falls back to a keep-the-plan line when nothing presses', () => {
    const w = readDecisionWindows(match([round('4-2', { health: 90 })]), meta);
    expect(at(w, '4-2').lines).toEqual(['Nothing in this spot pressed for a change: the usual line is to keep the plan and spend at the next window that fits it.']);
  });
});
