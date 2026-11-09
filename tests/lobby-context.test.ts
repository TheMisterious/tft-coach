// Lobby-relative context (src/coach/lobby-context.ts + checkers/lobby.ts).
//
// The golden ledgers cover the capture path end to end (see the assertions at
// the bottom); these unit tests pin the ranking arithmetic and the two
// suppressions that keep the rules from giving actively bad advice.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';
import { standingFor, ordinal, lobbyClause } from '../src/coach/lobby-context';
import { checkLobby } from '../src/coach/checkers/lobby';
import { replayLedger } from './replay-harness';
import type { RoundSnapshot, MatchSnapshot, LobbyPlayerState } from '../src/shared/types';

function round(label: string, lobby?: LobbyPlayerState[]): RoundSnapshot {
  return {
    label,
    type: 'PVP',
    goldStart: 0,
    goldEnd: 0,
    health: lobby?.find(p => p.isLocal)?.health ?? 100,
    level: lobby?.find(p => p.isLocal)?.level ?? 1,
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
    lobby,
  } as RoundSnapshot;
}

function player(name: string, health: number, level: number, isLocal = false): LobbyPlayerState {
  return { name, health, level, isLocal };
}

/** Local player plus `others`, described as [health, level] pairs. */
function lobby(me: [number, number], others: Array<[number, number]>): LobbyPlayerState[] {
  return [
    player('me', me[0], me[1], true),
    ...others.map(([h, l], i) => player(`opp${i}`, h, l)),
  ];
}

function match(rounds: RoundSnapshot[]): MatchSnapshot {
  return { pseudoMatchId: 'test', setId: 'set17', gameMode: 'tft', rounds } as MatchSnapshot;
}

describe('ordinal', () => {
  it('handles the teens, which are the ones that break naive suffix rules', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
  });
});

describe('standingFor', () => {
  it('excludes eliminated players from every comparison', () => {
    // Three corpses at 0 HP would otherwise drag the median down and make a
    // struggling player look like they are ahead of the table.
    const s = standingFor(round('4-1', lobby([40, 7], [[60, 8], [80, 8], [0, 6], [0, 5], [0, 4]])))!;
    expect(s.alive).toBe(3);
    expect(s.opponents).toBe(2);
    expect(s.medianOpponentHealth).toBe(70);
  });

  it('gives tied players the better shared rank', () => {
    // Everyone level 7: nobody is "behind" anyone.
    const s = standingFor(round('4-1', lobby([50, 7], [[50, 7], [50, 7], [50, 7]])))!;
    expect(s.levelRank).toBe(1);
    expect(s.opponentsAhead).toBe(0);
  });

  it('returns undefined when there is nothing real to compare against', () => {
    expect(standingFor(round('4-1'))).toBeUndefined();                       // no roster yet
    expect(standingFor(round('4-1', []))).toBeUndefined();                   // empty roster
    expect(standingFor(round('4-1', lobby([50, 7], [[0, 8]])))).toBeUndefined(); // last opponent dead
  });
});

describe('lobbyClause', () => {
  it('stays silent about a level lead that does not exist', () => {
    // Level-tied with the whole table is the normal state of an early lobby.
    expect(lobbyClause(round('3-1', lobby([90, 5], [[90, 5], [90, 5], [90, 5]])), 'level')).toBe('');
  });

  it('reports a real level deficit with the actual standing', () => {
    const clause = lobbyClause(round('4-1', lobby([50, 6], [[60, 8], [70, 8], [80, 7]])), 'level');
    expect(clause).toContain('3 of the 3 opponents still alive were ahead of you on level');
    expect(clause).toContain('highest was 8');
    expect(clause).toContain('4th of 4');
  });

  it('reports HP against the living median', () => {
    const clause = lobbyClause(round('4-1', lobby([20, 7], [[60, 7], [80, 7], [90, 7]])), 'hp');
    expect(clause).toContain('20 HP put you 4th of the 4 players still alive');
    expect(clause).toContain('median of 80');
  });
});

