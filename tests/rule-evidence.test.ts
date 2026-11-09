// The report leads with rules that have a measured link to placement
// (data/core/rule-evidence.json, written by scripts/rule-audit.ts --write) and
// collapses the rest. These pin that split, and that the evidence file stays
// in step with the rule registry it describes.
//
// Rule ids are picked FROM the evidence file rather than hard-coded, so
// re-running the audit (which can move a rule between verdicts) does not
// break these tests.

import { describe, it, expect } from 'vitest';
import { generateCoachingReport } from '../src/coach/report-generator';
import { buildBrief } from '../src/coach/brief-builder';
import { getAllRules, getRuleEvidence, getRuleMeta } from '../src/coach/rules-loader';
import { loadMeta } from '../src/enrichment/meta-lookup';
import type { MatchBrief, CoachingNote, DecisionCategory, DecisionPoint, Grade, MatchSnapshot, RuleVerdict } from '../src/shared/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const evidence = require('../data/core/rule-evidence.json') as {
  rules: Record<string, { verdict: RuleVerdict }>;
};

const VERDICTS: RuleVerdict[] = ['predictive', 'inverted', 'unproven', 'always-on', 'rare', 'whole-match', 'never-fired', 'unaudited'];
const ids = Object.entries(evidence.rules);
// A candidate rule is predictive on the old matches yet stays out of reports
// until newer ones confirm it, so the measured example must not be one.
const MEASURED = ids.find(([id, e]) => e.verdict === 'predictive' && getRuleMeta(id)?.status !== 'candidate')?.[0];
const UNPROVEN = ids.find(([, e]) => e.verdict !== 'predictive')?.[0];

const NEUTRAL_GRADES: Record<DecisionCategory, Grade> = {
  econ: 'S', streak: 'S', leveling: 'S', items: 'S', rolling: 'S', traits: 'S',
  augments: 'S', positioning: 'S', hp: 'S', board: 'S', comp: 'S', combat: 'S', set_mechanic: 'S',
};

function note(ruleId: string, overrides: Partial<CoachingNote> = {}): CoachingNote {
  return {
    round_label: '3-2',
    category: 'econ',
    severity: 'moderate',
    evidence: getRuleEvidence(ruleId),
    what_happened: `${ruleId} fired`,
    what_should_have_happened: `Fix ${ruleId}`,
    why: `Because ${ruleId}.`,
    ...overrides,
  };
}

function brief(resolvedNotes: CoachingNote[]): MatchBrief {
  return {
    placement: 5, setId: 'set17', roundTrajectory: [], finalComp: [], augments: [], godPicks: [],
    plan: { headline: '', finalTraits: [], pivots: [], econStyle: 'standard', econPhases: [], levelMilestones: [] },
    resolvedNotes, decisionPoints: [], overallGrade: 'C',
    categoryGrades: { ...NEUTRAL_GRADES, econ: 'D', hp: 'C' },
  };
}

describe('rule-evidence.json', () => {
  it('only describes rules that exist in the registry', () => {
    const registry = new Set(getAllRules().map(r => r.unique_id));
    expect(ids.map(([id]) => id).filter(id => !registry.has(id))).toEqual([]);
  });

  it('marks every rule confirmed or exploratory, and confirms only predictive ones', () => {
    const raw = evidence.rules as Record<string, { verdict: RuleVerdict; status?: string }>;
    for (const [id, e] of Object.entries(raw)) {
      expect(['confirmed', 'exploratory'], id).toContain(e.status ?? 'exploratory');
      if (e.status === 'confirmed') expect(['predictive', 'inverted'], id).toContain(e.verdict);
    }
    expect(getRuleEvidence('NOT_A_RULE').status).toBeUndefined(); // unaudited: no evidence, so no status
  });

  it('uses only known verdicts', () => {
    expect(ids.filter(([, e]) => !VERDICTS.includes(e.verdict))).toEqual([]);
  });

  it('has at least one measured and one unproven rule to drive the tests below', () => {
    expect(MEASURED).toBeTruthy();
    expect(UNPROVEN).toBeTruthy();
  });

  it('reports a rule missing from the file, or a note with no ruleId, as unaudited', () => {
    expect(getRuleEvidence('NOT_A_RULE').verdict).toBe('unaudited');
    expect(getRuleEvidence(undefined).verdict).toBe('unaudited');
  });
});

describe('report split by evidence', () => {
  it('leads with measured notes and collapses the rest', async () => {
    const report = await generateCoachingReport(brief([note(MEASURED!), note(UNPROVEN!)]));
    expect(report.notes.map(n => n.what_happened)).toEqual([`${MEASURED} fired`]);
    expect(report.other_notes?.map(n => n.what_happened)).toEqual([`${UNPROVEN} fired`]);
  });

  it('never takes the priority fix from an unproven rule, even in the worst-graded category', async () => {
    const report = await generateCoachingReport(brief([
      note(MEASURED!, { category: 'hp' }),
      note(UNPROVEN!, { category: 'econ', severity: 'critical' }),
    ]));
    expect(report.priority_fix?.category).toBe('hp');
    expect(report.priority_fix?.action).toBe(`Fix ${MEASURED}`);
  });

  it('has no priority fix when only unproven rules fired, and says so', async () => {
    const report = await generateCoachingReport(brief([note(UNPROVEN!)]));
    expect(report.priority_fix).toBeUndefined();
    expect(report.notes).toEqual([]);
    expect(report.tldr).toContain('None of the rules linked to placement');
    expect(report.tldr).toContain('1 other observation');
  });

  it('leaves a pre-audit brief (no evidence on any note) unpartitioned', async () => {
    const legacy = note(UNPROVEN!);
    delete legacy.evidence;
    const report = await generateCoachingReport(brief([legacy]));
    expect(report.notes).toHaveLength(1);
    expect(report.other_notes).toBeUndefined();
  });
});

describe('brief truncation', () => {
  it('keeps a measured note even when 20+ more severe unproven notes come first', async () => {
    const meta = await loadMeta('set17');
    const match: MatchSnapshot = {
      pseudoMatchId: 'test', setId: 'set17', gameMode: 'tft', rounds: [],
      finalPlacement: 6, finalBoard: {}, augments: [], godPicks: [],
    };
    const point = (ruleId: string, round: string, severity: DecisionPoint['severity']): DecisionPoint => ({
      ruleId, round, category: 'econ', severity,
      observed: `${ruleId} at ${round}`, recommended: 'x', reasonMetrics: {}, coaching_text: 'why',
    });
    // Three firings per unproven rule stays within the per-rule cap, so the
    // cap is not what saves the measured note — only the reordering is.
    const unprovenIds = ids.filter(([, e]) => e.verdict !== 'predictive').map(([id]) => id);
    const noise = unprovenIds.flatMap(id => [1, 2, 3].map(r => point(id, `3-${r}`, 'critical')));
    expect(noise.length).toBeGreaterThan(20);
    const b = buildBrief(match, [...noise, point(MEASURED!, '4-1', 'minor')], meta);
    expect(b.resolvedNotes.some(n => n.what_happened === `${MEASURED} at 4-1`)).toBe(true);
  });
});
