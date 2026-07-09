import type { BoardState, Cell, MetaData } from '../shared/types';

// Normalizes a board/bench/opponent-board GEP payload into a BoardState.
//
// CORRECTED (2026-07-03, verified against a real ledger — tests/goldens/2026-07-03-rank-5.jsonl):
// board_pieces/bench_pieces/opponent_board_pieces are FULL current-state
// snapshots re-sent whenever the board changes, NOT incremental diffs as
// previously assumed. Evidence: a real cell (Veigar, cell_4) appeared once
// then permanently vanished from every later board_pieces update with no
// explicit null/removal — under the old union-merge behavior that meant it
// silently stayed on the board forever. Consecutive late-game updates also
// resend the SAME ~10 cells each time with only one field changed (an item
// added to one cell), which is exactly the signature of "full snapshot
// resent on change," not a partial diff. The old merge-based code produced a
// fictitious 19 "units" by round 5-1 in that match when the true final board
// only had 10 — this function replaces the board outright on every update
// instead of unioning it with whatever came before.
export function normalizeBoardSnapshot(
  update: Record<string, Partial<Cell> | null>
): BoardState {
  const next: BoardState = {};
  for (const [cellId, cell] of Object.entries(update)) {
    if (!cell || !cell.name) continue;
    next[cellId] = {
      name:   cell.name,
      level:  Number(cell.level ?? 1), // GEP sends level as a numeric string (e.g. "1")
      item_1: cell.item_1 || '0',
      item_2: cell.item_2 || '0',
      item_3: cell.item_3 || '0',
    };
  }
  return next;
}

// Spell-effect/pet tokens (e.g. Shen's clone "TFT17_ShenProp", a generic
// "TFT17_Summon") get tracked in board_pieces/opponent_board_pieces just like
// real units but aren't champions — exclude them from every board reader.
export function isNonChampionToken(name: string): boolean {
  return /_Summon$|_Prop$|_Clone$/.test(name);
}

// Extract champion IDs present on a board (excluding empty/undefined cells).
export function boardChampionIds(board: BoardState): string[] {
  return Object.values(board)
    .filter(c => c?.name && c.name !== '0' && !isNonChampionToken(c.name))
    .map(c => c.name);
}

// Returns all item IDs equipped on a board (excluding "0" empty slots).
export function boardItemIds(board: BoardState): string[] {
  return Object.values(board).flatMap(c =>
    [c.item_1, c.item_2, c.item_3].filter(i => i && i !== '0')
  );
}

function itemCount(c: Cell): number {
  return [c.item_1, c.item_2, c.item_3].filter(i => i && i !== '0').length;
}

// Identifies "the carry" among a set of board units for itemization/roll
// checks. Prefers a unit whose curated role is 'carry' — falls back to the
// old "most-starred, then most items" heuristic only when no unit on board
// has curated role data saying otherwise (a real gap: most of the Set 17
// roster is still placeholder role:'flex' — see champions.json). Without
// this, a flex/bruiser unit that happens to 3-star with items (e.g. a
// jungler snowballing off PvE rounds) gets mistaken for the actual carry,
// and the real carry's itemization mistakes go silently unevaluated.
export function identifyCarry(units: Cell[], meta: MetaData): Cell {
  const taggedCarries = units.filter(u => meta.champions?.[u.name]?.role === 'carry');
  const pool = taggedCarries.length > 0 ? taggedCarries : units;
  return pool.reduce((best, u) => {
    const uItems = itemCount(u);
    const bItems = itemCount(best);
    if (u.level > best.level) return u;
    if (u.level === best.level && uItems > bItems) return u;
    return best;
  });
}
