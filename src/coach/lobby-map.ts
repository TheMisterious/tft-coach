// The lobby as a whole, across the match.
//
// Every checker judges the player's own state, and lobby-context.ts ranks
// them against the roster's HP and level for one round. This reads the other
// seven players as people with games of their own: where each one's HP and
// level went, which fights they won (round_outcome names every player, not
// only you), the boards of theirs the recording holds (sent when you fought
// them), which of your committed units they were fielding, and whether you
// looked at their board before a fight.
//
// Facts only. "Contested" means a unit of your committed comp was on their
// board when GEP sent it; it does not say who should pivot. The decision
// windows (decision-windows.ts) and the contest rules read this.

import type {
  MatchSnapshot, MetaData, RoundSnapshot, LobbyPlayerState, BoardState,
  LobbyRead, OpponentRead, OpponentBoardSeen, LobbyCheckpoint, LobbyScouting,
} from '../shared/types';
import { boardUnits } from '../ledger/merge';
import { computeActiveComp } from './match-context';
import { standingFor } from './lobby-context';
import { readBoard, isComponent, stageOf } from './fights';
import { getChampionName, isNonItemId, unitPrevalence } from '../enrichment/meta-lookup';

const CHECKPOINTS = ['3-1', '4-1', '5-1'];
// Wins over this many recorded player rounds decide who is leading the lobby.
const LEADER_WINDOW = 3;
const LEADERS_SHOWN = 2;
// A partial opponent board (one unit sent at 5-1) is not the board they
// fought with — same guard as fights.ts.
const MIN_BOARD_UNITS = 3;

function roundNumber(label: string): number {
  const [s, r] = label.split('-').map(Number);
  return (s || 0) * 100 + (r || 0);
}

function hpBefore(match: MatchSnapshot, i: number): number {
  return i > 0 ? match.rounds[i - 1].health : 100;
}

function lostFight(match: MatchSnapshot, i: number): boolean {
  const r = match.rounds[i];
  if (r.outcome) return r.outcome === 'loss';
  return r.health < hpBefore(match, i);
}

