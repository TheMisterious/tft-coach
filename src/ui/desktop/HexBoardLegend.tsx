import React from 'react';
import type { HexPosition, BoardSnapshot, BoardUnit } from '../../shared/types';
import styles from './HexBoardLegend.module.css';

// An illustrative hex-board reference diagram — both full boards (yours and the
// opponent's, 4x7 each), stacked as they'd meet in combat: opponent's board on
// top with its front line facing down, yours on the bottom with its front line
// facing up, separated by a gap for the midline. This is a best-effort mapping
// of GEP's cell_N ids, not verified against official Overwolf/Riot
// documentation (none exists), so it's labeled "approximate" rather than
// presented as exact.
//
// When the checker provides recommendedPosition (a positioning fix — move
// something to this own-side cell) AND that unit is actually identifiable
// (moveUnitName resolves against boardSnapshot.own), the diagram renders as
// two plain panels, Before/After, instead of one: a single board with a
// highlighted target cell forced the reader to mentally diff "where things
// are" against "where they should be." Showing the actual resulting board
// side by side removes that step — no cell coloring needed, the icon moving
// IS the diff.
//
// Without a resolvable moveUnitName there's nothing to relocate — rendering
// two identical panels would silently show "no difference" and look broken.
// That case falls back to a single board with a dashed (unfilled) ring
// marking the destination, honest about "move something here, we don't know
// exactly what."
const HALF_ROWS  = 4;
const COLS       = 7;

interface Props {
  hexPosition?: HexPosition;
  boardSnapshot?: BoardSnapshot;
  recommendedPosition?: HexPosition;
  moveUnitName?: string;
}

interface DiagramCell {
  cx: number;
  cy: number;
  side: 'own' | 'opponent';
  row: number;   // 0-3, local to that side (0 = front, matching shared/hex-grid.ts)
  col: number;   // 0-6
  isFront: boolean;
}

interface Layout {
  hexR: number;
  width: number;
  height: number;
  cells: DiagramCell[];
}

// Hex is small — show a short label (first word, truncated) with the full
// name available on hover via <title>.
function shortName(name: string): string {
  const first = name.split(' ')[0];
  return first.length > 7 ? `${first.slice(0, 6)}…` : first;
}

function sameHex(a?: HexPosition, b?: { side: 'own' | 'opponent'; row: number; col: number }): boolean {
  return !!a && !!b && a.side === b.side && a.row === b.row && a.col === b.col;
}

function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30); // pointy-top
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  return pts.join(' ');
}

