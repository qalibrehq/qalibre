import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { readReserves } from '../src/chain.js';

/** A fake client exposing one pair whose token0 is `token0` with reserves (r0, r1). */
function fake(token0: string, r0: bigint, r1: bigint): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'factory') return '0x00000000000000000000000000000000000000fa';
      if (functionName === 'getPair') return '0x00000000000000000000000000000000000000aa';
      if (functionName === 'getReserves') return [r0, r1, 0];
      if (functionName === 'token0') return token0;
      throw new Error(functionName);
    },
    getBlockNumber: async () => 1n,
  } as unknown as PublicClient;
}

const LOW = '0x1000000000000000000000000000000000000001';
const HIGH = '0x9000000000000000000000000000000000000009';

describe('readReserves orientation (regression: a pool once read as $16.9M instead of $3)', () => {
  it('a is the reserve of the FIRST argument, whatever the address order', async () => {
    const c = fake(LOW, 111n, 999n); // token0 = LOW holds 111
    const ab = await readReserves(c, '0x0000000000000000000000000000000000000001', LOW, HIGH);
    expect([ab.a, ab.b]).toEqual([111n, 999n]);
    const ba = await readReserves(c, '0x0000000000000000000000000000000000000001', HIGH, LOW);
    expect([ba.a, ba.b]).toEqual([999n, 111n]);
  });
});
