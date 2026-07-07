import type { BoardState, Cell } from '../shared/types';

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

// Extract champion IDs present on a board (excluding empty/undefined cells).
export function boardChampionIds(board: BoardState): string[] {
  return Object.values(board)
    .filter(c => c?.name && c.name !== '0')
    .map(c => c.name);
}

// Returns all item IDs equipped on a board (excluding "0" empty slots).
export function boardItemIds(board: BoardState): string[] {
  return Object.values(board).flatMap(c =>
    [c.item_1, c.item_2, c.item_3].filter(i => i && i !== '0')
  );
}
