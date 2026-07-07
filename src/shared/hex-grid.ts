// Best-effort mapping of Overwolf TFT GEP's cell_N indices (from board_pieces /
// opponent_board_pieces) to a (row, col) position on a 4-row x 7-col hex board.
//
// Overwolf does not publish an official index diagram. This mapping is inferred
// from observed cell ids: board_pieces examples fall in 0-27 (a 4x7=28 board),
// opponent_board_pieces examples fall in the 28-55 range — consistent with the
// opponent's board being the same 28-cell grid, offset by one board's worth of
// indices. Anything outside 0-55 (e.g. a Set 17 Realm of the Gods special hex)
// is treated as unmappable rather than guessed.
//
// This is approximate, not verified against Riot/Overwolf documentation — treat
// row 0 vs row 3 orientation as illustrative, not authoritative.

import type { HexPosition } from './types';

export const HEX_ROWS = 4;
export const HEX_COLS = 7;
const BOARD_SIZE = HEX_ROWS * HEX_COLS; // 28

export function resolveHexCell(rawCellId: string): HexPosition | null {
  const m = /^cell_(\d+)$/.exec(rawCellId);
  if (!m) return null;

  // Confirmed 1-indexed across all four real golden matches (rank-4, rank-4b,
  // rank-5, rank-6): board_pieces ids consistently run 1-28, opponent_board_pieces
  // consistently run 29-56 — cell_0 and cell_28-as-opponent-start never appear.
  // The previous 0-indexed assumption (0-27 / 28-55) both rejected the very real
  // and common cell_56 (bound check excluded it) and shifted every other cell's
  // row/col by one, with wraparound errors at each 7-column row boundary.
  const raw = Number(m[1]);
  if (raw < 1 || raw > BOARD_SIZE * 2) return null;

  const index = raw - 1;
  const side  = index < BOARD_SIZE ? 'own' : 'opponent';
  const local = side === 'own' ? index : index - BOARD_SIZE;
  return { side, row: Math.floor(local / HEX_COLS), col: local % HEX_COLS };
}

// Short human-readable label used in coaching text instead of a raw "cell_42" id.
export function describeHexPosition(pos: HexPosition): string {
  const rowLabel = pos.row < HEX_ROWS / 2 ? 'front' : 'back';
  const third    = HEX_COLS / 3;
  const colLabel = pos.col < third ? 'left' : pos.col >= HEX_COLS - third ? 'right' : 'center';
  return `${rowLabel}-${colLabel}`;
}
