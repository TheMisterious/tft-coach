import React, { useState, useMemo } from 'react';
import type { CoachingReport, CoachingNote, Severity, DecisionCategory, MatchSummary } from '../../shared/types';
import { ALL_CATEGORIES, CATEGORY_LABELS } from '../../coach/scoring';
import { CoachingCard } from './CoachingCard';
import { MatchTrajectoryCharts } from './MatchTrajectoryCharts';
import { EmptyState } from './EmptyState';
import styles from './CoachingReportView.module.css';

type CategoryFilter = DecisionCategory | 'all';

interface Props {
  report?:      CoachingReport;
  history:      MatchSummary[];
  onSelectMatch: (matchId: string) => void;
  activeMatchId?: string;
}

const SEVERITIES: Severity[] = ['critical', 'moderate', 'minor'];

export function CoachingReportView({ report, history, onSelectMatch, activeMatchId }: Props) {
  const [severityFilter, setSeverityFilter] = useState<Set<Severity>>(
    new Set(['critical', 'moderate', 'minor'])
  );

  function toggleSeverity(s: Severity) {
    setSeverityFilter(prev => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  }

  const filtered = useMemo(
    () => report?.notes.filter(n => severityFilter.has(n.severity)) ?? [],
    [report, severityFilter]
  );

  // Group by stage (first character before the hyphen in round_label).
  const byStage = useMemo(() => {
    const map = new Map<string, CoachingNote[]>();
    for (const note of filtered) {
      const stage = note.round_label.split('-')[0] ?? '?';
      if (!map.has(stage)) map.set(stage, []);
      map.get(stage)!.push(note);
    }
    return map;
  }, [filtered]);

  const placementClass = !report ? '' :
    report.overall_placement <= 4 ? styles.placementTop :
    report.overall_placement <= 6 ? styles.placementMid :
    styles.placementBot;

  return (
    <div className={styles.root}>
      {/* Sidebar — match history */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTitle}>Match History</div>
        {history.map(m => (
          <div
            key={m.pseudo_match_id}
            className={`${styles.matchRow} ${m.pseudo_match_id === activeMatchId ? styles.active : ''}`}
            onClick={() => onSelectMatch(m.pseudo_match_id)}
          >
            <span className={`${styles.placement} ${
              m.placement <= 4 ? styles.placementTop :
              m.placement <= 6 ? styles.placementMid : styles.placementBot
            }`}>
              #{m.placement}
            </span>
            <span className={styles.matchDate}>
              {new Date(m.date_played).toLocaleDateString()}
            </span>
          </div>
        ))}
      </aside>

      {/* Main panel */}
      <main className={styles.main}>
        {!report ? (
          <EmptyState hasHistory={history.length > 0} />
        ) : (
          <>
            {/* Header */}
            <header className={styles.header}>
              <div className={styles.headerTop}>
                <div className={`${styles.gradeCircle} ${styles[`grade-${report.overall_grade}`]}`}>
                  {report.overall_grade}
                </div>
                <span className={`${styles.placementLarge} ${placementClass}`}>
                  #{report.overall_placement}
                </span>
              </div>
              <p className={styles.tldr}>{report.tldr}</p>
              <div className={styles.categoryGrid}>
                {ALL_CATEGORIES.map(category => {
                  const grade = report.category_grades[category];
                  return (
                    <div key={category} className={styles.categoryTile} title={`${CATEGORY_LABELS[category]}: ${grade}`}>
                      <span className={`${styles.categoryBadge} ${styles[`grade-${grade}`]}`}>{grade}</span>
                      <span className={styles.categoryLabel}>{CATEGORY_LABELS[category]}</span>
                    </div>
                  );
                })}
              </div>
              {report.round_trajectory && <MatchTrajectoryCharts data={report.round_trajectory} />}
            </header>

            {/* Severity filter chips */}
            <div className={styles.filters}>
              {SEVERITIES.map(s => (
                <button
                  key={s}
                  className={`${styles.chip} ${styles[`chip${capitalize(s)}`]} ${
                    severityFilter.has(s) ? styles.active : styles.inactive
                  }`}
                  onClick={() => toggleSeverity(s)}
                >
                  {s}
                </button>
              ))}
            </div>

            {/* Stage sections */}
            {byStage.size === 0 && (
              <p style={{ color: '#6c7086', fontStyle: 'italic' }}>
                No notes match the current filter.
              </p>
            )}
            {[...byStage.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([stage, notes]) => (
              <section key={stage} className={styles.stageSection}>
                <div className={styles.stageTitle}>Stage {stage}</div>
                {notes.map((note, i) => (
                  <CoachingCard key={i} note={note} />
                ))}
              </section>
            ))}

            {/* Strengths */}
            {report.strengths.length > 0 && (
              <section className={styles.stageSection}>
                <div className={styles.stageTitle}>What You Did Well</div>
                <ul className={styles.strengthsList}>
                  {report.strengths.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </section>
            )}

            {/* Required Riot disclaimer */}
            <footer style={{ marginTop: 32, fontSize: 11, color: '#45475a', lineHeight: 1.5 }}>
              coachv isn&apos;t endorsed by Riot Games and doesn&apos;t reflect the views or
              opinions of Riot Games or anyone officially involved in producing or managing Riot
              Games properties. Riot Games, and all associated properties are trademarks or
              registered trademarks of Riot Games, Inc.
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
