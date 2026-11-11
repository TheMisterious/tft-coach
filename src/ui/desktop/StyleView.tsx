// "Your usual game": averages over the player's recent recorded matches
// (src/profile/style.ts) and where this match differed from them
// (src/coach/style-context.ts). Averages of what was done, not a verdict.

import React from 'react';
import type { StyleRead } from '../../shared/types';
import styles from './StyleView.module.css';

export function StyleView({ style }: { style: StyleRead }) {
  return (
    <section className={styles.root}>
      <div className={styles.title}>Your usual game</div>
      <p className={styles.hint}>
        From your last {style.sampleSize} recorded matches: averages of what you did, not a verdict on it.
        The second list is where this match sat away from your usual.
      </p>
      <ul className={styles.list}>
        {style.usual.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
      {style.thisGame.length > 0 && (
        <>
          <div className={styles.sub}>This match against your usual</div>
          <ul className={`${styles.list} ${styles.diff}`}>
            {style.thisGame.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}
