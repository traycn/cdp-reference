/**
 * L2-penalized logistic regression by Newton's method (IRLS), with an optional
 * non-negativity rule: coefficients that come out negative are fixed at 0 and the
 * rest refit, until none is negative (docs/plans/m5-lead-scoring.md, Fitting).
 * The intercept is not penalized and may be negative.
 */

export interface LogisticFit {
  intercept: number;
  coef: number[];
  /** Indexes fixed at 0 because they fit negative. */
  zeroed: number[];
  iterations: number;
}

/** Solves A x = b by Gaussian elimination with partial pivoting (A is small and dense). */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[pivot]![c]!)) pivot = r;
    if (Math.abs(m[pivot]![c]!) < 1e-300) throw new Error("singular system");
    [m[c], m[pivot]] = [m[pivot]!, m[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= m[r]![k]! * x[k]!;
    x[r] = s / m[r]![r]!;
  }
  return x;
}

/** One penalized fit over the `active` columns; inactive columns stay 0. */
function fitActive(
  X: readonly (readonly number[])[],
  y: readonly boolean[],
  lambda: number,
  active: readonly boolean[],
): { intercept: number; coef: number[]; iterations: number } {
  const cols = active.flatMap((a, j) => (a ? [j] : []));
  const k = cols.length + 1; // intercept first
  let beta = new Array<number>(k).fill(0);
  for (let it = 1; it <= 100; it++) {
    const grad = new Array<number>(k).fill(0);
    const hess = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const row = X[i]!;
      const x = [1, ...cols.map((j) => row[j]!)];
      let z = 0;
      for (let a = 0; a < k; a++) z += beta[a]! * x[a]!;
      const p = 1 / (1 + Math.exp(-z));
      const w = p * (1 - p);
      const r = (y[i] ? 1 : 0) - p;
      for (let a = 0; a < k; a++) {
        grad[a]! += r * x[a]!;
        for (let b = 0; b <= a; b++) hess[a]![b]! += w * x[a]! * x[b]!;
      }
    }
    for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) hess[b]![a] = hess[a]![b]!;
    for (let a = 1; a < k; a++) {
      grad[a]! -= lambda * beta[a]!;
      hess[a]![a]! += lambda;
    }
    const step = solve(hess, grad);
    beta = beta.map((v, a) => v + step[a]!);
    if (Math.max(...step.map(Math.abs)) < 1e-10) {
      const coef = new Array<number>(active.length).fill(0);
      cols.forEach((j, a) => (coef[j] = beta[a + 1]!));
      return { intercept: beta[0]!, coef, iterations: it };
    }
  }
  throw new Error("logistic regression did not converge in 100 iterations");
}

export function fitLogistic(
  X: readonly (readonly number[])[],
  y: readonly boolean[],
  { lambda, nonNegative }: { lambda: number; nonNegative: boolean },
): LogisticFit {
  const width = X[0]?.length ?? 0;
  const active = new Array<boolean>(width).fill(true);
  for (;;) {
    const f = fitActive(X, y, lambda, active);
    const negative = nonNegative ? f.coef.flatMap((c, j) => (active[j] && c < 0 ? [j] : [])) : [];
    if (negative.length === 0) {
      const zeroed = active.flatMap((a, j) => (a ? [] : [j]));
      return { intercept: f.intercept, coef: f.coef, zeroed, iterations: f.iterations };
    }
    for (const j of negative) active[j] = false;
  }
}
