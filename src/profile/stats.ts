// Pure math for the Player Trends model — no DOM/React/Overwolf imports, so
// this is plain-Node/Vitest testable in isolation. Hand-rolled rather than a
// library dependency: the matrices involved here are at most ~28x28 (the
// FeatureVector's field count), trivial at that scale, and this keeps the
// project's dependency footprint unchanged (react/react-dom/zustand only).

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0 || ys.length !== n) return 0;
  const meanX = mean(xs);
  const meanY = mean(ys);
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

function standardize(col: number[]): number[] {
  const m = mean(col);
  const variance = col.length > 0 ? col.reduce((s, v) => s + (v - m) ** 2, 0) / col.length : 0;
  const std = Math.sqrt(variance);
  return std === 0 ? col.map(() => 0) : col.map(v => (v - m) / std);
}

function transpose(A: number[][]): number[][] {
  if (A.length === 0) return [];
  return A[0].map((_, j) => A.map(row => row[j]));
}

function matMul(A: number[][], B: number[][]): number[][] {
  const result: number[][] = [];
  for (let i = 0; i < A.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < B[0].length; j++) {
      let sum = 0;
      for (let k = 0; k < B.length; k++) sum += A[i][k] * B[k][j];
      row.push(sum);
    }
    result.push(row);
  }
  return result;
}

function matVecMul(A: number[][], v: number[]): number[] {
  return A.map(row => row.reduce((s, a, i) => s + a * v[i], 0));
}

// Gauss-Jordan elimination with partial pivoting. Ridge's lambda*I addition
// keeps this well-conditioned for the small matrices (<=~28x28) this project
// ever calls it with — no need for anything more sophisticated at this scale.
function invertMatrix(M: number[][]): number[][] {
  const n = M.length;
  const aug = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivotRow][col])) pivotRow = r;
    }
    [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];

    const pivotVal = aug[col][col];
    if (Math.abs(pivotVal) < 1e-10) continue; // near-singular column — ridge's lambda*I should prevent this in practice

    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivotVal;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) aug[r][j] -= factor * aug[col][j];
    }
  }

  return aug.map(row => row.slice(n));
}

// Ridge regression via closed-form normal equations on standardized (z-scored)
// columns: beta = (XtX + lambda*I)^-1 * Xt*y. Standardizing both X and y means
// coefficients are already in comparable, standardized units and the data is
// zero-mean, so no separate intercept term is needed.
export function ridgeRegression(
  X: number[][],
  y: number[],
  lambda: number
): { coefficients: number[]; rSquared: number } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  if (n === 0 || d === 0) return { coefficients: [], rSquared: 0 };

  const columns = Array.from({ length: d }, (_, j) => standardize(X.map(row => row[j])));
  const Xz = X.map((_, i) => columns.map(c => c[i]));
  const yz = standardize(y);

  const Xt = transpose(Xz);
  const XtX = matMul(Xt, Xz);
  for (let i = 0; i < d; i++) XtX[i][i] += lambda;
  const XtXinv = invertMatrix(XtX);
  const Xty = matVecMul(Xt, yz);
  const coefficients = matVecMul(XtXinv, Xty);

  const yPred = Xz.map(row => row.reduce((s, v, i) => s + v * coefficients[i], 0));
  const ssRes = yz.reduce((s, v, i) => s + (v - yPred[i]) ** 2, 0);
  const ssTot = yz.reduce((s, v) => s + v * v, 0); // yz is already zero-mean (standardized)
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { coefficients, rSquared };
}

// Deterministic PRNG (mulberry32) — seeded init so k-means gives the same
// result run-to-run for the same dataset, unlike Math.random().
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function kMeans(
  points: number[][],
  k: number,
  seed = 42
): { assignments: number[]; centroids: number[][] } {
  const n = points.length;
  if (n === 0 || k <= 0) return { assignments: [], centroids: [] };
  const d = points[0].length;
  const rand = mulberry32(seed);

  const columns = Array.from({ length: d }, (_, j) => standardize(points.map(p => p[j])));
  const Z = points.map((_, i) => columns.map(c => c[i]));

  const indices = [...Array(n).keys()];
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  let centroids = indices.slice(0, Math.min(k, n)).map(i => Z[i]);

  const assignments = new Array(n).fill(0);
  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const dist = Z[i].reduce((s, v, j) => s + (v - centroids[c][j]) ** 2, 0);
        if (dist < bestDist) { bestDist = dist; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }

    const newCentroids = Array.from({ length: centroids.length }, () => new Array(d).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      counts[assignments[i]]++;
      for (let j = 0; j < d; j++) newCentroids[assignments[i]][j] += Z[i][j];
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) { newCentroids[c] = centroids[c]; continue; } // keep stale centroid rather than NaN-ing an empty cluster
      for (let j = 0; j < d; j++) newCentroids[c][j] /= counts[c];
    }
    centroids = newCentroids;
    if (!changed) break;
  }

  return { assignments, centroids };
}
