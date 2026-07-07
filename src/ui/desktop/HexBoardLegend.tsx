import React from 'react';
import type { HexPosition, BoardSnapshot, BoardUnit } from '../../shared/types';
import styles from './HexBoardLegend.module.css';

// An illustrative hex-board reference diagram — both full boards (yours and the
// opponent's, 4x7 each), stacked as they'd meet in combat: opponent's board on
// top with its front line facing down, yours on the bottom with its front line
// facing up, separated by a gap for the midline. When the coaching note carries
// a resolved hexPosition (see shared/hex-grid.ts), the matching cell on the
// matching board is highlighted — this is a best-effort mapping of GEP's cell_N
// ids, not verified against official Overwolf/Riot documentation (none exists),
// so it's labeled "approximate" rather than presented as exact.
const HALF_ROWS  = 4;
const COLS       = 7;
const HEX_R      = 20;
const COL_SPACING = Math.sqrt(3) * HEX_R;
const ROW_SPACING = 1.5 * HEX_R;
const MIDLINE_GAP = HEX_R * 0.6; // EXTRA space between the boards' front rows, on top of normal ROW_SPACING
const PAD        = HEX_R + 4;

function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30); // pointy-top
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  return pts.join(' ');
}

interface Props {
  hexPosition?: HexPosition;
  boardSnapshot?: BoardSnapshot;
}

interface DiagramCell {
  cx: number;
  cy: number;
  side: 'own' | 'opponent';
  row: number;   // 0-3, local to that side (0 = front, matching shared/hex-grid.ts)
  col: number;   // 0-6
  isFront: boolean;
}

// Hex is small — show a short label (first word, truncated) with the full
// name available on hover via <title>.
function shortName(name: string): string {
  const first = name.split(' ')[0];
  return first.length > 7 ? `${first.slice(0, 6)}…` : first;
}

export function HexBoardLegend({ hexPosition, boardSnapshot }: Props) {
  const width = PAD * 2 + COL_SPACING * (COLS - 1) + COL_SPACING / 2;

  const unitByKey = new Map<string, BoardUnit>();
  for (const side of ['own', 'opponent'] as const) {
    for (const u of boardSnapshot?.[side] ?? []) {
      unitByKey.set(`${side}-${u.row}-${u.col}`, u);
    }
  }

  // Player's board starts one full ROW_SPACING plus the extra MIDLINE_GAP below
  // the opponent board's top — i.e. the two front rows are spaced further apart
  // than any other pair of adjacent rows, making the midline visually distinct.
  const ownTop = PAD + HALF_ROWS * ROW_SPACING + MIDLINE_GAP;
  const height = ownTop + (HALF_ROWS - 1) * ROW_SPACING + PAD + HEX_R;

  const cells: DiagramCell[] = [];

  // Opponent's board: rendered top-to-bottom as row 3 (back) .. row 0 (front),
  // so its front line sits just above the midline gap, facing the player.
  for (let row = 0; row < HALF_ROWS; row++) {
    const displayRow = HALF_ROWS - 1 - row;
    const offset = displayRow % 2 === 1 ? COL_SPACING / 2 : 0;
    for (let col = 0; col < COLS; col++) {
      cells.push({
        cx: PAD + offset + col * COL_SPACING,
        cy: PAD + displayRow * ROW_SPACING,
        side: 'opponent',
        row,
        col,
        isFront: row === 0 || row === 1,
      });
    }
  }

  // Player's board: row 0 (front) sits just below the midline gap, facing the
  // opponent; row 3 (back) is furthest down.
  for (let row = 0; row < HALF_ROWS; row++) {
    const offset = row % 2 === 1 ? COL_SPACING / 2 : 0;
    for (let col = 0; col < COLS; col++) {
      cells.push({
        cx: PAD + offset + col * COL_SPACING,
        cy: ownTop + row * ROW_SPACING,
        side: 'own',
        row,
        col,
        isFront: row === 0 || row === 1,
      });
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.sideLabel}>Opponent side</div>
      <svg viewBox={`0 0 ${width} ${height}`} className={styles.svg}>
        {cells.map((c, i) => {
          const isHighlighted =
            hexPosition?.side === c.side && hexPosition?.row === c.row && hexPosition?.col === c.col;
          const unit = unitByKey.get(`${c.side}-${c.row}-${c.col}`);
          const r = HEX_R - 2;
          const clipId = `hex-clip-${i}`;
          return (
            <g key={i}>
              <polygon
                points={hexPoints(c.cx, c.cy, r)}
                className={
                  isHighlighted
                    ? styles.highlightCell
                    : unit ? styles.occupiedCell
                    : c.isFront ? styles.frontCell : styles.backCell
                }
              />
              {unit?.icon && (
                <>
                  <clipPath id={clipId}>
                    <polygon points={hexPoints(c.cx, c.cy, r)} />
                  </clipPath>
                  <image
                    href={unit.icon.url}
                    x={c.cx - r}
                    y={c.cy - r}
                    width={2 * r}
                    height={2 * r}
                    clipPath={`url(#${clipId})`}
                    preserveAspectRatio="xMidYMid slice"
                  >
                    <title>{unit.name}</title>
                  </image>
                </>
              )}
              {unit && !unit.icon && (
                <text x={c.cx} y={c.cy + 3} className={styles.unitLabel}>
                  {shortName(unit.name)}
                  <title>{unit.name}</title>
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className={styles.sideLabel}>Your side</div>
      {hexPosition ? (
        <div className={styles.legendRow}>
          <span className={styles.swatch} style={{ background: '#f9a825' }} />
          <span>Approximate spot referenced above (Overwolf doesn't publish an exact hex layout)</span>
        </div>
      ) : (
        <div className={styles.legendRow}>
          <span className={styles.swatch} style={{ background: '#45475a' }} />
          <span>Front line (meets the enemy first)</span>
          <span className={styles.swatch} style={{ background: '#313244', marginLeft: 12 }} />
          <span>Back line (protected — carries go here)</span>
        </div>
      )}
    </div>
  );
}
