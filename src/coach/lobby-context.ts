// Lobby-relative comparison helpers.
//
// Every checker in this project judges the player against a fixed constant —
// an interest bracket, a board-cost benchmark, a level-by-round target. Those
// constants are the same whether the player is 1st or 8th, and they say
// nothing about the seven people actually taking their HP. This module turns
// RoundSnapshot.lobby (GEP's roster.player_status, see src/ledger/rounds.ts)
// into the other half of that picture: where the player stood among the people
// they were really playing.
//
// Deliberately narrow. GEP exposes only health and level per opponent — not
// their gold, board, or items — so nothing here infers anything richer than
// those two facts. Eliminated players (health <= 0) are excluded from every
// comparison: being "above average level" in a lobby half full of corpses is
// not a fact worth telling anyone.

import type { RoundSnapshot, LobbyPlayerState } from '../shared/types';

export interface LobbyStanding {
  /** Players still alive, including the local player. */
  alive: number;
  /** Living opponents only (alive minus the local player). */
  opponents: number;
  /** 1 = best in the lobby on this metric; ties share the better rank. */
  levelRank: number;
  hpRank: number;
  level: number;
  health: number;
  /** Living opponents strictly ahead of the player on level. */
  opponentsAhead: number;
  /** Highest level among living opponents. */
  topOpponentLevel: number;
  medianOpponentLevel: number;
  medianOpponentHealth: number;
}

function living(lobby: LobbyPlayerState[]): LobbyPlayerState[] {
  return lobby.filter(p => p.health > 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Rank of `value` among `all`, highest-first, 1-indexed. Ties share the better
// rank (two players tied at the top are both rank 1), so a player is never told
// they are "behind" someone they are level with.
function rankDescending(value: number, all: number[]): number {
  return all.filter(v => v > value).length + 1;
}

/**
 * The local player's standing among living opponents for one round, or
 * undefined when the round has no usable roster data — either GEP hadn't sent
 * one yet, the local player's own entry is missing, or everyone else is
 * already dead (no one left to compare against).
 */
export function standingFor(round: RoundSnapshot): LobbyStanding | undefined {
  if (!round.lobby?.length) return undefined;

  const alive = living(round.lobby);
  const me = alive.find(p => p.isLocal);
  if (!me) return undefined;

  const opponents = alive.filter(p => !p.isLocal);
  if (opponents.length === 0) return undefined;

  const opponentLevels = opponents.map(p => p.level);
  const opponentHealth = opponents.map(p => p.health);

  return {
    alive:                alive.length,
    opponents:            opponents.length,
    levelRank:            rankDescending(me.level, alive.map(p => p.level)),
    hpRank:               rankDescending(me.health, alive.map(p => p.health)),
    level:                me.level,
    health:               me.health,
    opponentsAhead:       opponentLevels.filter(l => l > me.level).length,
    topOpponentLevel:     Math.max(...opponentLevels),
    medianOpponentLevel:  median(opponentLevels),
    medianOpponentHealth: median(opponentHealth),
  };
}

/** Ordinal for a 1-indexed rank: 1 -> "1st". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:  return `${n}st`;
    case 2:  return `${n}nd`;
    case 3:  return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * A short, purely factual sentence about where the player stood this round —
 * appended to an existing note's coaching_text so a benchmark comparison gains
 * the context of the actual lobby. Returns '' when there's nothing real to say,
 * so callers can concatenate unconditionally.
 *
 * `metric` picks which fact is relevant to the note being annotated: a level
 * note wants the level standing, an HP note wants the HP standing. Never both —
 * one appended sentence is context, two is a second paragraph nobody asked for.
 */
export function lobbyClause(round: RoundSnapshot, metric: 'level' | 'hp'): string {
  const standing = standingFor(round);
  if (!standing) return '';

  if (metric === 'level') {
    if (standing.opponentsAhead === 0) {
      // Being level-tied with everyone is the normal state of an early lobby
      // and says nothing; only a real lead is worth reporting.
      return standing.levelRank === 1 && standing.level > standing.medianOpponentLevel
        ? ` For the lobby: you were the highest level of the ${standing.alive} players still alive.`
        : '';
    }
    return ` For the lobby: ${standing.opponentsAhead} of the ${standing.opponents} opponents still alive were ahead of you on level` +
      `${standing.topOpponentLevel > standing.level ? ` (highest was ${standing.topOpponentLevel})` : ''}` +
      `, putting you ${ordinal(standing.levelRank)} of ${standing.alive}.`;
  }

  return ` For the lobby: ${standing.health} HP put you ${ordinal(standing.hpRank)} of the ${standing.alive} players still alive` +
    `, against a median of ${standing.medianOpponentHealth} among your living opponents.`;
}
