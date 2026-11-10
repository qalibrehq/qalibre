/**
 * Uniform clearing price for one token pair, plus the leftover to route through QWAP.
 *
 * Mirrors QalibreSettlement exactly:
 *   tokens = [A, B] with A < B, prices = [r, PRICE_ONE]
 *   an A-seller gets  gross = sellA * r / PRICE_ONE       (in B)
 *   a  B-seller gets  gross = sellB * PRICE_ONE / r       (in A)
 *   fee = gross * feeBps / 1e4, or, when a direct quote exists,
 *         min(that, (gross - direct) * surplusShareBps / 1e4) and gross must be >= direct
 *   net = gross - fee >= minBuyAmount
 *   after the AMM leg, leftover per token <= owed * 1bp + number of trades
 */
import { getAmountOut, type Reserves } from './amm.js';

// Prices are a ratio; a 1e36 scale gives sub-wei resolution even for 6-decimal tokens.
export const PRICE_ONE = 10n ** 36n;
const BPS = 10_000n;

export interface PairOrder {
  id: string;
  /** true: sells token A for B. false: sells token B for A. */
  sellsA: boolean;
  sellAmount: bigint;
  minBuyAmount: bigint;
}

export interface Fill {
  id: string;
  gross: bigint;
  fee: bigint;
  net: bigint;
  /** what the order would have received swapping alone on QWAP, at pre-batch reserves */
  direct: bigint;
}

export interface Clearing {
  /** price of A in B units, scaled by PRICE_ONE (prices = [r, PRICE_ONE]) */
  r: bigint;
  fills: Fill[];
  /** the AMM leg, if any */
  swap: { sellsA: boolean; amountIn: bigint; minAmountOut: bigint } | null;
  /** orders removed because they could not be filled at a valid price */
  dropped: { id: string; reason: string }[];
}

export interface FeeConfig {
  feeBps: bigint;
  surplusShareBps: bigint;
}

function sum(xs: bigint[]): bigint {
  return xs.reduce((a, b) => a + b, 0n);
}

interface Legs {
  ga: bigint; // total A owed to B-sellers
  gb: bigint; // total B owed to A-sellers
  swap: Clearing['swap'];
  slack: bigint; // >= 0 means feasible
}

function legs(r: bigint, aSells: bigint[], bSells: bigint[], res: Reserves): Legs {
  const sa = sum(aSells);
  const sb = sum(bSells);
  const gb = sum(aSells.map((s) => (s * r) / PRICE_ONE));
  const ga = sum(bSells.map((s) => (s * PRICE_ONE) / r));
  if (sa >= ga) {
    // Net seller of A: swap the excess A for B.
    const excess = sa - ga;
    const out = getAmountOut(excess, res.a, res.b);
    const need = gb > sb ? gb - sb : 0n;
    return { ga, gb, swap: excess > 0n ? { sellsA: true, amountIn: excess, minAmountOut: need } : null, slack: sb + out - gb };
  }
  // Net seller of B: swap the excess B for A.
  const excessB = sb - gb;
  if (excessB < 0n) return { ga, gb, swap: null, slack: -1n };
  const out = getAmountOut(excessB, res.b, res.a);
  const need = ga - sa;
  return { ga, gb, swap: excessB > 0n ? { sellsA: false, amountIn: excessB, minAmountOut: need } : null, slack: sa + out - ga };
}

/**
 * Find the uniform price at which the batch balances. Returns null when no feasible price exists
 * (for example, only B-sellers and an empty pool).
 */
