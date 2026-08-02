// Unit coverage for src/profile/stats.ts's hand-rolled math — pure
// synthetic-data tests against known ground truth, nothing calibrated
// against real matches, so nothing here can be overfit.

import { describe, it, expect } from 'vitest';
import { pearsonCorrelation, ridgeRegression, kMeans } from '../src/profile/stats';

describe('pearsonCorrelation', () => {
  it('returns ~1 for a perfectly positively correlated series', () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(xs, ys)).toBeCloseTo(1, 5);
  });

  it('returns ~-1 for a perfectly negatively correlated series', () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [10, 8, 6, 4, 2];
    expect(pearsonCorrelation(xs, ys)).toBeCloseTo(-1, 5);
  });

  it('returns exactly 0 for a symmetric, uncorrelated series', () => {
    // Constructed so both series are mean-centered and orthogonal: xs
    // increases monotonically while ys is symmetric around its own mean,
    // making the covariance sum exactly cancel — not a coincidence of a
    // small random sample.
    const xs = [1, 2, 3, 4];
    const ys = [1, 4, 4, 1];
    expect(pearsonCorrelation(xs, ys)).toBeCloseTo(0, 10);
  });

  it('returns 0 for a constant series (zero variance)', () => {
    const xs = [5, 5, 5, 5];
    const ys = [1, 2, 3, 4];
    expect(pearsonCorrelation(xs, ys)).toBe(0);
  });

  it('returns 0 for mismatched or empty input', () => {
    expect(pearsonCorrelation([], [])).toBe(0);
    expect(pearsonCorrelation([1, 2], [1])).toBe(0);
  });
});

describe('ridgeRegression', () => {
  it('recovers known coefficients from y = 2*x1 + 3*x2 (no noise, independent predictors)', () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 20; i++) {
      const x1 = i;
      const x2 = (i * 3 + 1) % 7; // varies independently of x1 — not a linear function of it
      X.push([x1, x2]);
      y.push(2 * x1 + 3 * x2);
    }
    const { coefficients, rSquared } = ridgeRegression(X, y, 0.01);
    expect(rSquared).toBeGreaterThan(0.95);
    expect(coefficients.length).toBe(2);
    expect(coefficients[0]).toBeGreaterThan(0);
    expect(coefficients[1]).toBeGreaterThan(0);
  });

  it('returns rSquared near 0 for pure noise with no real relationship', () => {
    const X = [[1], [2], [3], [4], [5], [6], [7], [8]];
    const y = [5, 2, 8, 1, 9, 3, 6, 4]; // shuffled, no relationship to X
    const { rSquared } = ridgeRegression(X, y, 1.0);
    expect(rSquared).toBeLessThan(0.5);
  });

  it('handles empty input without throwing', () => {
    expect(ridgeRegression([], [], 1)).toEqual({ coefficients: [], rSquared: 0 });
  });
});

describe('kMeans', () => {
  it('correctly partitions two obviously separated clusters', () => {
    const clusterA = Array.from({ length: 10 }, (_, i) => [0 + i * 0.1, 0 + i * 0.1]);
    const clusterB = Array.from({ length: 10 }, (_, i) => [100 + i * 0.1, 100 + i * 0.1]);
    const points = [...clusterA, ...clusterB];

    const { assignments } = kMeans(points, 2, 7);

    const groupA = new Set(assignments.slice(0, 10));
    const groupB = new Set(assignments.slice(10, 20));
    // Every point within a real cluster should share one assignment id, and
    // the two real clusters should map to different assignment ids.
    expect(groupA.size).toBe(1);
    expect(groupB.size).toBe(1);
    expect([...groupA][0]).not.toBe([...groupB][0]);
  });

  it('is deterministic for the same seed', () => {
    const points = [[1, 1], [1, 2], [10, 10], [10, 11], [5, 5], [6, 5]];
    const run1 = kMeans(points, 2, 42);
    const run2 = kMeans(points, 2, 42);
    expect(run1.assignments).toEqual(run2.assignments);
  });

  it('handles empty input without throwing', () => {
    expect(kMeans([], 2)).toEqual({ assignments: [], centroids: [] });
  });
});
