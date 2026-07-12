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
// This is approximate, not verified against Riot/Overwolf documentation.
//
// Row-0 orientation confirmed (2026-07-08) via a real match + direct user
// report: own-side row 0 (lowest local cell ids, 1-7) is the row closest to
// the PLAYER'S OWN edge — i.e. back line — not the row closest to the
// midline as originally assumed. Cross-checked against real ledger data:
// tanks (Maokai, RekSai) landed in what the old code called "row 3/back";
// carries (Jinx, Kindred) landed in "row 0/front" — backwards.
//
// Opponent-side row 0 direction went through two wrong guesses before this
// one — both from reasoning about a single screenshot, neither checked
// against real data:
//  1. Originally assumed row 0 = opponent's front (nearest midline), on the
//     theory that the two sides' local numbering runs in opposite absolute
//     directions. Never verified.
//  2. "Fixed" 2026-07-11 to mirror the own-side inversion, after a
//     coaching-card screenshot showed an opponent Jinx labeled "front-left"
//     while rendered isolated in the far back corner — reasoned that this
//     looked like a normal backline-carry spot mislabeled "front." Also
//     never verified against real data, and wrong.
//  3. Reverted 2026-07-11, same day, after an actual data check: GEP's real
//     match_info.battle_stats (per-unit damage blocked — a genuine
//     frontline signal, since tanks parked in front absorb far more damage
//     than backline units) was cross-referenced against row for both sides
//     across all 19 real ledgers on disk. Own side (already confirmed
//     correct) calibrated the method: row 0 averaged 1904 blocked damage
//     vs row 3's 179 — front blocks much more, as expected. Applying the
//     same check to the opponent side under guess #2's inversion gave the
//     opposite of that pattern — row 0 averaged 339 blocked, row 3
//     averaged 2627, a clean monotonic gradient the wrong way round
//     (n=248-289 per row bucket). That means guess #2 was backwards and
//     guess #1's un-inverted formula (row 0 = opponent's front, nearest
//     midline) was correct all along — restored below. If either side's
//     orientation is ever in doubt again, this battle_stats cross-check is
//     the way to settle it: don't reason from a single screenshot.

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
  const localRow = Math.floor(local / HEX_COLS);
  const row = side === 'own' ? HEX_ROWS - 1 - localRow : localRow;
  return { side, row, col: local % HEX_COLS };
}

// Short human-readable label used in coaching text instead of a raw "cell_42" id.
export function describeHexPosition(pos: HexPosition): string {
  const rowLabel = pos.row < HEX_ROWS / 2 ? 'front' : 'back';
  const third    = HEX_COLS / 3;
  const colLabel = pos.col < third ? 'left' : pos.col >= HEX_COLS - third ? 'right' : 'center';
  return `${rowLabel}-${colLabel}`;
}
