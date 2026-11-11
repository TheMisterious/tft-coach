// The priority fix prefers the habit (src/coach/report-generator.ts): among
// the measured notes of the worst category, a note whose behaviour recurred
// in the player's recent matches at or above the habit rate outranks a more
// severe one-off, and the fix says how often it happened.

import { describe, it, expect } from 'vitest';
import { generateCoachingReport } from '../src/coach/report-generator';
import { attachHistoryContext, type MatchHistoryEntry } from '../src/coach/history-context';
import { getRuleMeta, getRuleEvidence } from '../src/coach/rules-loader';
import { FEATURE_SCHEMA_VERSION, type MatchBrief, type CoachingNote, type DecisionPoint, type FeatureVector, type RuleVerdict } from '../src/shared/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const evidence = require('../data/core/rule-evidence.json') as { rules: Record<string, { verdict: RuleVerdict }> };
const MEASURED = Object.entries(evidence.rules).find(([id, e]) => e.verdict === 'predictive' && getRuleMeta(id)?.status !== 'candidate')![0];

function note(over: Partial<CoachingNote>): CoachingNote {
  return {
    round_label: '4-1', category: 'hp', severity: 'moderate', evidence: getRuleEvidence(MEASURED),
    what_happened: 'x', what_should_have_happened: 'fix x', why: 'why x', ...over,
  };
}

function brief(resolvedNotes: CoachingNote[]): MatchBrief {
  return {
    placement: 6, setId: 'set18', roundTrajectory: [], finalComp: [], augments: [], godPicks: [],
    plan: { headline: '', finalTraits: [], pivots: [], econStyle: 'standard', econPhases: [], levelMilestones: [] },
    resolvedNotes, decisionPoints: [], overallGrade: 'C', categoryGrades: { hp: 'D' },
  };
}

describe('habit-weighted priority fix', () => {
  it('prefers the habitual note over a more severe one-off in the same category', async () => {
    const report = await generateCoachingReport(brief([
      note({ severity: 'critical', what_should_have_happened: 'the one-off' }),
      note({ severity: 'minor', what_should_have_happened: 'the habit', habit: { count: 7, sample: 10 } }),
    ]));
    expect(report.priority_fix?.action).toBe('the habit');
    expect(report.priority_fix?.habit).toBe('This also happened in 7 of your previous 10 matches, so of everything in this report it is the pattern most worth practising.');
  });

  it('keeps severity first when nothing reached the habit rate, and still says how often it happened', async () => {
    const report = await generateCoachingReport(brief([
      note({ severity: 'critical', what_should_have_happened: 'the one-off', habit: { count: 2, sample: 10 } }),
      note({ severity: 'minor', what_should_have_happened: 'the other', habit: { count: 3, sample: 10 } }),
    ]));
    expect(report.priority_fix?.action).toBe('the one-off');
    expect(report.priority_fix?.habit).toBe('This also happened in 2 of your previous 10 matches.');
  });

  it('has no habit line without history', async () => {
    const report = await generateCoachingReport(brief([note({})]));
    expect(report.priority_fix?.habit).toBeUndefined();
  });
});

describe('attachHistoryContext sets the recurrence on the point', () => {
  const vector = (hp: number): FeatureVector => ({ schemaVersion: FEATURE_SCHEMA_VERSION, hpAtStage4Entry: hp } as unknown as FeatureVector);
  const history: MatchHistoryEntry[] = [40, 50, 70, 30, 35, 80].map((hp, i) => ({ matchId: `m${i}`, featureVector: vector(hp), placement: 5 }));
  const point: DecisionPoint = { ruleId: 'HP_002', round: '4-1', category: 'hp', severity: 'moderate', observed: 'o', recommended: 'r', reasonMetrics: {}, coaching_text: 'why.' };

  it('counts the prior matches that showed the behaviour', () => {
    const [p] = attachHistoryContext([point], history);
    expect(p.habit).toEqual({ count: 4, sample: 6 });
    expect(p.coaching_text).toContain('4 of your previous 6 matches');
  });
});
