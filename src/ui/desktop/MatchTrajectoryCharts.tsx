import React from 'react';
import type { RoundTrajectoryPoint } from '../../shared/types';
import { TrajectoryChart } from './TrajectoryChart';
import styles from './MatchTrajectoryCharts.module.css';

// "Live standing" (me.rank) used to be charted here too, but GEP doesn't
// actually deliver it as a per-round signal — confirmed across 24 real
// ledgers, it fires only 1-3 times for the WHOLE match, the first firing is
// almost always a placeholder "0", and the real value typically lands right
// before match end. Same one-shot nature as me.placement, not a trajectory —
// charting it produced a flat line at 0 for the entire match. Removed rather
// than fixed: there's no per-round data to fix it with.
export function MatchTrajectoryCharts({ data }: { data: RoundTrajectoryPoint[] }) {
  if (data.length < 2) return null;

  return (
    <div className={styles.grid}>
      <TrajectoryChart data={data} accessor={p => p.hp} title="HP" color="#a6e3a1" />
      <TrajectoryChart data={data} accessor={p => p.gold} title="Gold" color="#f9e2af" suffix="g" />
      <TrajectoryChart data={data} accessor={p => p.level} title="Level" color="#89b4fa" />
      <TrajectoryChart data={data} accessor={p => p.rollGold} title="Roll spend" color="#cba6f7" suffix="g" />
    </div>
  );
}
