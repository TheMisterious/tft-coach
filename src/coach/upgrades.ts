// What the player could have upgraded, from what the ledger actually shows.
//
// Shared by the decision trace (src/coach/decision-trace.ts) and the candidate
// rules that only judge a spend when it could have bought something (ECON_005,
// ROLL_006). Limits worth knowing before reading any count from here: GEP
// records the shop at the END of each round, not every roll, so "offered"
// undercounts; and a pair is two 1-star copies of one champion across board
// and bench — one copy from a 2-star.

import type { RoundSnapshot, MetaData, BoardState } from '../shared/types';

export interface HeldUnit { name: string; level: number }

// Board and bench also hold non-champions (TFT_ArmoryKeyComponent and other
// set tokens). With the set's champion table loaded, only its champions count;
// without one, nothing is filtered rather than guessed at.
function unitsIn(board: BoardState | undefined, meta?: MetaData): HeldUnit[] {
  const known = meta?.champions && Object.keys(meta.champions).length ? meta.champions : undefined;
  return Object.values(board ?? {})
    .filter(c => c?.name && c.name !== '0' && (!known || c.name in known))
    .map(c => ({ name: c.name, level: Number(c.level) || 1 }));
}

export function heldUnits(round: RoundSnapshot, meta?: MetaData): HeldUnit[] {
  return [...unitsIn(round.board, meta), ...unitsIn(round.bench, meta)];
}

/** Copies of units the player held, by champion id, in this round's end-of-round shop. */
export function upgradeCopiesOffered(round: RoundSnapshot, meta?: MetaData): Map<string, number> {
  const held = new Set(heldUnits(round, meta).map(u => u.name));
  const offered = new Map<string, number>();
  for (const id of round.shop) if (held.has(id)) offered.set(id, (offered.get(id) ?? 0) + 1);
  return offered;
}

/** Champion ids held as exactly two 1-star copies — one copy from a 2-star. */
export function pairsHeld(round: RoundSnapshot, meta?: MetaData): string[] {
  const oneStar = new Map<string, number>();
  for (const u of heldUnits(round, meta)) if (u.level === 1) oneStar.set(u.name, (oneStar.get(u.name) ?? 0) + 1);
  return [...oneStar.entries()].filter(([, n]) => n === 2).map(([id]) => id);
}

/** Something a roll could have turned into an upgrade this round: a held unit in the shop, or a pair. */
export function upgradeWasOnOffer(round: RoundSnapshot, meta?: MetaData): boolean {
  return upgradeCopiesOffered(round, meta).size > 0 || pairsHeld(round, meta).length > 0;
}
