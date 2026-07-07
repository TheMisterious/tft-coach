import React from 'react';
import type { CoachingNote } from '../../shared/types';
import { HexBoardLegend } from './HexBoardLegend';
import styles from './CoachingCard.module.css';

interface Props {
  note: CoachingNote;
}

export function CoachingCard({ note }: Props) {
  return (
    <article className={`${styles.card} ${styles[`card-${note.severity}`]}`}>
      <div className={styles.cardHeader}>
        <span className={styles.round}>{note.round_label}</span>
        <span className={`${styles.badge} ${styles[`badge-${note.category}`]}`}>
          {note.category}
        </span>
        <span className={`${styles.badge} ${styles[`card-${note.severity}`]}`}>
          {note.severity}
        </span>
        {note.tier && <span className={styles.tier}>{note.tier}</span>}
      </div>
      <h3 className={styles.cardTitle}>{note.what_happened}</h3>
      <p className={styles.recommendation}>
        <strong>Should have:</strong> {note.what_should_have_happened}
      </p>
      <p className={styles.why}>{note.why}</p>
      {note.category === 'positioning' && (
        <HexBoardLegend
          hexPosition={note.references?.hexPosition}
          boardSnapshot={note.references?.boardSnapshot}
        />
      )}
    </article>
  );
}
