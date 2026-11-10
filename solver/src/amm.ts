/**
 * Constant-product AMM math, identical to QwapRouter (a Uniswap V2 Router02 fork, 0.3% fee).
 * Kept bit-exact with the on-chain library so our "direct swap" quotes equal what the
 * settlement contract computes through the adapter.
 */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('INSUFFICIENT_LIQUIDITY');
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

export interface Reserves {
  /** reserve of the batch's token A (the lower address) */
  a: bigint;
  /** reserve of the batch's token B (the higher address) */
  b: bigint;
}