describe('LOBBY_001 — level behind the lobby', () => {
  it('fires when the table has levelled past a player who is also losing HP', () => {
    const points = checkLobby(match([round('4-1', lobby([40, 6], [[70, 8], [80, 8], [60, 7]]))]));
    const p = points.find(x => x.ruleId === 'LOBBY_001');
    expect(p).toBeDefined();
    expect(p!.observed).toContain('Level 6 at 4-1');
  });

  it('does NOT fire when the player is behind on level but ahead on HP', () => {
    // The winning econ/reroll shape: skipping levels to bank gold and health.
    // tests/goldens/2026-07-04-rank-1.jsonl is a real first-place finish that
    // sat 7th of 8 on level at 4-1 and 5-1 while holding above-median HP.
    const points = checkLobby(match([round('4-1', lobby([80, 6], [[50, 8], [60, 8], [70, 8]]))]));
    expect(points.filter(x => x.ruleId === 'LOBBY_001')).toEqual([]);
  });

  it('needs a strict majority of the table ahead, not just someone', () => {
    const points = checkLobby(match([round('4-1', lobby([40, 7], [[70, 8], [80, 7], [60, 7]]))]));
    expect(points.filter(x => x.ruleId === 'LOBBY_001')).toEqual([]);
  });

  it('goes quiet once the lobby is too thinned out to read a tempo from', () => {
    const points = checkLobby(match([round('5-1', lobby([20, 7], [[60, 9], [70, 9]]))]));
    expect(points.filter(x => x.ruleId === 'LOBBY_001')).toEqual([]);
  });
});

describe('LOBBY_002 — health behind the lobby', () => {
  it('fires early, where no absolute HP rule looks', () => {
    const points = checkLobby(match([round('3-1', lobby([60, 5], [[90, 5], [95, 5], [88, 5]]))]));
    const p = points.find(x => x.ruleId === 'LOBBY_002');
    expect(p).toBeDefined();
    expect(p!.observed).toContain('30 below the lobby median of 90');
  });

  it('ignores a bottom placing that is only a few HP off the table', () => {
    const points = checkLobby(match([round('3-1', lobby([85, 5], [[90, 5], [95, 5], [88, 5]]))]));
    expect(points.filter(x => x.ruleId === 'LOBBY_002')).toEqual([]);
  });

  it('does not double up on stage 4/5, where HP_002 and HP_003 already judge', () => {
    const low = lobby([20, 7], [[90, 8], [95, 8], [88, 8]]);
    const points = checkLobby(match([round('4-1', low), round('5-1', low)]));
    expect(points.filter(x => x.ruleId === 'LOBBY_002')).toEqual([]);
  });
});

// Golden ledgers are never committed (they carry other players' Riot IDs), so
// a fresh clone has none — skip rather than fail, as coach.regression does.
const LOBBY_GOLDEN = path.resolve(__dirname, 'goldens/2026-07-04-rank-6.jsonl');

describe.skipIf(!existsSync(LOBBY_GOLDEN))('lobby capture, end to end', () => {
  it('populates a roster for every round of a real match', async () => {
    const { snapshot } = await replayLedger(LOBBY_GOLDEN);
    const withLobby = snapshot.rounds.filter(r => r.lobby?.length);
    expect(withLobby.length).toBe(snapshot.rounds.length);

    // Eight players, exactly one of them flagged as us.
    const first = withLobby[0].lobby!;
    expect(first.length).toBe(8);
    expect(first.filter(p => p.isLocal).length).toBe(1);
  }, 60000);

  it('reads the roster xp field as the player level it actually is', async () => {
    // GEP calls it "xp" but it tracks me.xp.level round for round. If this ever
    // regresses to real experience points, every lobby level comparison silently
    // becomes nonsense — so it is asserted against the round's own level.
    const { snapshot } = await replayLedger(LOBBY_GOLDEN);
    const mismatches = snapshot.rounds
      .filter(r => r.lobby?.some(p => p.isLocal))
      .filter(r => r.lobby!.find(p => p.isLocal)!.level !== r.level)
      .map(r => r.label);

    // Allowed to differ only where the roster update lands across a level buy
    // within the same round window; a systematic break would fail this outright.
    expect(mismatches.length).toBeLessThanOrEqual(2);
  }, 60000);
});
