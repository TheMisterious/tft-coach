// Unit coverage for src/coach/brief-builder.ts's diversifyRepeatedNotes —
// the fix for repeated ruleId firings reusing the exact same templated
// coaching_text paragraph verbatim (see checkers/econ.ts's byHp-style
// bucketed templates: when HP/gold stays in the same bucket across nearby
// rounds, occurrence 2 and 3 of the same rule would otherwise show identical
// prose with only the round-specific numbers swapped in).

import { describe, it, expect } from 'vitest';
import { diversifyRepeatedNotes } from '../src/coach/brief-builder';
import type { DecisionPoint } from '../src/shared/types';

function makePoint(overrides: Partial<DecisionPoint>): DecisionPoint {
  return {
    ruleId: 'ECON_001',
    round: '2-1',
    category: 'econ',
    severity: 'moderate',
    observed: 'Ended 2-1 at 8g — 2g below the 10g interest tier',
    recommended: 'Hold 2g more to cross the 10g bracket',
    reasonMetrics: {},
    coaching_text: 'At 2-1 you were 2g short of the 10g bracket — and already at 60 HP. That single gold costs you +1 interest every round from here.',
    ...overrides,
  };
}

describe('diversifyRepeatedNotes', () => {
  it('leaves the first occurrence of a ruleId untouched', () => {
    const points = [makePoint({ round: '2-1' })];
    const result = diversifyRepeatedNotes(points);
    expect(result[0].coaching_text).toBe(points[0].coaching_text);
  });

  it('rewrites the second occurrence instead of repeating the same paragraph verbatim', () => {
    const sameCoachingText = 'At {round} you were 2g short of the 10g bracket — and already at 60 HP.';
    const points = [
      makePoint({ round: '2-1', coaching_text: sameCoachingText }),
      makePoint({ round: '3-1', coaching_text: sameCoachingText }),
    ];
    const result = diversifyRepeatedNotes(points);
    expect(result[0].coaching_text).toBe(sameCoachingText);
    expect(result[1].coaching_text).not.toBe(sameCoachingText);
    // Recurrence text should reference back to the first occurrence's round.
    expect(result[1].coaching_text).toContain('2-1');
  });

  it('gives distinct phrasing to the 2nd and 3rd occurrence, not the same recurrence sentence twice', () => {
    const sameCoachingText = 'Templated paragraph identical every time.';
    const points = [
      makePoint({ round: '2-1', coaching_text: sameCoachingText }),
      makePoint({ round: '3-1', coaching_text: sameCoachingText }),
      makePoint({ round: '4-1', coaching_text: sameCoachingText }),
    ];
    const result = diversifyRepeatedNotes(points);
    expect(result[1].coaching_text).not.toBe(result[2].coaching_text);
  });

  it('does not cross-contaminate occurrence counts between different ruleIds', () => {
    const points = [
      makePoint({ ruleId: 'ECON_001', round: '2-1' }),
      makePoint({ ruleId: 'HP_001', round: '3-1', coaching_text: 'HP note text.' }),
      makePoint({ ruleId: 'ECON_001', round: '4-1' }),
    ];
    const result = diversifyRepeatedNotes(points);
    // HP_001's only occurrence is untouched even though it sits between two ECON_001s.
    expect(result[1].coaching_text).toBe('HP note text.');
    // ECON_001's second occurrence (index 2) is still rewritten.
    expect(result[2].coaching_text).not.toBe(points[2].coaching_text);
  });

  it('leaves points without a ruleId or coaching_text untouched', () => {
    const points = [
      makePoint({ ruleId: undefined, round: '2-1' }),
      makePoint({ ruleId: 'ECON_001', coaching_text: undefined, round: '3-1' }),
    ];
    const result = diversifyRepeatedNotes(points);
    expect(result[0]).toEqual(points[0]);
    expect(result[1]).toEqual(points[1]);
  });
});
