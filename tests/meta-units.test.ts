// Champion prevalence from the set's Riot records (MetaData.metaUnits,
// src/enrichment/meta-lookup.ts): loaded from riot-meta.source.json where a
// set has one, absent where it does not, and read as a contest prior by the
// lobby map, the decision windows and the carry-contested detector.

import { describe, it, expect } from 'vitest';
import { loadMeta, toMetaUnits, unitPrevalence, prevalenceClause } from '../src/enrichment/meta-lookup';
import { readLobby } from '../src/coach/lobby-map';
import { readDecisionWindows } from '../src/coach/decision-windows';
import type { MatchSnapshot, MetaData, RoundSnapshot, BoardState, LobbyPlayerState } from '../src/shared/types';

describe('metaUnits from riot-meta.source.json', () => {
  it('loads Set 18\'s records and leaves Set 17 without any', async () => {
    const set18 = await loadMeta('set18');
    expect(set18.metaUnits?.boards).toBeGreaterThan(1000);
    expect(set18.metaUnits?.units['DA_18_Ezreal']?.appearances).toBeGreaterThan(0);
    const set17 = await loadMeta('set17');
    expect(set17.metaUnits).toBeUndefined();
  });

  it('reads a share only for a unit the records hold', async () => {
    const meta = await loadMeta('set18');
    const p = unitPrevalence('DA_18_Ezreal', meta)!;
    expect(p.share).toBeGreaterThan(0);
    expect(p.share).toBeLessThan(1);
    expect(unitPrevalence('DA_18_Lux_Inferno', meta)).toBeUndefined();
    expect(prevalenceClause('DA_18_Lux_Inferno', meta)).toBe('');
    expect(prevalenceClause('DA_18_Ezreal', meta)).toMatch(/^ In Riot's records of [\d,]+ top-player boards it is on \d+%\.$/);
  });

  it('rejects a source file with no boards or no tallies', () => {
    expect(toMetaUnits(null)).toBeUndefined();
    expect(toMetaUnits({ boards: 0, roleEvidence: { X: { appearances: 1 } } })).toBeUndefined();
    expect(toMetaUnits({ boards: 10 })).toBeUndefined();
    expect(toMetaUnits({ boards: 10, source: 's', roleEvidence: { X: { appearances: 4, itemized: 1 }, Y: {} } }))
      .toEqual({ source: 's', boards: 10, units: { X: { appearances: 4, itemized: 1 } } });
  });
});

describe('prevalence in the lobby read and the decision windows', () => {
  const meta = {
    champions: { Veigar: { name: 'Veigar', tier: 3, role: 'carry', traits: [] }, Ornn: { name: 'Ornn', tier: 4, role: 'tank', traits: [] } },
    traitBreakpoints: [], itemData: {}, items: {},
    metaUnits: { source: 'test', boards: 100, units: { Veigar: { appearances: 25, itemized: 10 } } },
  } as unknown as MetaData;
  const cell = (name: string) => ({ name, level: 1, item_1: '', item_2: '', item_3: '' });
  const board = (...names: string[]): BoardState => Object.fromEntries(names.map((n, i) => [`cell_${i}`, cell(n)]));
  const lobby: LobbyPlayerState[] = [
    { name: 'me', health: 60, level: 7, isLocal: true, rank: 0 },
    { name: 'A', health: 70, level: 7, isLocal: false, rank: 0 },
  ];
  const round = (label: string, over: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
    label, type: 'PVP', goldStart: 30, goldEnd: 30, health: 60, level: 7,
    rollsSpent: 0, xpBought: false, board: board('Veigar', 'Ornn'), bench: {}, benchItems: [], shop: [],
    augmentsPicked: [], opponentBoard: {}, interestEarned: 0, streakCount: 0, streakType: 'none', lobby, ...over,
  });
  const match: MatchSnapshot = {
    pseudoMatchId: 't', setId: 'set18', gameMode: 'tft', finalPlacement: 5, placementSource: 'rank', finalBoard: {}, augments: [], godPicks: [],
    rounds: [
      round('3-1', { opponentName: 'A', opponentBoardFresh: true, opponentBoard: board('Veigar', 'Ornn', 'Ornn') }),
      round('3-2'),
      round('4-1'),
    ],
  };

  it('attaches the share to the contested core and the window\'s contest line', () => {
    const read = readLobby(match, meta)!;
    const c41 = read.checkpoints.find(c => c.round === '4-1')!;
    // Equal holder counts sort by name.
    expect(c41.contestedCore).toEqual([
      { id: 'Ornn', name: 'Ornn', by: ['A'] },
      { id: 'Veigar', name: 'Veigar', by: ['A'], share: 0.25 },
    ]);
    const w = readDecisionWindows(match, meta, undefined, read).find(x => x.round === '3-2')!;
    expect(w.state.contested).toEqual(['Veigar (1 opponent, on 25% of top-player boards)', 'Ornn (1 opponent)']);
  });
});
