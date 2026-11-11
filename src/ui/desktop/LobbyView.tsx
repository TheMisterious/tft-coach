// "The lobby": the other seven players across the match
// (src/coach/lobby-map.ts). Where each one's HP went, your fights against
// them, the last board of theirs the game sent, and which of your committed
// units they were fielding. Opponents show by their in-game display name,
// which GEP anonymises to a little-legend skin for everyone but you.

import React from 'react';
import type { LobbyRead, OpponentRead, LobbyCheckpoint } from '../../shared/types';
import styles from './LobbyView.module.css';

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

// HP at each stage entry, then where they went out.
function hpPath(o: OpponentRead): string {
  const entries = o.path.filter(p => /^\d-1$/.test(p.round));
  const seen = new Set<string>();
  const parts = entries.filter(p => !seen.has(p.round) && seen.add(p.round)).map(p => `${p.round}: ${p.health}`);
  if (o.eliminatedAt) parts.push(`out ${o.eliminatedAt}`);
  return parts.join(' · ') || '—';
}

function fights(o: OpponentRead): string {
  if (o.fights.length === 0) return '—';
  const won = o.fights.filter(f => f.result === 'win').length;
  return `${won}–${o.fights.length - won} (${o.fights.map(f => `${f.round} ${f.result === 'win' ? 'W' : 'L'}`).join(', ')})`;
}

function board(o: OpponentRead): string {
  const b = o.lastBoard;
  if (!b) return '—';
  const traits = b.traits.slice(0, 3).join('/');
  return `${b.round}: ${b.value}g, ${b.items} item${b.items === 1 ? '' : 's'}${traits ? ` · ${traits}` : ''}${b.carry ? ` · ${b.carry} led` : ''}`;
}

function contested(o: OpponentRead): string {
  if (o.contested.length === 0) return '—';
  return o.contested.map(c => `${c.name}${c.stars > 1 ? ` ${c.stars}★` : ''}`).join(', ');
}

function Checkpoint({ c }: { c: LobbyCheckpoint }) {
  return (
    <div className={styles.checkpoint}>
      <span className={styles.cpRound}>{c.round}</span>
      <span>{ordinal(c.hpRank)} of {c.alive} on HP, {ordinal(c.levelRank)} on level</span>
      <span>{c.playersBelow} below you{c.closestBelow !== undefined ? ` (nearest ${c.closestBelow} HP under)` : ''}</span>
      {c.leaders.length > 0 && <span>Winning most: {c.leaders.join(', ')}</span>}
      {c.contestedCore.length > 0 && (
        <span>Contested: {c.contestedCore.map(u => `${u.name} (${u.by.length}${u.share !== undefined ? `, on ${Math.round(u.share * 100)}% of top boards` : ''})`).join(', ')}</span>
      )}
    </div>
  );
}

export function LobbyView({ lobby }: { lobby: LobbyRead }) {
  const s = lobby.scouting;
  return (
    <details className={styles.root} open>
      <summary className={styles.title}>The lobby</summary>
      <p className={styles.hint}>
        The other players across the match: HP at each stage entry, your fights against them, the last
        board of theirs the game sent, and which of your committed units they fielded. Opponents show
        under the display name the game gave them.
        {s && ` You looked at another board before the fight in ${s.scoutedRounds} of ${s.rounds} player rounds (${s.boards} distinct boards).`}
      </p>
      {lobby.checkpoints.length > 0 && (
        <div className={styles.checkpoints}>
          {lobby.checkpoints.map(c => <Checkpoint key={c.round} c={c} />)}
        </div>
      )}
      <div className={styles.tableBox}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Player</th><th>Finish</th><th>HP by stage</th><th>Fights vs you</th><th>Lobby W–L</th><th>Last board seen</th><th>Your units on it</th><th>Scouted</th>
            </tr>
          </thead>
          <tbody>
            {lobby.opponents.map(o => (
              <tr key={o.name} className={o.eliminatedAt ? styles.out : ''}>
                <td className={styles.name}>{o.name}</td>
                <td className={styles.num}>{o.finalRank ? ordinal(o.finalRank) : o.eliminatedAt ? 'out' : 'in'}</td>
                <td>{hpPath(o)}</td>
                <td>{fights(o)}</td>
                <td className={styles.num}>{o.wins + o.losses > 0 ? `${o.wins}–${o.losses}` : '—'}</td>
                <td>{board(o)}</td>
                <td>{contested(o)}</td>
                <td className={styles.num}>{o.scoutedAt.length ? `${o.scoutedAt.length}×` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