// Active traits on a board, most units first, from the set's breakpoints.
function activeTraits(board: BoardState, meta: MetaData): string[] {
  const counts = new Map<string, number>();
  for (const u of boardUnits(board)) for (const t of meta.champions?.[u.name]?.traits ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const lowest = new Map((meta.traitBreakpoints ?? []).map(b => [b.trait, b.tiers[0]]));
  return [...counts]
    .filter(([t, n]) => lowest.has(t) && n >= (lowest.get(t) ?? Infinity))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

function boardSeen(round: RoundSnapshot, meta: MetaData): OpponentBoardSeen | undefined {
  if (!round.opponentBoardFresh) return undefined;
  const units = boardUnits(round.opponentBoard).filter(u => !meta.champions || Object.keys(meta.champions).length === 0 || meta.champions[u.name]);
  if (units.length < MIN_BOARD_UNITS) return undefined;
  const read = readBoard(round.opponentBoard, meta);
  const lead = round.battleStats?.opponent?.slice().sort((a, b) => b.totalDamage - a.totalDamage)[0];
  return {
    round: round.label,
    units: units.map(u => ({
      id: u.name,
      name: getChampionName(u.name, meta),
      stars: Math.min(Math.max(Number(u.level) || 1, 1), 3),
      items: [u.item_1, u.item_2, u.item_3].filter(i => i && i !== '0' && !isNonItemId(i, meta) && !isComponent(i, meta)).length,
    })),
    traits: activeTraits(round.opponentBoard, meta),
    value: read.value,
    items: read.items,
    ...(lead && lead.totalDamage > 0 ? { carry: getChampionName(lead.name, meta) } : {}),
  };
}

/**
 * The other players across the match, or undefined when the recording never
 * carried a roster (nothing to read them from).
 */
export function readLobby(match: MatchSnapshot, meta: MetaData): LobbyRead | undefined {
  if (!match.rounds.some(r => r.lobby?.length)) return undefined;

  // Your committed comp, champions only: summons (Elderwood's trees) sit on
  // boards like units and would otherwise read as contested.
  const known = meta.champions && Object.keys(meta.champions).length > 0 ? meta.champions : undefined;
  const committed = new Set([...computeActiveComp(match)].filter(id => !known || known[id]));
  const byName = new Map<string, OpponentRead>();
  const get = (name: string): OpponentRead => {
    let o = byName.get(name);
    if (!o) byName.set(name, o = { name, path: [], wins: 0, losses: 0, fights: [], contested: [], scoutedAt: [] });
    return o;
  };

  match.rounds.forEach((r, i) => {
    for (const p of r.lobby ?? []) {
      if (p.isLocal) continue;
      const o = get(p.name);
      o.path.push({ round: r.label, health: p.health, level: p.level });
      if ((p.health <= 0 || (p.rank ?? 0) > 0) && !o.eliminatedAt) o.eliminatedAt = r.label;
      if ((p.rank ?? 0) > 0) o.finalRank = p.rank;
    }
    for (const [name, result] of Object.entries(r.lobbyOutcomes ?? {})) {
      if (r.lobby?.find(p => p.name === name)?.isLocal) continue;
      const o = get(name);
      if (result === 'win') o.wins++; else o.losses++;
    }
    if (r.type === 'PVP' && r.opponentName && !r.lobby?.find(p => p.name === r.opponentName)?.isLocal) {
      const o = get(r.opponentName);
      o.fights.push({ round: r.label, result: lostFight(match, i) ? 'loss' : 'win', hpBefore: hpBefore(match, i), hpAfter: r.health });
      const seen = boardSeen(r, meta);
      if (seen) {
        o.lastBoard = seen;
        for (const u of boardUnits(r.opponentBoard)) {
          if (!committed.has(u.name)) continue;
          const stars = Math.min(Math.max(Number(u.level) || 1, 1), 3);
          const prev = o.contested.find(c => c.id === u.name);
          if (prev) prev.stars = Math.max(prev.stars, stars);
          else o.contested.push({ id: u.name, name: getChampionName(u.name, meta), stars, round: r.label });
        }
      }
    }
    for (const name of r.scouted ?? []) get(name).scoutedAt.push(r.label);
  });

  const opponents = [...byName.values()].sort((a, b) => {
    if (a.finalRank && b.finalRank) return a.finalRank - b.finalRank;
    if (a.finalRank) return 1;
    if (b.finalRank) return -1;
    const ha = a.path[a.path.length - 1]?.health ?? 0, hb = b.path[b.path.length - 1]?.health ?? 0;
    return hb - ha;
  });

  return {
    opponents,
    checkpoints: CHECKPOINTS.map(label => checkpoint(match, label, opponents, meta)).filter((c): c is LobbyCheckpoint => !!c),
    scouting: scouting(match),
  };
}

function checkpoint(match: MatchSnapshot, label: string, opponents: OpponentRead[], meta: MetaData): LobbyCheckpoint | undefined {
  const i = match.rounds.findIndex(r => r.label === label);
  if (i < 0) return undefined;
  const round = match.rounds[i];
  const s = standingFor(round);
  if (!s) return undefined;
  const me = round.lobby!.find(p => p.isLocal)!;
  const living = round.lobby!.filter(p => !p.isLocal && p.health > 0);
  const below = living.filter(p => p.health < me.health);
  const cut = roundNumber(label);

  // Wins in the last LEADER_WINDOW recorded player rounds at or before this one.
  const recent = match.rounds.slice(0, i + 1).filter(r => r.lobbyOutcomes).slice(-LEADER_WINDOW);
  const wins = new Map<string, number>();
  for (const r of recent) for (const [name, result] of Object.entries(r.lobbyOutcomes!)) {
    if (result === 'win' && living.some(p => p.name === name)) wins.set(name, (wins.get(name) ?? 0) + 1);
  }
  const best = Math.max(0, ...wins.values());
  const leaders = best > 0 ? [...wins].filter(([, n]) => n === best).map(([name]) => name).sort().slice(0, LEADERS_SHOWN) : [];

  const core = new Map<string, LobbyCheckpoint['contestedCore'][number]>();
  for (const o of opponents) for (const c of o.contested) {
    if (roundNumber(c.round) > cut) continue;
    const share = unitPrevalence(c.id, meta)?.share;
    const e = core.get(c.id) ?? { id: c.id, name: c.name, by: [], ...(share !== undefined ? { share } : {}) };
    if (!e.by.includes(o.name)) e.by.push(o.name);
    core.set(c.id, e);
  }

  return {
    round: label,
    alive: s.alive,
    hpRank: s.hpRank,
    levelRank: s.levelRank,
    playersBelow: below.length,
    ...(below.length > 0 ? { closestBelow: me.health - Math.max(...below.map(p => p.health)) } : {}),
    leaders,
    contestedCore: [...core.values()].sort((a, b) => b.by.length - a.by.length || a.name.localeCompare(b.name)),
  };
}

function scouting(match: MatchSnapshot): LobbyScouting | undefined {
  const withFeed = match.rounds.filter(r => r.type === 'PVP' && r.scouted !== undefined);
  if (withFeed.length === 0) return undefined;
  const boards = new Set<string>();
  const byStage: LobbyScouting['byStage'] = {};
  for (const r of withFeed) {
    const stage = String(stageOf(r.label));
    const s = byStage[stage] ?? (byStage[stage] = { rounds: 0, scouted: 0 });
    s.rounds++;
    if (r.scouted!.length > 0) s.scouted++;
    for (const name of r.scouted!) boards.add(name);
  }
  return {
    rounds: withFeed.length,
    scoutedRounds: withFeed.filter(r => r.scouted!.length > 0).length,
    boards: boards.size,
    byStage,
  };
}

/** Opponents you fought in stages 3 and 4 who fielded this unit, by name. */
export function holdersOf(lobby: LobbyRead, unitId: string, stages: number[] = [3, 4]): string[] {
  return lobby.opponents
    .filter(o => o.contested.some(c => c.id === unitId && stages.includes(stageOf(c.round))))
    .map(o => o.name);
}

export function livingAt(round: RoundSnapshot): LobbyPlayerState[] {
  return (round.lobby ?? []).filter(p => p.health > 0);
}