function buildLayout(hexR: number): Layout {
  const colSpacing  = Math.sqrt(3) * hexR;
  const rowSpacing   = 1.5 * hexR;
  const midlineGap   = hexR * 0.6; // EXTRA space between the boards' front rows, on top of normal rowSpacing
  const pad          = hexR + 4;

  const width  = pad * 2 + colSpacing * (COLS - 1) + colSpacing / 2;
  // Player's board starts one full rowSpacing plus the extra midlineGap below
  // the opponent board's top — i.e. the two front rows are spaced further
  // apart than any other pair of adjacent rows, making the midline distinct.
  const ownTop = pad + HALF_ROWS * rowSpacing + midlineGap;
  const height = ownTop + (HALF_ROWS - 1) * rowSpacing + pad + hexR;

  const cells: DiagramCell[] = [];

  // Opponent's board: rendered top-to-bottom as row 3 (back) .. row 0 (front),
  // so its front line sits just above the midline gap, facing the player.
  for (let row = 0; row < HALF_ROWS; row++) {
    const displayRow = HALF_ROWS - 1 - row;
    const offset = displayRow % 2 === 1 ? colSpacing / 2 : 0;
    for (let col = 0; col < COLS; col++) {
      cells.push({
        cx: pad + offset + col * colSpacing,
        cy: pad + displayRow * rowSpacing,
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
    const offset = row % 2 === 1 ? colSpacing / 2 : 0;
    for (let col = 0; col < COLS; col++) {
      cells.push({
        cx: pad + offset + col * colSpacing,
        cy: ownTop + row * rowSpacing,
        side: 'own',
        row,
        col,
        isFront: row === 0 || row === 1,
      });
    }
  }

  return { hexR, width, height, cells };
}

interface DiagramProps {
  layout: Layout;
  idPrefix: string;
  units: BoardUnit[];         // own + opponent, already positioned for THIS panel
  enemyPos?: HexPosition;     // orange — the threat being reacted to (single-board fallback only)
  destPos?: HexPosition;      // dashed ring, no fill — destination when no specific unit is named
}

function Diagram({ layout, idPrefix, units, enemyPos, destPos }: DiagramProps) {
  const { hexR, width, height, cells } = layout;
  const r = hexR - 2;

  const unitByKey = new Map<string, BoardUnit>();
  for (const u of units) unitByKey.set(`${u.side}-${u.row}-${u.col}`, u);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={styles.svg}>
      {cells.map((c, i) => {
        const isEnemyThreat = sameHex(enemyPos, c);
        const isDestination = sameHex(destPos, c);
        const unit = unitByKey.get(`${c.side}-${c.row}-${c.col}`);
        const clipId = `${idPrefix}-hex-clip-${i}`;
        return (
          <g key={i}>
            <polygon
              points={hexPoints(c.cx, c.cy, r)}
              className={
                isEnemyThreat ? styles.enemyCell
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
            {isEnemyThreat && (
              <polygon points={hexPoints(c.cx, c.cy, r - 2)} className={styles.threatRing} />
            )}
            {isDestination && (
              <polygon points={hexPoints(c.cx, c.cy, r - 2)} className={styles.destRing} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function HexBoardLegend({ hexPosition, boardSnapshot, recommendedPosition, moveUnitName }: Props) {
  const ownUnits = boardSnapshot?.own ?? [];
  const oppUnits = boardSnapshot?.opponent ?? [];
  const movingUnit = moveUnitName ? ownUnits.find(u => u.name === moveUnitName) : undefined;

  // Two-panel Before/After mode requires both a destination AND a resolvable
  // unit to move there — otherwise the After panel would be identical to
  // Before (nothing to relocate) and look like a rendering bug rather than
  // "we don't know exactly who should move."
  if (recommendedPosition && movingUnit) {
    const layout = buildLayout(15); // smaller radius — two panels share the card width

    const beforeUnits = [...ownUnits, ...oppUnits];
    // "After": relocate the moving unit to the destination, and drop whatever
    // was already sitting there (an unmodeled swap is better than two icons
    // stacked on one hex).
    const afterOwnUnits = ownUnits
      .filter(u => u.name === movingUnit.name || !sameHex(recommendedPosition, u))
      .map(u => u.name === movingUnit.name ? { ...u, ...recommendedPosition } : u);
    const afterUnits = [...afterOwnUnits, ...oppUnits];

    return (
      <div className={styles.root}>
        <div className={styles.diffRow}>
          <div className={styles.diffPanel}>
            <div className={styles.diffHeader}>Before</div>
            <Diagram layout={layout} idPrefix="before" units={beforeUnits} />
          </div>
          <div className={styles.diffPanel}>
            <div className={styles.diffHeader}>After</div>
            <Diagram layout={layout} idPrefix="after" units={afterUnits} />
          </div>
        </div>
      </div>
    );
  }

  // Fallback: single board. Either there's no destination at all (e.g.
  // POSITION_002's "add a tank" note), or there is one but no specific unit
  // could be named to move there — in the latter case a dashed ring marks
  // the destination instead of a two-panel diff with nothing to show moving.
  const layout = buildLayout(20);
  return (
    <div className={styles.root}>
      <div className={styles.sideLabel}>Opponent side</div>
      <Diagram
        layout={layout}
        idPrefix="single"
        units={[...ownUnits, ...oppUnits]}
        enemyPos={hexPosition}
        destPos={recommendedPosition}
      />
      <div className={styles.sideLabel}>Your side</div>
      <div className={styles.legendRow}>
        {hexPosition && (
          <>
            <span className={styles.swatch} style={{ background: '#f9a825' }} />
            <span>Opponent threat (approximate layout)</span>
          </>
        )}
        {recommendedPosition && (
          <>
            <span className={styles.ringSwatch} style={{ marginLeft: hexPosition ? 12 : 0 }} />
            <span>Move a unit here (no specific tank-role unit on this board to name)</span>
          </>
        )}
        {!hexPosition && !recommendedPosition && (
          <>
            <span className={styles.swatch} style={{ background: '#45475a' }} />
            <span>Front line (meets the enemy first)</span>
            <span className={styles.swatch} style={{ background: '#313244', marginLeft: 12 }} />
            <span>Back line (protected — carries go here)</span>
          </>
        )}
      </div>
    </div>
  );
}
