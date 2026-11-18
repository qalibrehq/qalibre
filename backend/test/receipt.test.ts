import { describe, expect, it } from 'vitest';
import { salePnlPct, settledSecs } from '../src/receipt.js';
import type { OrderRow } from '../src/db.js';

const W = '0x00000000000000000000000000000000000000aa';
const T = '0x00000000000000000000000000000000000000bb';
let t = 0;
const row = (sell: string, buy: string, sellAmt: bigint, buyAmt: bigint, status = 'filled'): OrderRow =>
  ({ id: `o${++t}`, tg_id: 1, sell_token: sell, buy_token: buy, sell_amount: sellAmt.toString(), buy_amount: buyAmt.toString(), status, created_at: t, created_ms: t * 1000 }) as unknown as OrderRow;

describe('salePnlPct', () => {
  it('is a gain when selling for more than the cost', () => {
    const buy = row(W, T, 100n, 1000n);
    const sale = row(T, W, 1000n, 150n);
    expect(salePnlPct([buy, sale], sale, W)).toBe(50);
  });
  it('is a loss when selling for less', () => {
    const buy = row(W, T, 100n, 1000n);
    const sale = row(T, W, 500n, 30n);
    expect(salePnlPct([buy, sale], sale, W)).toBe(-40);
  });
  it('uses average cost across several buys, and only the cost of what remains after earlier sales', () => {
    const a = row(W, T, 100n, 1000n); // 0.1 each
    const b = row(W, T, 300n, 1000n); // 0.3 each, average 0.2
    const s1 = row(T, W, 1000n, 200n); // break even
    const s2 = row(T, W, 1000n, 100n); // remaining cost 200, sells for 100
    expect(salePnlPct([a, b, s1, s2], s1, W)).toBe(0);
    expect(salePnlPct([a, b, s1, s2], s2, W)).toBe(-50);
  });
  it('counts only the part of a sale with a known cost', () => {
    const buy = row(W, T, 100n, 1000n);
    const sale = row(T, W, 2000n, 400n); // half came from outside: 200 proceeds on the known half
    expect(salePnlPct([buy, sale], sale, W)).toBe(100);
  });
  it('is null when nothing was bought through Qalibre, and ignores unfilled orders', () => {
    const failed = row(W, T, 100n, 1000n, 'failed');
    const sale = row(T, W, 1000n, 150n);
    expect(salePnlPct([failed, sale], sale, W)).toBeNull();
  });
});

describe('settledSecs', () => {
  it('rounds to whole seconds, at least one', () => {
    expect(settledSecs({ created_ms: 1_000 } as OrderRow, 10_400)).toBe(9);
    expect(settledSecs({ created_ms: 1_000 } as OrderRow, 1_100)).toBe(1);
    expect(settledSecs({ created_ms: null } as OrderRow)).toBeNull();
  });
});
