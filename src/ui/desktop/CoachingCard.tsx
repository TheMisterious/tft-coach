import React from 'react';
import type { CoachingNote } from '../../shared/types';
import { HexBoardLegend } from './HexBoardLegend';
import styles from './CoachingCard.module.css';

interface Props {
  note: CoachingNote;
}

// The badge's hover text: the numbers behind it, and how far to trust them.
function evidenceTooltip(note: CoachingNote): string {
  const e = note.evidence!;
  const delta = e.placementDelta !== undefined ? `${e.placementDelta.toFixed(1)} places worse on average` : 'worse on average';
  const range = e.ci ? ` (95% range ${e.ci[0].toFixed(1)} to ${e.ci[1].toFixed(1)})` : '';
  const trust = e.status === 'confirmed'
    ? 'The link held up again on newer games it was not found on.'
    : 'Exploratory: not yet confirmed on games it was not found on.';
  return `In ${e.matches ?? '?'} audited games, games where this fired finished ${delta}${range}. ${trust} A link with the result, not proof the flagged play caused it.`;
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
        {note.evidence?.verdict === 'predictive' && (
          <span className={styles.evidence} title={evidenceTooltip(note)}>
            {note.evidence.status === 'confirmed' ? 'confirmed link' : 'exploratory'}
          </span>
        )}
        {note.tier && <span className={styles.tier}>{note.tier}</span>}
      </div>
      <h3 className={styles.cardTitle}>{note.what_happened}</h3>
      {note.contributing && (
        <div className={styles.contributing}>
          <span className={styles.contributingLabel}>
            Likely contributing decisions · {note.contributing.window}
          </span>
          <ul className={styles.contributingList}>
            {note.contributing.observations.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
          <span className={styles.contributingHint}>
            What happened in your game, not a verdict: the coach cannot see every option you had.
          </span>
        </div>
      )}
      <p className={styles.recommendation}>
        <strong>Consider:</strong> {note.what_should_have_happened}
      </p>
      <p className={styles.why}>{note.why}</p>
      {note.category === 'positioning' && (
        <HexBoardLegend
          hexPosition={note.references?.hexPosition}
          boardSnapshot={note.references?.boardSnapshot}
          recommendedPosition={note.references?.recommendedPosition}
          moveUnitName={note.references?.moveUnitName}
        />
      )}
    </article>
  );
}
