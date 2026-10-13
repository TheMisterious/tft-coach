// The statistics behind scripts/rule-audit.ts. Small, but every coaching
// verdict the app shows rests on them, so their edge behaviour is pinned.

import { describe, it, expect } from 'vitest';
import { bh, bootstrapDiffCI, permutationP, minimumDetectableEffect, ranks, sd } from '../scripts/audit-stats';

describe('bh', () => {
  it('matches hand-computed Benjamini-Hochberg q-values and keeps input order', () => {
    // sorted p: 0.01, 0.02, 0.03, 0.5 -> raw q 0.04, 0.04, 0.04, 0.5
    expect(bh([0.03, 0.01, 0.5, 0.02]).map(q => Number(q.toFixed(4)))).toEqual([0.04, 0.04, 0.5, 0.04]);
  });

  it('never returns a q above 1', () => {
    expect(Math.max(...bh([0.9, 0.95, 1]))).toBeLessThanOrEqual(1);
  });
});

describe('bootstrapDiffCI', () => {
  const worse = [7, 8, 6, 7, 8, 7, 6, 8];
  const better = [2, 3, 1, 2, 4, 3, 2, 1];

  it('is reproducible for a seed', () => {
    expect(bootstrapDiffCI(worse, better, 7)).toEqual(bootstrapDiffCI(worse, better, 7));
  });

  it('brackets the observed difference and excludes 0 for clearly separated groups', () => {
    const [lo, hi] = bootstrapDiffCI(worse, better, 3);
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThanOrEqual(4.75);
    expect(hi).toBeGreaterThanOrEqual(4.75);
  });

  it('straddles 0 when the groups are the same', () => {
    const [lo, hi] = bootstrapDiffCI([3, 5, 4, 6, 2], [4, 3, 6, 5, 2], 3);
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(0);
  });
});

describe('permutationP', () => {
  const worse = [7, 8, 6, 7, 8, 7];
  const better = [2, 3, 1, 2, 4, 3];

  it('one-sided "greater" is small only in the direction asked about', () => {
    expect(permutationP(worse, better, 1, 'greater')).toBeLessThan(0.01);
    expect(permutationP(better, worse, 1, 'greater')).toBeGreaterThan(0.9);
  });

  it('two-sided treats either direction alike', () => {
    expect(permutationP(better, worse, 1)).toBeLessThan(0.01);
  });
});

describe('minimumDetectableEffect', () => {
  it('is 2.8 standard errors of the difference', () => {
    expect(minimumDetectableEffect(2, 25, 25)).toBeCloseTo(2.8 * 2 * Math.sqrt(2 / 25), 10);
  });

  it('shrinks with the square root of the sample', () => {
    const small = minimumDetectableEffect(2.3, 25, 49);
    const fourTimes = minimumDetectableEffect(2.3, 100, 196);
    expect(fourTimes).toBeCloseTo(small / 2, 10);
  });
});

describe('ranks and sd', () => {
  it('averages tied ranks', () => {
    expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it('uses the sample (n-1) standard deviation', () => {
    expect(sd([1, 2, 3, 4])).toBeCloseTo(Math.sqrt(5 / 3), 10);
  });
});