export function findPrice(aSells: bigint[], bSells: bigint[], res: Reserves): bigint | null {
  const sa = sum(aSells);
  const sb = sum(bSells);
  if (sa === 0n && sb === 0n) return null;
  const spot = (res.b * PRICE_ONE) / res.a;
  // Decide the regime at spot: is the batch a net seller of A or of B?
  const netSellsA = sa * spot >= sb * PRICE_ONE;

  // r0 is the price at which the two sides balance exactly with no AMM leg (ga == sa, gb == sb).
  // The search must stay on one side of it, or the AMM leg would flip direction mid-search.
  const r0 = sa > 0n ? (sb * PRICE_ONE + sa - 1n) / sa : null;
  let lo: bigint;
  let hi: bigint;
  if (netSellsA) {
    lo = r0 !== null && r0 > 0n ? r0 : 1n; // feasible end
    hi = spot * 4n + 1n;
  } else {
    lo = spot / 4n > 0n ? spot / 4n : 1n;
    hi = r0 !== null ? r0 : spot * 4n + 1n; // feasible end
  }
  if (lo >= hi) return legs(lo, aSells, bSells, res).slack >= 0n ? lo : null;
  for (let i = 0; i < 256 && lo + 1n < hi; i++) {
    const mid = (lo + hi) / 2n;
    const l = legs(mid, aSells, bSells, res);
    if (netSellsA) {
      // Higher r pays A-sellers more; take the largest feasible r.
      if (l.slack >= 0n) lo = mid;
      else hi = mid;
    } else {
      // Lower r pays B-sellers more; take the smallest feasible r.
      if (l.slack >= 0n) hi = mid;
      else lo = mid;
    }
  }
  const r = netSellsA ? lo : hi;
  return legs(r, aSells, bSells, res).slack >= 0n ? r : null;
}

function feeFor(gross: bigint, direct: bigint | null, fees: FeeConfig): { fee: bigint; ok: boolean } {
  let fee = (gross * fees.feeBps) / BPS;
  if (direct !== null) {
    if (gross < direct) return { fee: 0n, ok: false };
    const surplusFee = ((gross - direct) * fees.surplusShareBps) / BPS;
    if (surplusFee < fee) fee = surplusFee;
  }
  return { fee, ok: true };
}

/**
 * Clear a set of orders on one pair. Orders that would violate their limit or end up worse than a
 * direct QWAP swap are dropped, and the price is recomputed until every remaining order is valid.
 */
export function clearPair(orders: PairOrder[], res: Reserves, fees: FeeConfig): Clearing | null {
  let live = [...orders];
  const dropped: Clearing['dropped'] = [];
  for (let round = 0; round < orders.length + 1 && live.length > 0; round++) {
    const aSells = live.filter((o) => o.sellsA).map((o) => o.sellAmount);
    const bSells = live.filter((o) => !o.sellsA).map((o) => o.sellAmount);
    const r = findPrice(aSells, bSells, res);
    if (r === null) {
      for (const o of live) dropped.push({ id: o.id, reason: 'no feasible price' });
      return null;
    }
    const fills: Fill[] = [];
    const bad: { id: string; reason: string }[] = [];
    for (const o of live) {
      const gross = o.sellsA ? (o.sellAmount * r) / PRICE_ONE : (o.sellAmount * PRICE_ONE) / r;
      const direct = o.sellsA ? getAmountOut(o.sellAmount, res.a, res.b) : getAmountOut(o.sellAmount, res.b, res.a);
      const { fee, ok } = feeFor(gross, direct, fees);
      if (!ok) {
        bad.push({ id: o.id, reason: 'worse than direct swap' });
        continue;
      }
      const net = gross - fee;
      if (net < o.minBuyAmount) {
        bad.push({ id: o.id, reason: 'below limit price' });
        continue;
      }
      fills.push({ id: o.id, gross, fee, net, direct });
    }
    if (bad.length === 0) {
      return { r, fills, swap: legs(r, aSells, bSells, res).swap, dropped };
    }
    // Remove one offender at a time (the largest), since removing it changes the price for the rest.
    const sizes = new Map(live.map((o) => [o.id, o.sellAmount]));
    const worst = bad.reduce((w, b) => ((sizes.get(b.id) ?? 0n) > (sizes.get(w.id) ?? 0n) ? b : w));
    dropped.push(worst);
    live = live.filter((o) => o.id !== worst.id);
  }
  return null;
}
