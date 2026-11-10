/**
 * Batch order selection as a QUBO (Quadratic Unconstrained Binary Optimization), the problem
 * class QMS miners solve with proof-of-useful-work.
 *
 * Decision: x_i = 1 if order i is cleared in this batch, 0 if it waits for the next one.
 *
 *   minimize  E(x) = - rho * sum_i v_i x_i  +  ( sum_i d_i v_i x_i )^2
 *
 *   v_i  order size in token-A units, divided by the pool's token-A reserve (dimensionless)
 *   d_i  +1 if the order sells A, -1 if it sells B
 *   rho  value of executing now rather than waiting (urgency)
 *
 * The squared term is the price-impact cost of routing the batch's net imbalance through a
 * constant-product pool: moving a fraction f of the reserve costs about f^2 of the reserve's
 * value. Opposite orders cancel inside the square, so the solver is rewarded for clearing
 * buyers and sellers together, and only defers an order when it is large relative to the pool
 * and nobody is on the other side.
 *
 * As a QUBO with symmetric Q: E(x) = sum_i Q_ii x_i + sum_{i != j} Q_ij x_i x_j, where
 *   Q_ii = -rho * v_i + v_i^2      Q_ij = d_i d_j v_i v_j
 */

export interface QuboItem {
  /** size in token-A units divided by the token-A pool reserve */
  v: number;
  /** +1 sells token A, -1 sells token B */
  d: 1 | -1;
}

export type Qubo = number[][];

export function buildQubo(items: QuboItem[], rho: number): Qubo {
  const n = items.length;
  const Q: Qubo = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const a = items[i]!;
    Q[i]![i] = -rho * a.v + a.v * a.v;
    for (let j = i + 1; j < n; j++) {
      const b = items[j]!;
      const q = a.d * b.d * a.v * b.v;
      Q[i]![j] = q;
      Q[j]![i] = q;
    }
  }
  return Q;
}

export function energy(Q: Qubo, x: number[]): number {
  let e = 0;
  for (let i = 0; i < x.length; i++) {
    if (!x[i]) continue;
    e += Q[i]![i]!;
    for (let j = 0; j < x.length; j++) if (j !== i && x[j]) e += Q[i]![j]!;
  }
  return e;
}

/** Exact solution by enumeration. Fine up to ~20 orders; used to validate the annealer. */
export function solveExact(Q: Qubo): number[] {
  const n = Q.length;
  if (n > 22) throw new Error('too many variables for exact solve');
  let best: number[] = new Array(n).fill(0);
  let bestE = 0;
  for (let mask = 1; mask < 1 << n; mask++) {
    const x = Array.from({ length: n }, (_, i) => (mask >> i) & 1);
    const e = energy(Q, x);
    if (e < bestE - 1e-15) {
      bestE = e;
      best = x;
    }
  }
  return best;
}

/** Deterministic pseudo-random generator so a batch's solution is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulated annealing with single-bit flips, the same family of heuristics QMS miners run.
 * Keeps the best state seen; restarts from several seeds.
 */
export function solveAnneal(Q: Qubo, opts: { sweeps?: number; restarts?: number; seed?: number } = {}): number[] {
  const n = Q.length;
  if (n === 0) return [];
  const sweeps = opts.sweeps ?? 400;
  const restarts = opts.restarts ?? 8;
  const rand = mulberry32(opts.seed ?? 0x51a1b2e);

  let scale = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) scale = Math.max(scale, Math.abs(Q[i]![j]!));
  if (scale === 0) return new Array(n).fill(0);
  const tHot = scale * 2;
  const tCold = scale * 1e-4;

  let best: number[] = new Array(n).fill(0);
  let bestE = 0;
  for (let r = 0; r < restarts; r++) {
    const x = Array.from({ length: n }, () => (rand() < 0.5 ? 1 : 0));
    let e = energy(Q, x);
    for (let s = 0; s < sweeps; s++) {
      const t = tHot * Math.pow(tCold / tHot, s / Math.max(1, sweeps - 1));
      for (let i = 0; i < n; i++) {
        // Energy change of flipping bit i.
        let field = Q[i]![i]!;
        for (let j = 0; j < n; j++) if (j !== i && x[j]) field += 2 * Q[i]![j]!;
        const delta = x[i] ? -field : field;
        if (delta <= 0 || rand() < Math.exp(-delta / t)) {
          x[i] = x[i] ? 0 : 1;
          e += delta;
        }
      }
      if (e < bestE - 1e-15) {
        bestE = e;
        best = [...x];
      }
    }
  }
  return best;
}

/**
 * Matrix Market "coordinate real symmetric" text, the format the QMS explorer publishes for the
 * QUBO instances miners solve (stored lower triangle, 1-indexed).
 */
export function toMatrixMarket(Q: Qubo, comment = 'Qalibre batch order selection'): string {
  const n = Q.length;
  const entries: string[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const q = Q[i]![j]!;
      if (q !== 0) entries.push(`${i + 1} ${j + 1} ${q.toExponential(12)}`);
    }
  }
  return ['%%MatrixMarket matrix coordinate real symmetric', `% ${comment}`, `${n} ${n} ${entries.length}`, ...entries, ''].join('\n');
}
