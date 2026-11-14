import { describe, expect, it } from 'vitest';
import type { Address, Hex, PublicClient } from 'viem';
import { planBatch, localOptimizer } from '../src/solver.js';
import { buildQubo } from '../src/qubo.js';
import { getAmountOut } from '../src/amm.js';
import type { Deployment } from '../src/chain.js';

// Regression: a lone order larger than 2% of the pool (QUBO_RHO) was never selected by the QUBO and sat pending
// until it expired, with nothing logged. Seen live with a 0.1 QMS buy into a 4.5 QMS pool (2.2%).
const A = '0x1000000000000000000000000000000000000001' as Address; // sorts first: the QMS side here
const B = '0x9000000000000000000000000000000000000009' as Address;
const RA = 4_500_000_000_000_000_000n; // 4.5 A
const RB = 990_000n * 10n ** 18n; // 990,000 B

function fakeClient(): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'factory') return '0x00000000000000000000000000000000000000fa';
      if (functionName === 'getPair') return '0x00000000000000000000000000000000000000aa';
      if (functionName === 'getReserves') return [RA, RB, 0];
      if (functionName === 'token0') return A;
      throw new Error(functionName);
    },
    getBlockNumber: async () => 1n,
  } as unknown as PublicClient;
}

const dep = { settlement: '0x00000000000000000000000000000000000000c0', qwapRouter: '0x00000000000000000000000000000000000000d0', qwapAdapter: '0x00000000000000000000000000000000000000e0' } as unknown as Deployment;
const fees = { feeBps: 20n, surplusShareBps: 2_000n };

function order(id: string, sellAmount: bigint) {
  const direct = getAmountOut(sellAmount, RA, RB);
  return {
    id,
    signature: '0x' as Hex,
    order: { account: '0x00000000000000000000000000000000000000ac' as Address, sellToken: A, buyToken: B, sellAmount, minBuyAmount: (direct * 9_900n) / 10_000n, maxNetworkFee: 1n, validTo: 9_999_999_999n, nonce: 1n },
  };
}

describe('planBatch with a lone order larger than RHO of the pool', () => {
  const big = order('big', 100_000_000_000_000_000n); // 0.1 A = 2.2% of the pool

  it('the QUBO alone would not select it (why the bug happened)', async () => {
    const qubo = buildQubo([{ v: 0.1 / 4.5, d: 1 }], 0.02);
    expect((await localOptimizer(qubo))[0]).toBe(0);
  });

  it('still gets a plan that fills it against the pool', async () => {
    const plan = await planBatch(fakeClient(), dep, [big], fees);
    expect(plan).not.toBeNull();
    expect(plan!.clearing.fills.map((f) => f.id)).toEqual(['big']);
  });

  it('small orders are unaffected', async () => {
    const plan = await planBatch(fakeClient(), dep, [order('small', 10_000_000_000_000_000n)], fees);
    expect(plan!.clearing.fills.map((f) => f.id)).toEqual(['small']);
  });
});
