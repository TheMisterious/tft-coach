// "Key decisions": the whole spot at each planning round
// (src/coach/decision-windows.ts): what the recording shows, what the player
// did, and the usual lines from there with their conditions. Lines are the
// usual answer from that spot, never a ruling on the choice made.

import React from 'react';
import type { DecisionWindow, DecisionWindowState } from '../../shared/types';
import styles from './DecisionWindowsView.module.css';

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function cells(s: DecisionWindowState): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  out.push(['HP in', `${s.hp}${s.lossesLeft !== undefined ? ` · about ${s.lossesLeft} loss${s.lossesLeft === 1 ? '' : 'es'} left` : ''}${s.hpRank && s.alive ? ` · ${ordinal(s.hpRank)} of ${s.alive}` : ''}`]);
  if (s.playersBelow !== undefined) out.push(['Below you', `${s.playersBelow} player${s.playersBelow === 1 ? '' : 's'}`]);
  out.push(['Gold', `${s.gold} in · ${s.goldEnd} out`]);
  out.push(['Level', `${s.level}${s.medianLevel !== undefined ? ` · lobby median ${s.medianLevel}` : ''}${s.levelRank && s.alive ? ` · ${ordinal(s.levelRank)} of ${s.alive}` : ''}`]);
  out.push(['Streak', s.streak]);
  out.push(['Board', s.board]);
  out.push(['Items', `${s.finishedItems} finished · ${s.looseComponents} unbuilt component${s.looseComponents === 1 ? '' : 's'}`]);
  if (s.pairs.length) out.push(['Pairs', s.pairs.join(', ')]);
  out.push(['Recent fights', s.recentFights]);
  if (s.contested.length) out.push(['Contested', s.contested.join('; ')]);
  return out;
}

export function DecisionWindowsView({ decisions }: { decisions: DecisionWindow[] }) {
  return (
    <section className={styles.root}>
      <div className={styles.title}>Key decisions</div>
      <p className={styles.hint}>
        The whole spot at each round where a plan is usually set, what you did there, and the usual
        lines from that spot with the condition each one needs. The recording cannot show what the next
        shop held, so these are the usual answers, not a ruling on yours.
      </p>
      <ol className={styles.timeline}>
        {decisions.map(d => (
          <li key={d.round} className={styles.window}>
            <div className={styles.head}>
              <span className={styles.round}>{d.round}</span>
              {d.title && <span className={styles.windowTitle}>{d.title}</span>}
            </div>
            <dl className={styles.state}>
              {cells(d.state).map(([k, v]) => (
                <div key={k} className={styles.cell}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <div className={styles.block}>
              <span className={styles.label}>What you did</span>
              <ul className={styles.list}>{d.did.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
            <div className={styles.block}>
              <span className={styles.label}>Usual lines from here</span>
              <ul className={styles.list}>{d.lines.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
