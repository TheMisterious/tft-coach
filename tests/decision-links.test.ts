// Unit coverage for src/coach/decision-links.ts — cross-links real,
// quantifiable causal chains between DecisionPoint categories that the rule
// engine previously reported as isolated notes.

import { describe, it, expect } from 'vitest';
import { linkCompoundingPatterns } from '../src/coach/decision-links';
import type { DecisionPoint } from '../src/shared/types';

function makePoint(overrides: Partial<DecisionPoint>): DecisionPoint {
  return {
    ruleId: 'ECON_001',
    round: '3-2',
    category: 'econ',
    severity: 'moderate',
    observed: 'observed',
    recommended: 'recommended',
    reasonMetrics: {},
    coaching_text: 'Base text.',
    ...overrides,
  };
}

describe('linkCompoundingPatterns — ECON_001 <- COMP_002', () => {
  it('links a same-round bench-clutter note when the locked gold covers the interest gap', () => {
    const points = [
      makePoint({
        ruleId: 'COMP_002', round: '3-2', category: 'comp',
        reasonMetrics: { clutterCount: 5, rounds: 3, goldLocked: 12 },
        coaching_text: 'Bench clutter text.',
      }),
      makePoint({
        ruleId: 'ECON_001', round: '3-2', category: 'econ',
        reasonMetrics: { goldEnd: 8, tier: 10, gap: 2 },
        coaching_text: 'Missed interest text.',
      }),
    ];
    const result = linkCompoundingPatterns(points);
    const econ = result.find(p => p.ruleId === 'ECON_001')!;
    expect(econ.coaching_text).toContain('Missed interest text.');
    expect(econ.coaching_text).toContain('12g of bench clutter');
  });

  it('does not link when the locked gold is not enough to have closed the gap', () => {
    const points = [
      makePoint({
        ruleId: 'COMP_002', round: '3-2', category: 'comp',
        reasonMetrics: { clutterCount: 5, rounds: 3, goldLocked: 1 },
      }),
      makePoint({
        ruleId: 'ECON_001', round: '3-2', category: 'econ',
        reasonMetrics: { goldEnd: 8, tier: 10, gap: 2 },
        coaching_text: 'Missed interest text.',
      }),
    ];
    const result = linkCompoundingPatterns(points);
    const econ = result.find(p => p.ruleId === 'ECON_001')!;
    expect(econ.coaching_text).toBe('Missed interest text.');
  });

  it('does not link a bench-clutter note from a different round', () => {
    const points = [
      makePoint({ ruleId: 'COMP_002', round: '3-1', reasonMetrics: { goldLocked: 50 } }),
      makePoint({ ruleId: 'ECON_001', round: '3-2', reasonMetrics: { gap: 2 }, coaching_text: 'Missed interest text.' }),
    ];
    const result = linkCompoundingPatterns(points);
    expect(result.find(p => p.ruleId === 'ECON_001')!.coaching_text).toBe('Missed interest text.');
  });

  it('leaves ECON_001 untouched when no COMP_002 note exists at all', () => {
    const points = [makePoint({ ruleId: 'ECON_001', round: '3-2', reasonMetrics: { gap: 2 }, coaching_text: 'Missed interest text.' })];
    const result = linkCompoundingPatterns(points);
    expect(result[0].coaching_text).toBe('Missed interest text.');
  });
});

describe('linkCompoundingPatterns — HP_002/HP_003 <- ITEM_003/BOARD_001', () => {
  it('links HP_002 (4-1) to an ITEM_003 note at the same checkpoint', () => {
    const points = [
      makePoint({ ruleId: 'ITEM_003', round: '4-1', category: 'items', reasonMetrics: { carry: 'Riven', itemCount: 1 } }),
      makePoint({ ruleId: 'HP_002', round: '4-1', category: 'hp', coaching_text: 'HP text.' }),
    ];
    const result = linkCompoundingPatterns(points);
    const hp = result.find(p => p.ruleId === 'HP_002')!;
    expect(hp.coaching_text).toContain('HP text.');
    expect(hp.coaching_text).toContain('under-itemized carry (1 completed item(s))');
    expect(hp.coaching_text).toContain('4-1');
  });

  it('links HP_002 (4-1) to a BOARD_001 note at 3-1', () => {
    const points = [
      makePoint({ ruleId: 'BOARD_001', round: '3-1', category: 'board', reasonMetrics: { costSum: 5, benchmark: 20, deficit: 15, stage: 3 } }),
      makePoint({ ruleId: 'HP_002', round: '4-1', category: 'hp', coaching_text: 'HP text.' }),
    ];
    const result = linkCompoundingPatterns(points);
    expect(result.find(p => p.ruleId === 'HP_002')!.coaching_text).toContain('board-cost deficit at 3-1 (15 below benchmark)');
  });

  it('links HP_003 (5-1) to a BOARD_001 note at 4-1 but not one at 3-1', () => {
    const points = [
      makePoint({ ruleId: 'BOARD_001', round: '3-1', category: 'board', reasonMetrics: { deficit: 99 } }),
      makePoint({ ruleId: 'BOARD_001', round: '4-1', category: 'board', reasonMetrics: { deficit: 12 } }),
      makePoint({ ruleId: 'HP_003', round: '5-1', category: 'hp', coaching_text: 'Lethal zone text.' }),
    ];
    const result = linkCompoundingPatterns(points);
    const hp = result.find(p => p.ruleId === 'HP_003')!;
    expect(hp.coaching_text).toContain('4-1 (12 below benchmark)');
    expect(hp.coaching_text).not.toContain('99 below benchmark');
  });

  it('combines ITEM_003 and BOARD_001 into one clause when both contributed', () => {
    const points = [
      makePoint({ ruleId: 'ITEM_003', round: '4-1', reasonMetrics: { itemCount: 0 } }),
      makePoint({ ruleId: 'BOARD_001', round: '4-1', reasonMetrics: { deficit: 20 } }),
      makePoint({ ruleId: 'HP_002', round: '4-1', coaching_text: 'HP text.' }),
    ];
    const result = linkCompoundingPatterns(points);
    const hp = result.find(p => p.ruleId === 'HP_002')!;
    expect(hp.coaching_text).toContain('0 completed item(s)');
    expect(hp.coaching_text).toContain('20 below benchmark');
    expect(hp.coaching_text).toContain(' and ');
  });

  it('leaves an HP note untouched when no contributing note exists', () => {
    const points = [makePoint({ ruleId: 'HP_002', round: '4-1', coaching_text: 'HP text.' })];
    const result = linkCompoundingPatterns(points);
    expect(result[0].coaching_text).toBe('HP text.');
  });

  it('does not touch unrelated ruleIds', () => {
    const points = [makePoint({ ruleId: 'STREAK_001', round: '3-1', coaching_text: 'Streak text.' })];
    const result = linkCompoundingPatterns(points);
    expect(result[0].coaching_text).toBe('Streak text.');
  });
});
