/**
 * Valuing amounts from a filled order in QMS, at that order's own fill price.
 *
 * One definition used everywhere (savings shown to users, the public savings counter, referral rewards),
 * so the numbers always agree. Every pair has QMS on one side, so the fill itself gives an exact rate:
 * the QMS paid (or received) divided by the gross amount of the other token.
 */
import { TOKENS } from './config.js';
import type { OrderRow } from './db.js';

const WQMS = TOKENS.WQMS.toLowerCase();

/** Gross amount of the buy token the order received before fees (what the batch price paid out). */
function gross(o: OrderRow): bigint {
  return BigInt(o.buy_amount ?? '0') + BigInt(o.fee ?? '0') + BigInt(o.network_fee ?? '0');
}

/** The QMS value, at this order's fill price, of `amount` units of the order's buy token. */
export function buyTokenInQms(o: OrderRow, amount: bigint): bigint {
  if (o.buy_token.toLowerCase() === WQMS) return amount;
  if (o.sell_token.toLowerCase() === WQMS) {
    const g = gross(o);
    return g > 0n ? (amount * BigInt(o.sell_amount)) / g : 0n;
  }
  return 0n; // no pair without QMS exists today; never invent a value
}

/**
 * What the user gained over a direct QWAP swap, in the buy token. The comparison is before the at-cost network
 * fee (a direct swap pays its own gas too), matching the fill message. Never negative: the contract guarantees
 * the batch pays at least the direct price.
 */
export function improvement(o: OrderRow): bigint {
  if (o.status !== 'filled' || !o.direct_quote) return 0n;
  const d = BigInt(o.buy_amount ?? '0') + BigInt(o.network_fee ?? '0') - BigInt(o.direct_quote);
  return d > 0n ? d : 0n;
}

export const savedQms = (o: OrderRow) => buyTokenInQms(o, improvement(o));
export const feeQms = (o: OrderRow) => buyTokenInQms(o, BigInt(o.fee ?? '0'));
