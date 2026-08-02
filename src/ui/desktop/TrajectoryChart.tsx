import React from 'react';
import type { RoundTrajectoryPoint } from '../../shared/types';
import styles from './TrajectoryChart.module.css';

interface Props {
  data: RoundTrajectoryPoint[];
  accessor: (p: RoundTrajectoryPoint) => number | undefined;
  title: string;
  color: string;
  suffix?: string; // appended to axis value labels, e.g. "g" or " HP"
  // Vertical dashed lines marking a round of interest (e.g. a comp pivot) —
  // the only cross-round signal (src/coach/plan-builder.ts's MatchPlan)
  // this chart otherwise has no way to show.
  markers?: Array<{ round: string; label: string }>;
}

const WIDTH = 300;
const HEIGHT = 90;
const PAD_X = 4;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;

export function TrajectoryChart({ data, accessor, title, color, suffix = '', markers = [] }: Props) {
  const points = data
    .map(p => ({ round: p.round, value: accessor(p) }))
    .filter((p): p is { round: string; value: number } => p.value !== undefined);

  if (points.length < 2) return null;

  const values = points.map(p => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const innerWidth  = WIDTH - PAD_X * 2;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const coords = points.map((p, i) => ({
    x: PAD_X + (i / (points.length - 1)) * innerWidth,
    y: PAD_TOP + (1 - (p.value - min) / range) * innerHeight,
    ...p,
  }));

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const floorY = HEIGHT - PAD_BOTTOM;
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${floorY} L ${coords[0].x.toFixed(1)} ${floorY} Z`;

  const markerCoords = markers
    .map(m => ({ ...m, coord: coords.find(c => c.round === m.round) }))
    .filter((m): m is typeof m & { coord: NonNullable<typeof m.coord> } => !!m.coord);

  return (
    <div className={styles.root}>
      <div className={styles.title}>{title}</div>
      <div className={styles.chartRow}>
        <div className={styles.yAxis}>
          <span>{max}{suffix}</span>
          <span>{min}{suffix}</span>
        </div>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className={styles.svg}>
          <path d={areaPath} fill={color} opacity={0.12} stroke="none" />
          <path d={linePath} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {coords.map((c, i) => (
            <circle key={i} cx={c.x} cy={c.y} r={2} fill={color} />
          ))}
          {markerCoords.map((m, i) => (
            <line
              key={i}
              x1={m.coord.x} x2={m.coord.x}
              y1={PAD_TOP} y2={floorY}
              stroke="#f38ba8"
              strokeWidth={1}
              strokeDasharray="3,2"
              vectorEffect="non-scaling-stroke"
            >
              <title>{m.label}</title>
            </line>
          ))}
        </svg>
      </div>
      <div className={styles.xAxis}>
        <span>{points[0].round}</span>
        <span>{points[points.length - 1].round}</span>
      </div>
    </div>
  );
}
