// What reaches the report (src/coach/brief-builder.ts partitionForReport):
// always-on rules become one summary line, unconfirmed candidate rules stay
// out, everything else is a note — while the grade still sees every point.
// Rule ids come from the evidence file and registry, so a re-audit that moves
// a rule between verdicts does not break these tests.

import { describe, it, expect } from 'vitest';
import { buildBrief, partitionForReport } from '../src/coach/brief-builder';
import { getAllRules, getRuleEvidence } from '../src/coach/rules-loader';
import { overallGrade } from '../src/coach/scoring';
import { loadMeta } from '../src/enrichment/meta-lookup';
import type { DecisionPoint, MatchSnapshot } from '../src/shared/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const evidence = require('../data/core/rule-evidence.json') as { rules: Record<string, { verdict: string }> };
const ALWAYS_ON = Object.entries(evidence.rules).find(([, e]) => e.verdict === 'always-on')?.[0];
const ORDINARY = Object.entries(evidence.rules).find(([id, e]) => e.verdict === 'unproven' && !getAllRules().find(r => r.unique_id === id)?.status)?.[0];
const CANDIDATE = getAllRules().find(r => r.status === 'candidate' && getRuleEvidence(r.unique_id).status !== 'confirmed')?.unique_id;

const point = (ruleId: string, round = '3-2'): DecisionPoint => ({
  ruleId, round, category: 'econ', severity: 'moderate', observed: `${ruleId} at ${round}`,
  recommended: 'x', reasonMetrics: {}, coaching_text: 'why',
});

describe('partitionForReport', () => {
  it('has an always-on rule, an ordinary rule and an unconfirmed candidate to work with', () => {
    expect(ALWAYS_ON).toBeTruthy();
    expect(ORDINARY).toBeTruthy();
    expect(CANDIDATE).toBeTruthy();
  });

  it('turns every firing of an always-on rule into one summary line', () => {
    const { reportable, commonPatterns } = partitionForReport([point(ALWAYS_ON!, '2-1'), point(ALWAYS_ON!, '3-1'), point(ORDINARY!)]);
    expect(reportable.map(p => p.ruleId)).toEqual([ORDINARY]);
    expect(commonPatterns).toHaveLength(1);
    expect(commonPatterns[0]).toContain('2 times this game');
    expect(commonPatterns[0]).toMatch(/shows up in \d+ of \d+ audited games/);
  });

  it('keeps an unconfirmed candidate rule out of the report entirely', () => {
    const { reportable, commonPatterns } = partitionForReport([point(CANDIDATE!), point(ORDINARY!)]);
    expect(reportable.map(p => p.ruleId)).toEqual([ORDINARY]);
    expect(commonPatterns).toEqual([]);
  });
});

describe('buildBrief', () => {
  it('drops always-on notes from the brief but still grades with them', async () => {
    const meta = await loadMeta('set17');
    const match: MatchSnapshot = {
      pseudoMatchId: 't', setId: 'set17', gameMode: 'tft', rounds: [], placementSource: 'gep',
      finalPlacement: 5, finalBoard: {}, augments: [], godPicks: [],
    };
    const all = [point(ALWAYS_ON!, '2-1'), point(ALWAYS_ON!, '3-1'), point(ORDINARY!)];
    const brief = buildBrief(match, all, meta);
    expect(brief.resolvedNotes.map(n => n.what_happened)).toEqual([`${ORDINARY} at 3-2`]);
    expect(brief.commonPatterns).toHaveLength(1);
    expect(brief.overallGrade).toBe(overallGrade(5, all, 0));
  });
});
