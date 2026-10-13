// The two candidate rules written on 2026-10-14 (ECON_005, ROLL_006). Each is
// a narrower, conditional version of an existing heuristic and must fire only
// when EVERY condition holds; these pin each condition by breaking it alone.

import { describe, it, expect } from 'vitest';
import { checkEcon } from '../src/coach/checkers/econ';
import { checkLobby } from '../src/coach/checkers/lobby';
import type { MatchSnapshot, RoundSnapshot, BoardState, LobbyPlayerState } from '../src/shared/types';

function round(label: string, over: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    label, type: 'PVP', outcome: 'loss', goldStart: 0, goldEnd: 30, health: 60, level: 6,
    rollsSpent: 0, xpBought: false, board: {}, bench: {}, benchItems: [], shop: [],
    augmentsPicked: [], opponentBoard: {}, interestEarned: 0, streakCount: 0, streakType: 'none',
    ...over,
  };
}

const board = (...names: string[]): BoardState =>
  Object.fromEntries(names.map((n, i) => [`cell_${i}`, { name: n, level: 1, item_1: '', item_2: '', item_3: '' }]));

const match = (rounds: RoundSnapshot[]): MatchSnapshot =>
  ({ pseudoMatchId: 't', setId: 'set17', gameMode: 'tft', rounds, finalPlacement: 6, finalBoard: {}, augments: [], godPicks: [] });

const ids = (m: MatchSnapshot, fn: (m: MatchSnapshot) => Array<{ ruleId?: string }>, rule: string) =>
  fn(m).filter(p => p.ruleId === rule).length;

describe('ECON_005 — idle gold while losing, with an upgrade on offer', () => {
  const upgrade = { board: board('TFT17_Jinx'), shop: ['TFT17_Jinx'] };
  const stage3 = (over: Partial<RoundSnapshot>[] = []) => [
    round('3-1', { goldEnd: 55, ...upgrade, ...over[0] }),
    round('3-2', { goldEnd: 60, ...over[1] }),
    round('3-3', { goldEnd: 30, rollsSpent: 2, outcome: 'win', ...over[2] }),
  ];
  const fire = (rs: RoundSnapshot[]) => ids(match(rs), m => checkEcon(m), 'ECON_005');

  it('fires when gold sat idle 2+ rounds, 2+ fights were lost, and an upgrade was on offer', () => {
    expect(fire(stage3())).toBe(1);
  });

  it('does not fire with only one idle round', () => {
    expect(fire(stage3([{}, { rollsSpent: 1 }]))).toBe(0);
  });

  it('does not fire when fewer than two fights were lost', () => {
    expect(fire(stage3([{}, { outcome: 'win' }]))).toBe(0);
  });

  it('does not fire when nothing was on offer to upgrade', () => {
    expect(fire(stage3([{ shop: [] }]))).toBe(0);
  });
});

describe('ROLL_006 — behind the lobby at a roll-down window, gold banked', () => {
  const lobby = (me: Partial<LobbyPlayerState>): LobbyPlayerState[] => [
    { name: 'me', health: 40, level: 6, isLocal: true, ...me },
    { name: 'a', health: 70, level: 7, isLocal: false },
    { name: 'b', health: 65, level: 7, isLocal: false },
    { name: 'c', health: 60, level: 7, isLocal: false },
  ];
  const at41 = (over: Partial<RoundSnapshot> = {}, me: Partial<LobbyPlayerState> = {}) =>
    round('4-1', { goldEnd: 40, rollsSpent: 0, board: board('TFT17_Jinx'), shop: ['TFT17_Jinx'], lobby: lobby(me), ...over });
  const fire = (r: RoundSnapshot) => ids(match([r]), m => checkLobby(m), 'ROLL_006');

  it('fires behind on level and HP, with gold banked, no roll-down, and an upgrade on offer', () => {
    expect(fire(at41())).toBe(1);
  });

  it('does not fire outside a roll-down window', () => {
    expect(fire({ ...at41(), label: '4-3' })).toBe(0);
  });

  it('does not fire with an HP lead paying for staying low', () => {
    expect(fire(at41({}, { health: 80 }))).toBe(0);
  });

  it('does not fire at or above the lobby median level', () => {
    expect(fire(at41({}, { level: 7 }))).toBe(0);
  });

  it('does not fire without banked gold, or after a real roll-down', () => {
    expect(fire(at41({ goldEnd: 20 }))).toBe(0);
    expect(fire(at41({ rollsSpent: 5 }))).toBe(0);
  });

  it('does not fire when a roll had nothing to hit', () => {
    expect(fire(at41({ shop: [] }))).toBe(0);
  });
});
