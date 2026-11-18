import type { OrderRow } from './db.js';

/**
 * Profit or loss on a sell, against what those same tokens cost. The cost book is replayed from this user's
 * own fills, oldest first, up to (not including) the sale, with average cost: the same method Holdings uses.
 * Returns null when there is no known cost: tokens that came from outside Qalibre are never guessed at.
 */
export function salePnlPct(fills: OrderRow[], sale: OrderRow, wqms: string): number | null {
  const token = sale.sell_token.toLowerCase();
  let qty = 0n;
  let cost = 0n;
  const ordered = [...fills].filter((o) => o.status === 'filled').sort((a, b) => a.created_at - b.created_at || (a.created_ms ?? 0) - (b.created_ms ?? 0));
  for (const o of ordered) {
    if (o.id === sale.id) break;
    if (o.sell_token.toLowerCase() === wqms && o.buy_token.toLowerCase() === token) {
      qty += BigInt(o.buy_amount ?? '0');
      cost += BigInt(o.sell_amount);
    } else if (o.buy_token.toLowerCase() === wqms && o.sell_token.toLowerCase() === token && qty > 0n) {
      const sold = BigInt(o.sell_amount) < qty ? BigInt(o.sell_amount) : qty;
      cost -= (cost * sold) / qty;
      qty -= sold;
    }
  }
  if (qty === 0n || cost === 0n) return null;
  // Only the part of this sale with a known cost counts, and the proceeds are scaled to that part.
  const sold = BigInt(sale.sell_amount);
  const known = sold < qty ? sold : qty;
  const basis = (cost * known) / qty;
  const proceeds = (BigInt(sale.buy_amount ?? '0') * known) / sold;
  if (basis === 0n) return null;
  return Number(((proceeds - basis) * 10_000n) / basis) / 100;
}

/** Whole seconds from placing the order to settling it, or null when the start time is unknown. */
export function settledSecs(o: OrderRow, now = Date.now()): number | null {
  if (!o.created_ms) return null;
  return Math.max(1, Math.round((now - o.created_ms) / 1000));
}
