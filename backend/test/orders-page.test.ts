import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';

describe('paged order history', () => {
  it('walks every order exactly once, newest first, even when many share the same second', () => {
    const db = openDb(':memory:');
    const ids: string[] = [];
    for (let i = 0; i < 47; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      ids.push(id);
      db.insertOrder({ id, tg_id: 1, account: '0x1', sell_token: '0xa', buy_token: '0xb', sell_amount: '1', min_buy_amount: '0', max_network_fee: '0', valid_to: 0, nonce: String(i), signature: '0x', mode: 'instant' });
    }
    // Force ties: ten orders per second.
    for (let i = 0; i < 47; i++) db.raw.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(1_000 + Math.floor(i / 10), ids[i]!);
    db.insertOrder({ id: '11111111-0000-4000-8000-000000000000', tg_id: 2, account: '0x2', sell_token: '0xa', buy_token: '0xb', sell_amount: '1', min_buy_amount: '0', max_network_fee: '0', valid_to: 0, nonce: 'x', signature: '0x', mode: 'instant' });

    const seen: string[] = [];
    let page = db.userOrdersPage(1, 20);
    while (page.length) {
      seen.push(...page.map((o) => o.id));
      const last = page[page.length - 1]!;
      page = db.userOrdersPage(1, 20, { at: last.created_at, id: last.id });
    }
    expect(seen.length).toBe(47);
    expect(new Set(seen).size).toBe(47); // no repeats
    expect(seen).not.toContain('11111111-0000-4000-8000-000000000000'); // never another user's orders
    const times = seen.map((id) => (db.getOrder(id)!.created_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times); // newest first
  });
});
