import React from 'react';
import type { RoundTrajectoryPoint } from '../../shared/types';
import { TrajectoryChart } from './TrajectoryChart';
import styles from './MatchTrajectoryCharts.module.css';

export function MatchTrajectoryCharts({ data }: { data: RoundTrajectoryPoint[] }) {
  if (data.length < 2) return null;

  const hasLiveRank = data.some(p => p.liveRank !== undefined);

  return (
    <div className={styles.grid}>
      <TrajectoryChart data={data} accessor={p => p.hp} title="HP" color="#a6e3a1" />
      <TrajectoryChart data={data} accessor={p => p.gold} title="Gold" color="#f9e2af" suffix="g" />
      <TrajectoryChart data={data} accessor={p => p.level} title="Level" color="#89b4fa" />
      <TrajectoryChart data={data} accessor={p => p.rollGold} title="Roll spend" color="#cba6f7" suffix="g" />
      {hasLiveRank && (
        <TrajectoryChart data={data} accessor={p => p.liveRank} title="Live standing" color="#89dceb" />
      )}
    </div>
  );
}
