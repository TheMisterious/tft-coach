// Every player fight read on its own: your board against the board you met,
// and who did the damage on each side.
//
// The checkpoint rules say where a game stood (HP entering a stage, gold
// held). This says why fights were lost, from what the recording holds for
// each one: both boards with stars and items (the opponent's only when GEP
// sent it that round), and GEP's battle_stats, the damage each unit dealt.
// Facts only, as everywhere in the coach; src/coach/rule-network.ts turns
// patterns across fights into readings and principles.

import type { MatchSnapshot, MetaData, RoundSnapshot, BoardState, Cell, CombatUnitStats, BoardRead, DamageLead, FightRow } from '../shared/types';
import { boardUnits } from '../ledger/merge';
import { getItemData, isNonItemId, getChampionName, getItemName } from '../enrichment/meta-lookup';

export interface Fight extends FightRow {
  // Each of your units' share of your damage, by champion id.
  ownShares: Record<string, number>;
}

const COPIES = [0, 1, 3, 9];

export function stageOf(label: string): number {
  return Number(label.split('-')[0]) || 0;
}

function itemIds(cell: Cell): string[] {
  return [cell.item_1, cell.item_2, cell.item_3].filter(i => i && i !== '0');
}

export function isComponent(itemId: string, meta: MetaData): boolean {
  const data = getItemData(itemId, meta);
  if (data) return data.isComponent;
  return /Component/i.test(itemId);
}

// Summons (Elderwood's trees, for one) sit on the board like units but are
// not champions you bought; with the set's champion list loaded, only its
// champions count.
function champions(board: BoardState, meta: MetaData): Cell[] {
  const known = meta.champions && Object.keys(meta.champions).length > 0;
  return boardUnits(board).filter(u => !known || meta.champions[u.name]);
}

export function readBoard(board: BoardState, meta: MetaData): BoardRead {
  const units = champions(board, meta);
  let value = 0, twoStars = 0, threeStars = 0, items = 0, components = 0;
  for (const u of units) {
    const stars = Math.min(Math.max(Number(u.level) || 1, 1), 3);
    value += (meta.champions?.[u.name]?.tier ?? 1) * COPIES[stars];
    if (stars === 2) twoStars++;
    if (stars === 3) threeStars++;
    for (const id of itemIds(u)) {
      if (isNonItemId(id, meta)) continue;
      if (isComponent(id, meta)) components++; else items++;
    }
  }
  return { units: units.length, value, twoStars, threeStars, items, components };
}

function shares(stats: CombatUnitStats[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  const total = (stats ?? []).reduce((s, u) => s + Math.max(0, u.totalDamage), 0);
  if (total <= 0) return out;
  for (const u of stats ?? []) out[u.name] = (out[u.name] ?? 0) + Math.max(0, u.totalDamage) / total;
  return out;
}

function lead(stats: CombatUnitStats[] | undefined, board: BoardState | undefined, meta: MetaData): DamageLead | undefined {
  const s = shares(stats);
  const top = Object.entries(s).sort((a, b) => b[1] - a[1])[0];
  if (!top) return undefined;
  const cells = board ? boardUnits(board).filter(c => c.name === top[0]) : [];
  const cell = cells.sort((a, b) => Number(b.level) - Number(a.level))[0];
  return {
    unit: top[0],
    name: getChampionName(top[0], meta),
    stars: cell ? Number(cell.level) || 1 : 0,
    share: top[1],
    items: cell ? itemIds(cell).filter(id => !isNonItemId(id, meta)).map(id => getItemName(id, meta)) : [],
  };
}

function hpBefore(match: MatchSnapshot, round: RoundSnapshot): number {
  const i = match.rounds.indexOf(round);
  return i > 0 ? match.rounds[i - 1].health : 100;
}

export function readFights(match: MatchSnapshot, meta: MetaData): Fight[] {
  return match.rounds.filter(r => r.type === 'PVP').map(r => {
    const before = hpBefore(match, r);
    const result: 'win' | 'loss' = r.outcome ? (r.outcome === 'loss' ? 'loss' : 'win') : (r.health < before ? 'loss' : 'win');
    const own = readBoard(r.board, meta);
    // GEP sometimes sends part of a board (one unit at 5-1 against a full
    // board of yours); a board that small is not the one you fought.
    const oppSeen = r.opponentBoardFresh ? r.opponentBoard : undefined;
    const oppRead = oppSeen ? readBoard(oppSeen, meta) : undefined;
    const oppBoard = oppRead && oppRead.units >= Math.max(3, own.units - 3) ? oppSeen : undefined;
    return {
      round: r.label,
      stage: stageOf(r.label),
      result,
      hpBefore: before,
      hpAfter: r.health,
      opponent: r.opponentName,
      own,
      opp: oppBoard ? oppRead : undefined,
      ownLead: lead(r.battleStats?.own, r.board, meta),
      oppLead: lead(r.battleStats?.opponent, oppBoard, meta),
      ownShares: shares(r.battleStats?.own),
    };
  });
}

// "Their board was stronger" in terms a player can check: worth at least a
// fifth more, or at least two more finished items.
export function outclassed(f: Fight): boolean {
  if (!f.opp) return false;
  return f.opp.value >= f.own.value * 1.2 || f.opp.items >= f.own.items + 2;
}

export function describeBoard(b: BoardRead): string {
  const stars = [b.threeStars ? `${b.threeStars} three-star` : '', b.twoStars ? `${b.twoStars} two-star` : ''].filter(Boolean).join(', ');
  return `${b.units} units worth ${b.value}g${stars ? ` (${stars})` : ''}, ${b.items} finished item${b.items === 1 ? '' : 's'}`;
}

export function describeLead(l: DamageLead, side: 'your' | 'their'): string {
  const stars = l.stars ? `${l.stars}★ ` : '';
  const items = l.items.length ? ` (${l.items.join(', ')})` : '';
  return `${stars}${l.name}${items}, ${Math.round(l.share * 100)}% of ${side} damage`;
}
