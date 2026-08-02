// Unit coverage for src/coach/report-generator.ts's buildPriorityFix/buildTldr —
// previously only exercised indirectly through golden-match smoke tests.
//
// Both were upgraded from single-note sampling to full-category synthesis: the
// old buildPriorityFix quoted only ONE note per category (discarding every
// other real issue in that category even though `occurrences` counted them
// all), and buildTldr never called out how many of a match's notes were
// actually critical severity.

import { describe, it, expect } from 'vitest';
import { generateCoachingReport } from '../src/coach/report-generator';
import type { MatchBrief, CoachingNote, Grade, DecisionCategory } from '../src/shared/types';

function makeNote(overrides: Partial<CoachingNote>): CoachingNote {
  return {
    round_label: '2-1',
    category: 'econ',
    severity: 'moderate',
    what_happened: 'Ended 2-1 at 8g — 2g below the 10g interest tier',
    what_should_have_happened: 'Hold 2g more to cross the 10g bracket',
    why: 'That single gold costs you +1 interest every round from here.',
    ...overrides,
  };
}

const NEUTRAL_GRADES: Record<DecisionCategory, Grade> = {
  econ: 'S', streak: 'S', leveling: 'S', items: 'S', rolling: 'S', traits: 'S',
  augments: 'S', positioning: 'S', hp: 'S', board: 'S', comp: 'S', combat: 'S', set_mechanic: 'S',
};

interface BriefOverrides extends Partial<Omit<MatchBrief, 'categoryGrades'>> {
  categoryGrades?: Partial<Record<DecisionCategory, Grade>>;
}

function makeBrief(overrides: BriefOverrides = {}): MatchBrief {
  const { categoryGrades, ...rest } = overrides;
  return {
    placement: 4,
    setId: 'set17',
    roundTrajectory: [],
    finalComp: [],
    augments: [],
    godPicks: [],
    plan: { headline: '', finalTraits: [], pivots: [], econStyle: 'standard', econPhases: [], levelMilestones: [] },
    resolvedNotes: [],
    decisionPoints: [],
    overallGrade: 'B',
    ...rest,
    categoryGrades: { ...NEUTRAL_GRADES, ...categoryGrades },
  };
}

describe('buildPriorityFix', () => {
  it('is undefined when there are no notes at all', async () => {
    const report = await generateCoachingReport(makeBrief());
    expect(report.priority_fix).toBeUndefined();
  });

  it('picks the worst-graded category and quotes its most severe note as action/why', async () => {
    const notes = [
      makeNote({ category: 'econ', severity: 'moderate', round_label: '2-1' }),
      makeNote({ category: 'econ', severity: 'critical', round_label: '3-1', what_should_have_happened: 'Roll down now', why: 'Critical HP crisis.' }),
    ];
    const brief = makeBrief({ resolvedNotes: notes, categoryGrades: { econ: 'D' } });
    const report = await generateCoachingReport(brief);
    expect(report.priority_fix?.category).toBe('econ');
    expect(report.priority_fix?.occurrences).toBe(2);
    expect(report.priority_fix?.action).toBe('Roll down now');
    expect(report.priority_fix?.why).toBe('Critical HP crisis.');
  });

  it('regression: lists distinct patterns from every note in the category, not just the one sampled note', async () => {
    // Real gap: a category with several genuinely different issues (two
    // separate missed-interest gaps and an overcap streak) used to report
    // "occurrences: 3" but only ever showed the text of ONE of them — the
    // other two real issues were invisible to the player.
    const notes = [
      makeNote({ category: 'econ', severity: 'critical', round_label: '2-3', what_happened: 'Ended 2-3 at 9g — 1g below the 10g interest tier' }),
      makeNote({ category: 'econ', severity: 'moderate', round_label: '3-2', what_happened: 'Held 55g for 3 rounds without rolling or leveling' }),
      makeNote({ category: 'econ', severity: 'moderate', round_label: '4-1', what_happened: 'Ended 4-1 at 18g — 2g below the 20g interest tier' }),
    ];
    const brief = makeBrief({ resolvedNotes: notes, categoryGrades: { econ: 'D' } });
    const report = await generateCoachingReport(brief);
    expect(report.priority_fix?.patterns).toBeTruthy();
    // The top note itself (2-3) shouldn't be duplicated into patterns.
    expect(report.priority_fix?.patterns?.some(p => p.includes('2-3'))).toBe(false);
    expect(report.priority_fix?.patterns?.some(p => p.includes('3-2'))).toBe(true);
    expect(report.priority_fix?.patterns?.some(p => p.includes('4-1'))).toBe(true);
  });

  it('omits patterns when there is only the one note', async () => {
    const notes = [makeNote({ category: 'econ', severity: 'critical' })];
    const brief = makeBrief({ resolvedNotes: notes, categoryGrades: { econ: 'D' } });
    const report = await generateCoachingReport(brief);
    expect(report.priority_fix?.patterns).toBeUndefined();
  });

  it('caps patterns at 4 distinct entries even with more real occurrences', async () => {
    const notes = Array.from({ length: 6 }, (_, i) =>
      makeNote({ category: 'econ', severity: 'moderate', round_label: `2-${i + 1}`, what_happened: `Distinct issue #${i}` })
    );
    const brief = makeBrief({ resolvedNotes: notes, categoryGrades: { econ: 'D' } });
    const report = await generateCoachingReport(brief);
    expect(report.priority_fix?.patterns?.length).toBeLessThanOrEqual(4);
  });
});

describe('buildTldr', () => {
  it('calls out the critical count when critical notes exist', async () => {
    const notes = [
      makeNote({ category: 'econ', severity: 'critical' }),
      makeNote({ category: 'hp', severity: 'moderate' }),
    ];
    const brief = makeBrief({ resolvedNotes: notes });
    const report = await generateCoachingReport(brief);
    expect(report.tldr).toContain('1');
    expect(report.tldr).toContain('critical');
  });

  it('does not mention critical count when there are no critical notes', async () => {
    const notes = [makeNote({ category: 'econ', severity: 'moderate' })];
    const brief = makeBrief({ resolvedNotes: notes });
    const report = await generateCoachingReport(brief);
    expect(report.tldr).not.toContain('critical');
  });

  it('stays lightweight when there are no notes at all', async () => {
    const report = await generateCoachingReport(makeBrief());
    expect(report.tldr).not.toContain('critical');
    expect(report.tldr).toContain('0 coaching notes');
  });
});
