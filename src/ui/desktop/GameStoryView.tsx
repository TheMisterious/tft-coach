// "How the game went": the match's findings traced through the rule network
// (src/coach/rule-network.ts), earliest first. Each step is either a decision
// the recorded play made against a principle, or a reading of where the game
// stood; the arrow under it names the later step it tends to lead to.

import React from 'react';
import type { GameStory } from '../../shared/types';
import styles from './GameStoryView.module.css';

export function GameStoryView({ story }: { story: GameStory }) {
  return (
    <section className={styles.root}>
      <div className={styles.title}>How the game went</div>
      <p className={styles.hint}>
        What the recording shows, in order, joined by how TFT&apos;s rules connect one step to the
        next. A link means the first makes the second more likely, not that it caused it here.
      </p>
      <ol className={styles.timeline}>
        {story.steps.map(step => (
          <li key={step.nodeId} className={`${styles.step} ${step.kind === 'decision' ? styles.decision : styles.reading}`}>
            <div className={styles.stepHead}>
              <span className={styles.rounds}>{step.rounds.join(', ')}</span>
              <span className={styles.kind}>{step.kind === 'decision' ? 'Decision' : 'Reading'}</span>
              <span className={styles.name}>{step.name}</span>
            </div>
            <ul className={styles.facts}>
              {step.facts.map((fact, i) => <li key={i}>{fact}</li>)}
            </ul>
            {step.advice && (
              <div className={styles.principle}>
                {step.kind === 'reading' && step.principle && (
                  <span className={styles.principleName}>{step.principle}. </span>
                )}
                <span>Usual answer: {step.advice}</span>
                {step.unless && <span className={styles.unless}> Unless: {step.unless}</span>}
              </div>
            )}
            <div className={styles.basis}>{step.basisLabel} · {step.evidence}</div>
            {step.ledTo.map(link => (
              <div key={link.nodeId} className={styles.link}>
                ↓ {link.why}
              </div>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
