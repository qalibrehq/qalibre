import { describe, expect, it } from 'vitest';
import { getAmountOut } from '../src/amm.js';
import { buildQubo, energy, solveAnneal, solveExact, toMatrixMarket } from '../src/qubo.js';
import { clearPair, PRICE_ONE, type PairOrder } from '../src/clearing.js';

const E18 = 10n ** 18n;
// Live QWAP WQMS/USDC reserves observed on 2026-11-10 (WQMS 18 dp, USDC 6 dp; WQMS < USDC by address).
const RES = { a: 102_128_135_662_280_163_548_951n, b: 196_160_136_428n };
const FEES = { feeBps: 20n, surplusShareBps: 2_000n };

describe('amm', () => {
  it('matches the 0.3% Uniswap V2 formula', () => {
    // Same probe used against the live router: 10_000 in, 1e9/1e9 reserves -> 9969.
    expect(getAmountOut(10_000n, 1_000_000_000n, 1_000_000_000n)).toBe(9969n);
  });
});

describe('qubo', () => {
  it('annealing finds the exact optimum on small random batches', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 25; trial++) {
      const n = 3 + Math.floor(rnd() * 9);
      const items = Array.from({ length: n }, () => ({ v: rnd() * 0.05, d: (rnd() < 0.5 ? 1 : -1) as 1 | -1 }));
      const Q = buildQubo(items, 0.02);
      const exact = energy(Q, solveExact(Q));
      const annealed = energy(Q, solveAnneal(Q, { seed: trial + 1 }));
      expect(annealed).toBeCloseTo(exact, 12);
    }
  });

  it('clears opposite orders together and defers a huge one-sided order', () => {
    // Two small opposite orders plus one order worth 10% of the pool with no counterparty.
    const Q = buildQubo([{ v: 0.001, d: 1 }, { v: 0.001, d: -1 }, { v: 0.1, d: 1 }], 0.02);
    expect(solveExact(Q)).toEqual([1, 1, 0]);
  });

  it('writes Matrix Market symmetric format', () => {
    const mm = toMatrixMarket(buildQubo([{ v: 0.5, d: 1 }, { v: 0.25, d: -1 }], 0.1));
    const lines = mm.trim().split('\n');
    expect(lines[0]).toBe('%%MatrixMarket matrix coordinate real symmetric');
    expect(lines[2]).toBe('2 2 3');
  });
});

describe('clearing', () => {
  const order = (id: string, sellsA: boolean, sellAmount: bigint): PairOrder => ({ id, sellsA, sellAmount, minBuyAmount: 0n });

  it('a lone order gets exactly the direct price and pays no fee', () => {
    const c = clearPair([order('a', true, 10n * E18)], RES, FEES)!;
    const f = c.fills[0]!;
    expect(f.gross).toBe(f.direct);
    expect(f.fee).toBe(0n);
    expect(c.swap?.amountIn).toBe(10n * E18);
  });

  it('a smaller same-side seller who would do worse than direct is held back, not harmed', () => {
    // Carol sells the same side as Alice; the shared price impact would leave her below her solo quote.
    const orders = [order('alice', true, 50n * E18), order('carol', true, 20n * E18), order('bob', false, 60_000_000n), order('dave', false, 30_000_000n)];
    const c = clearPair(orders, RES, FEES)!;
    expect(c.dropped.map((d) => d.id)).toEqual(['carol']);
    for (const f of c.fills) expect(f.net).toBeGreaterThanOrEqual(f.direct);
  });

  it('matched traders on both sides beat swapping directly, and the books balance', () => {
    const orders = [order('alice', true, 50n * E18), order('carol', true, 20n * E18), order('bob', false, 80_000_000n), order('dave', false, 40_000_000n)];
    const c = clearPair(orders, RES, FEES)!;
    expect(c.fills).toHaveLength(4);
    for (const f of c.fills) {
      expect(f.net).toBeGreaterThanOrEqual(f.direct);
      expect(f.fee * 10_000n).toBeLessThanOrEqual(f.gross * 20n);
    }
    // Conservation: what A-sellers give minus what B-sellers take is exactly the AMM input.
    const sa = 70n * E18;
    const ga = c.fills.filter((f) => f.id === 'bob' || f.id === 'dave').reduce((s, f) => s + f.gross, 0n);
    expect(c.swap?.sellsA).toBe(true);
    expect(c.swap?.amountIn).toBe(sa - ga);
    expect(c.r).toBeGreaterThan(0n);
    expect(c.r * 100n).toBeGreaterThan(((RES.b * PRICE_ONE) / RES.a) * 99n);
  });

  it('respects limit prices by dropping the order that cannot be met', () => {
    const orders: PairOrder[] = [
      { id: 'greedy', sellsA: true, sellAmount: 10n * E18, minBuyAmount: 100_000_000n }, // asks ~5x market
      order('ok', true, 10n * E18),
    ];
    const c = clearPair(orders, RES, FEES)!;
    expect(c.fills.map((f) => f.id)).toEqual(['ok']);
    expect(c.dropped[0]?.id).toBe('greedy');
  });
});
