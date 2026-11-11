import React, { useState, useMemo } from 'react';
import type { CoachingReport, CoachingNote, Severity, DecisionCategory, MatchSummary } from '../../shared/types';
import { ALL_CATEGORIES, CATEGORY_LABELS } from '../../coach/scoring';
import { CoachingCard } from './CoachingCard';
import { MatchTrajectoryCharts } from './MatchTrajectoryCharts';
import { GamePlanSummary } from './GamePlanSummary';
import { GameStoryView } from './GameStoryView';
import { FightsView } from './FightsView';
import { DecisionWindowsView } from './DecisionWindowsView';
import { LobbyView } from './LobbyView';
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

  // Absent on reports generated before the rule audit, which keep every note
  // in `notes`.
  const filteredOther = useMemo(
    () => report?.other_notes?.filter(n => severityFilter.has(n.severity)) ?? [],
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
                <div
                  className={`${styles.gradeCircle} ${styles[`grade-${report.overall_grade ?? 'none'}`]}`}
                  title={report.overall_grade ? undefined : 'Not graded — this match was only partly recorded'}
                >
                  {report.overall_grade ?? '—'}
                </div>
                <span className={`${styles.placementLarge} ${placementClass}`}>
                  #{report.overall_placement}
                </span>
              </div>
              {report.capture_notes && report.capture_notes.length > 0 && (
                <ul className={styles.captureNotes}>
                  {report.capture_notes.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              )}
              <p className={styles.tldr}>{report.tldr}</p>
              {report.priority_fix && (
                <div className={styles.priorityFix}>
                  <span className={styles.priorityFixLabel}>
                    Priority fix — {CATEGORY_LABELS[report.priority_fix.category]}
                    {report.priority_fix.occurrences > 1 && (
                      <span className={styles.priorityFixCount}> · {report.priority_fix.occurrences}× this match</span>
                    )}
                  </span>
                  <p className={styles.priorityFixAction}>{report.priority_fix.action}</p>
                  <p className={styles.priorityFixWhy}>{report.priority_fix.why}</p>
                  {report.priority_fix.patterns && report.priority_fix.patterns.length > 0 && (
                    <ul className={styles.priorityFixPatterns}>
                      {report.priority_fix.patterns.map((pattern, i) => (
                        <li key={i}>{pattern}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className={styles.categoryGrid}>
                {ALL_CATEGORIES.map(category => {
                  const grade = report.category_grades[category];
                  return (
                    <div
                      key={category}
                      className={`${styles.categoryTile} ${grade ? '' : styles.ungradedTile}`}
                      title={grade
                        ? `${CATEGORY_LABELS[category]}: ${grade}`
                        : report.ungraded_reasons?.[category] === 'unvalidated'
                          ? `${CATEGORY_LABELS[category]}: not graded — this grade has not yet been shown to match how games actually end. Its notes below still apply.`
                          : `${CATEGORY_LABELS[category]}: not graded — nothing in this match's recording to judge it on`}
                    >
                      <span className={`${styles.categoryBadge} ${styles[`grade-${grade ?? 'none'}`]}`}>{grade ?? '—'}</span>
                      <span className={styles.categoryLabel}>{CATEGORY_LABELS[category]}</span>
                    </div>
                  );
                })}
              </div>
              {report.round_trajectory && (
                <MatchTrajectoryCharts data={report.round_trajectory} pivots={report.plan.pivots} />
              )}
            </header>

            <GamePlanSummary plan={report.plan} />

            {report.game_story && <GameStoryView story={report.game_story} />}

            {report.decisions && report.decisions.length > 0 && <DecisionWindowsView decisions={report.decisions} />}

            {report.lobby && <LobbyView lobby={report.lobby} />}

            {report.fights && report.fights.length > 0 && <FightsView fights={report.fights} />}

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
                {report.other_notes && report.notes.length === 0
                  ? 'None of the rules linked to placement in audited games fired this game.'
                  : 'No notes match the current filter.'}
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

            {/* Unproven observations — collapsed by default */}
            {filteredOther.length > 0 && (
              <details className={styles.otherNotes}>
                <summary className={styles.otherNotesSummary}>
                  Other observations ({filteredOther.length})
                </summary>
                <p className={styles.otherNotesHint}>
                  These rules have not shown a measurable link to placement in the audited
                  matches. They may still be right — there is not enough evidence yet to say.
                </p>
                {filteredOther.map((note, i) => (
                  <CoachingCard key={i} note={note} />
                ))}
              </details>
            )}

            {/* Always-on rules, one line each instead of their notes */}
            {report.common_patterns && report.common_patterns.length > 0 && (
              <section className={styles.stageSection}>
                <div className={styles.stageTitle}>Shows up in most games</div>
                <ul className={styles.commonPatterns}>
                  {report.common_patterns.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              </section>
            )}

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
