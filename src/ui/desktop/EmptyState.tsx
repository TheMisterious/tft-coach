import React, { useEffect, useRef } from 'react';
import { useHotkeyBinding } from '../useHotkeyBinding';
import styles from './EmptyState.module.css';

const INTRO_SEEN_KEY = 'tft:intro-seen';

interface Props {
  // true once the user has at least one match in history — same messaging as
  // the true first-run state, just a slightly different headline.
  hasHistory: boolean;
}

export function EmptyState({ hasHistory }: Props) {
  const binding = useHotkeyBinding();
  // Read once per mount so the longer explainer doesn't flicker away mid-view
  // the moment the "seen" flag gets persisted below.
  const hasSeenIntro = useRef(localStorage.getItem(INTRO_SEEN_KEY) === 'true').current;

  useEffect(() => {
    localStorage.setItem(INTRO_SEEN_KEY, 'true');
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.title}>
        {hasHistory ? 'No match selected' : 'Welcome to coachv'}
      </div>
      {!hasSeenIntro && !hasHistory && (
        <div className={styles.subtext}>
          Everything runs locally — no live scouting, no opponent tracking, just
          a report once your match is over.
        </div>
      )}
      <div className={styles.steps}>
        <div className={styles.step}>
          <span className={styles.stepNum}>1</span>
          <span>Play a round of TFT with Overwolf running</span>
        </div>
        <div className={styles.step}>
          <span className={styles.stepNum}>2</span>
          <span>We watch your match locally — nothing sent anywhere</span>
        </div>
        <div className={styles.step}>
          <span className={styles.stepNum}>3</span>
          <span>
            Press <span className={styles.hotkey}>{binding ?? '(hotkey not set)'}</span> after it ends for your report
          </span>
        </div>
      </div>
      {hasHistory && (
        <div className={styles.subtext}>Pick a past match from the sidebar, or finish a new one.</div>
      )}
    </div>
  );
}
