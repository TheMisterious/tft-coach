import React from 'react';
import type { MatchPlan } from '../../shared/types';
import styles from './GamePlanSummary.module.css';

const ECON_STYLE_LABEL: Record<MatchPlan['econStyle'], string> = {
  standard: 'Standard',
  slow_roll: 'Slow-roll',
  reroll: 'Reroll',
  fast_tempo: 'Fast-tempo',
};

const TIMING_LABEL: Record<'ahead' | 'on_curve' | 'behind', string> = {
  ahead: 'ahead of curve',
  on_curve: 'on curve',
  behind: 'behind curve',
};

const TIMING_CLASS: Record<'ahead' | 'on_curve' | 'behind', string> = {
  ahead: styles.timingAhead,
  on_curve: styles.timingOnCurve,
  behind: styles.timingBehind,
};

// Sits above the per-round note list as the anchor those notes hang off of —
// the one section that describes what the player was trying to do across the
// WHOLE match, not just a single round. See src/coach/plan-builder.ts.
export function GamePlanSummary({ plan }: { plan: MatchPlan }) {
  return (
    <section className={styles.root}>
      <div className={styles.title}>Game Plan</div>
      <p className={styles.headline}>{plan.headline}</p>

      <div className={styles.row}>
        {plan.finalTraits.length > 0 && (
          <div className={styles.group}>
            <span className={styles.groupLabel}>Comp</span>
            <div className={styles.pillRow}>
              {plan.finalTraits.map(t => (
                <span key={t} className={styles.traitPill}>{t}</span>
              ))}
            </div>
          </div>
        )}

        <div className={styles.group}>
          <span className={styles.groupLabel}>Economy</span>
          <span className={styles.econPill}>{ECON_STYLE_LABEL[plan.econStyle]}</span>
        </div>

        {(plan.level8Timing || plan.level9Timing) && (
          <div className={styles.group}>
            <span className={styles.groupLabel}>Leveling</span>
            <div className={styles.pillRow}>
              {plan.level8Timing && (
                <span className={`${styles.timingPill} ${TIMING_CLASS[plan.level8Timing]}`}>
                  Level 8 — {TIMING_LABEL[plan.level8Timing]}
                </span>
              )}
              {plan.level9Timing && (
                <span className={`${styles.timingPill} ${TIMING_CLASS[plan.level9Timing]}`}>
                  Level 9 — {TIMING_LABEL[plan.level9Timing]}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {plan.pivots.length > 0 && (
        <div className={styles.pivots}>
          <span className={styles.groupLabel}>Pivots</span>
          <ul className={styles.pivotList}>
            {plan.pivots.map((p, i) => (
              <li key={i}>
                <span className={styles.pivotRound}>{p.round}</span>
                {' — '}
                {(p.from.join('/') || 'no traits')} {'->'} {(p.to.join('/') || 'no traits')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.metaContext && (
        <div className={styles.metaContext}>
          <span className={styles.groupLabel}>Current meta</span>
          {plan.metaContext.compStanding && (
            <p className={styles.metaLine}>
              For reference, this trait combo has averaged {plan.metaContext.compStanding.avgPlacement.toFixed(1)} place
              across {plan.metaContext.compStanding.samples} recent high-elo games.
            </p>
          )}
          {plan.metaContext.missedChampion && (
            <p className={styles.metaLine}>
              You were offered {plan.metaContext.missedChampion.name} {plan.metaContext.missedChampion.offeredCount} time(s)
              and never picked it up — boards with {plan.metaContext.missedChampion.name} have averaged{' '}
              {plan.metaContext.missedChampion.avgPlacement.toFixed(1)} place recently.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
