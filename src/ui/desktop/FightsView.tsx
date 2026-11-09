// Every player fight of the match (src/coach/fights.ts): result and HP, your
// board against the board you met, and the unit that did most of each side's
// damage. The opponent's board shows only when GEP sent all of it that round.

import React from 'react';
import type { BoardRead, DamageLead, FightRow } from '../../shared/types';
import styles from './FightsView.module.css';

function board(b: BoardRead): string {
  const stars = [b.threeStars ? `${b.threeStars}×3★` : '', b.twoStars ? `${b.twoStars}×2★` : ''].filter(Boolean).join(' ');
  return `${b.value}g${stars ? ` · ${stars}` : ''} · ${b.items} item${b.items === 1 ? '' : 's'}`;
}

function lead(l?: DamageLead): string {
  if (!l) return '—';
  return `${l.stars ? `${l.stars}★ ` : ''}${l.name} ${Math.round(l.share * 100)}%`;
}

export function FightsView({ fights }: { fights: FightRow[] }) {
  const losses = fights.filter(f => f.result === 'loss').length;
  return (
    <details className={styles.root} open>
      <summary className={styles.title}>Every fight ({fights.length}, {losses} lost)</summary>
      <p className={styles.hint}>
        Board value is the gold your units are worth (cost × copies). Top unit is the one that dealt the
        most of that side's damage. Their board shows only when the game sent all of it.
      </p>
      <div className={styles.tableBox}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Round</th><th>Result</th><th>Your board</th><th>Their board</th><th>Your top unit</th><th>Their top unit</th>
            </tr>
          </thead>
          <tbody>
            {fights.map(f => (
              <tr key={f.round} className={f.result === 'loss' ? styles.loss : styles.win}>
                <td className={styles.num}>{f.round}</td>
                <td className={styles.num}>
                  {f.result === 'loss' ? 'Lost' : 'Won'} <span className={styles.hp}>{f.hpBefore}→{f.hpAfter}</span>
                </td>
                <td>{board(f.own)}</td>
                <td className={f.opp && (f.opp.value >= f.own.value * 1.2 || f.opp.items >= f.own.items + 2) ? styles.stronger : ''}>
                  {f.opp ? board(f.opp) : '—'}
                </td>
                <td>{lead(f.ownLead)}</td>
                <td title={f.oppLead?.items.join(', ') || undefined}>{lead(f.oppLead)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
