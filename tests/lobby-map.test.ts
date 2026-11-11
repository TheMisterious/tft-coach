// The lobby read (src/coach/lobby-map.ts): each opponent's path, their
// fights against you, the last board of theirs the game sent, which of your
// committed units they fielded, and the checkpoint standings.

import { describe, it, expect } from 'vitest';
import { readLobby, holdersOf } from '../src/coach/lobby-map';
import type { MatchSnapshot, MetaData, RoundSnapshot, LobbyPlayerState, BoardState } from '../src/shared/types';

const meta = {
  champions: {
    Veigar: { name: 'Veigar', tier: 3, role: 'carry', traits: ['Mage'] },
    Ornn:   { name: 'Ornn',   tier: 4, role: 'tank',  traits: ['Guardian'] },
    Teemo:  { name: 'Teemo',  tier: 2, role: 'carry', traits: ['Mage'] },
    Garen:  { name: 'Garen',  tier: 1, role: 'tank',  traits: ['Guardian'] },
  },
  traitBreakpoints: [{ trait: 'Mage', tiers: [2, 4] }, { trait: 'Guardian', tiers: [2, 4] }],
  itemData: {},
  items: {},
} as unknown as MetaData;

const cell = (name: string, level = 1) => ({ name, level, item_1: '', item_2: '', item_3: '' });
const board = (...names: string[]): BoardState => Object.fromEntries(names.map((n, i) => [`cell_${i}`, cell(n)]));

function lobby(me: number, others: Record<string, [number, number, number?]>): LobbyPlayerState[] {
  return [
    { name: 'me', health: me, level: 7, isLocal: true, rank: 0 },
    ...Object.entries(others).map(([name, [health, level, rank]]) => ({ name, health, level, isLocal: false, rank: rank ?? 0 })),
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

const match = (rounds: RoundSnapshot[]): MatchSnapshot =>
  ({ pseudoMatchId: 't', setId: 'set18', gameMode: 'tft', rounds, finalPlacement: 5, placementSource: 'rank', finalBoard: {}, augments: [], godPicks: [] });

const MATCH = match([
  round('2-7', { health: 80, lobby: lobby(80, { A: [90, 6], B: [70, 6], C: [60, 5] }) }),
  round('3-1', {
    health: 70, outcome: 'loss', opponentName: 'A', opponentBoardFresh: true,
    opponentBoard: board('Veigar', 'Teemo', 'Garen'),
    lobby: lobby(70, { A: [90, 7], B: [65, 7], C: [50, 6] }),
    lobbyOutcomes: { me: 'loss', A: 'win', B: 'win', C: 'loss' },
    scouted: ['B'],
    battleStats: { own: [], opponent: [{ name: 'Veigar', totalDamage: 900, totalBlocked: 0, healed: 0, shielded: 0 }, { name: 'Teemo', totalDamage: 100, totalBlocked: 0, healed: 0, shielded: 0 }] },
  }),
  round('3-2', {
    health: 70, outcome: 'win', opponentName: 'C', opponentBoardFresh: true,
    opponentBoard: board('Garen', 'Teemo', 'Teemo'),
    lobby: lobby(70, { A: [90, 7], B: [60, 7], C: [40, 6] }),
    lobbyOutcomes: { me: 'win', A: 'win', B: 'loss', C: 'loss' },
    scouted: [],
  }),
  round('3-3', {
    health: 70, outcome: 'win', opponentName: 'B', opponentBoardFresh: true,
    opponentBoard: board('Veigar', 'Ornn', 'Garen'),
    lobby: lobby(70, { A: [90, 7], B: [50, 7], C: [0, 6, 8] }),
    lobbyOutcomes: { me: 'win', A: 'win', B: 'loss', C: 'loss' },
    scouted: ['A', 'B'],
  }),
  round('4-1', { health: 70, lobby: lobby(70, { A: [90, 8], B: [50, 7], C: [0, 6, 8] }), scouted: [] }),
]);

describe('readLobby', () => {
  const read = readLobby(MATCH, meta)!;

  it('is undefined without a roster', () => {
    expect(readLobby(match([round('3-1')]), meta)).toBeUndefined();
  });

  it('orders eliminated players by rank and the living by HP', () => {
    expect(read.opponents.map(o => o.name)).toEqual(['A', 'B', 'C']);
    const c = read.opponents.find(o => o.name === 'C')!;
    expect(c.eliminatedAt).toBe('3-3');
    expect(c.finalRank).toBe(8);
  });

  it('counts each opponent\'s lobby results and your fights against them', () => {
    const a = read.opponents.find(o => o.name === 'A')!;
    expect([a.wins, a.losses]).toEqual([3, 0]);
    expect(a.fights).toEqual([{ round: '3-1', result: 'loss', hpBefore: 80, hpAfter: 70 }]);
    expect(a.scoutedAt).toEqual(['3-3']);
  });

  it('keeps the last board seen with its traits, value and damage lead', () => {
    const a = read.opponents.find(o => o.name === 'A')!;
    expect(a.lastBoard?.round).toBe('3-1');
    expect(a.lastBoard?.traits).toEqual(['Mage']);
    expect(a.lastBoard?.value).toBe(3 + 2 + 1);
    expect(a.lastBoard?.carry).toBe('Veigar');
  });

  it('lists your committed units each opponent fielded', () => {
    expect(read.opponents.find(o => o.name === 'A')!.contested.map(c => c.name)).toEqual(['Veigar']);
    expect(read.opponents.find(o => o.name === 'B')!.contested.map(c => c.name)).toEqual(['Veigar', 'Ornn']);
    expect(read.opponents.find(o => o.name === 'C')!.contested).toEqual([]);
    expect(holdersOf(read, 'Veigar')).toEqual(['A', 'B']);
  });

  it('reads the checkpoint standing, who is below you, the leaders and the contested core', () => {
    const c41 = read.checkpoints.find(c => c.round === '4-1')!;
    expect(c41.alive).toBe(3);
    expect(c41.hpRank).toBe(2);
    expect(c41.playersBelow).toBe(1);
    expect(c41.closestBelow).toBe(20);
    expect(c41.leaders).toEqual(['A']);
    expect(c41.contestedCore).toEqual([{ id: 'Veigar', name: 'Veigar', by: ['A', 'B'] }, { id: 'Ornn', name: 'Ornn', by: ['B'] }]);
    // At 3-1 only A's board had been seen.
    expect(read.checkpoints.find(c => c.round === '3-1')!.contestedCore).toEqual([{ id: 'Veigar', name: 'Veigar', by: ['A'] }]);
  });

  it('totals scouting over the rounds that had the feed', () => {
    expect(read.scouting).toEqual({ rounds: 4, scoutedRounds: 2, boards: 2, byStage: { '3': { rounds: 3, scouted: 2 }, '4': { rounds: 1, scouted: 0 } } });
    const noFeed = match([round('3-1', { lobby: lobby(70, { A: [90, 7] }) })]);
    expect(readLobby(noFeed, meta)!.scouting).toBeUndefined();
  });
});
