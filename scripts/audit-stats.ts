// Statistics for scripts/rule-audit.ts, kept apart so they can be tested
// (tests/audit-stats.test.ts) and read without the replay plumbing around them.
//
// Everything here is deliberately simple and assumption-light, because the
// samples are small (tens of matches, sometimes single digits per group):
// permutation tests instead of t-tests, percentile bootstrap intervals instead
// of normal-theory ones, and a seeded RNG so a re-run reproduces every number.

export const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
}

export const spearman = (xs: number[], ys: number[]): number => pearson(ranks(xs), ranks(ys));

/** Seeded PRNG (mulberry32) — every reported number is reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rand: () => number): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
}

export const PERMUTATIONS = 5000;

/**
 * Permutation p-value for the difference in mean placement between `a` (rule
 * fired) and `b` (did not). 'two-sided' asks "any difference"; 'greater' asks
 * the one question a confirmation run is entitled to ask — is `a` WORSE (a
 * higher placement number) again, in the direction discovery already found.
 */
export function permutationP(a: number[], b: number[], seed: number, side: 'two-sided' | 'greater' = 'two-sided'): number {
  const all = [...a, ...b];
  const stat = (x: number[], y: number[]) => mean(x) - mean(y);
  const observed = stat(a, b);
  const rand = rng(seed);
  let extreme = 0;
  for (let p = 0; p < PERMUTATIONS; p++) {
    shuffle(all, rand);
    const d = stat(all.slice(0, a.length), all.slice(a.length));
    if (side === 'two-sided' ? Math.abs(d) >= Math.abs(observed) - 1e-12 : d >= observed - 1e-12) extreme++;
  }
  return (extreme + 1) / (PERMUTATIONS + 1);
}

export const BOOTSTRAPS = 4000;

/**
 * 95% percentile-bootstrap interval for mean(a) - mean(b), resampling each
 * group with replacement. Wide on purpose when a group is small: that width is
 * the honest statement of how little a handful of matches can say.
 */
export function bootstrapDiffCI(a: number[], b: number[], seed: number, level = 0.95): [number, number] {
  const rand = rng(seed);
  const draw = (xs: number[]) => {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rand() * xs.length)];
    return s / xs.length;
  };
  const diffs = new Array<number>(BOOTSTRAPS);
  for (let i = 0; i < BOOTSTRAPS; i++) diffs[i] = draw(a) - draw(b);
  diffs.sort((x, y) => x - y);
  const lo = diffs[Math.floor(((1 - level) / 2) * BOOTSTRAPS)];
  const hi = diffs[Math.min(BOOTSTRAPS - 1, Math.ceil((1 - (1 - level) / 2) * BOOTSTRAPS) - 1)];
  return [lo, hi];
}

/** Benjamini-Hochberg q-values, same order as input. */
export function bh(ps: number[]): number[] {
  const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const q = new Array<number>(ps.length);
  let min = 1;
  for (let k = idx.length - 1; k >= 0; k--) {
    min = Math.min(min, (idx[k][0] * idx.length) / (k + 1));
    q[idx[k][1]] = min;
  }
  return q;
}

/**
 * Smallest |difference in mean placement| a two-group comparison of this size
 * could detect with 80% power at two-sided alpha 0.05, by the normal
 * approximation: (z_0.975 + z_0.8) * sd * sqrt(1/n1 + 1/n2) = 2.80 * sd * ....
 * An approximation, and stated as one in every report that prints it.
 */
export function minimumDetectableEffect(sdPooled: number, n1: number, n2: number): number {
  return 2.8 * sdPooled * Math.sqrt(1 / n1 + 1 / n2);
}
