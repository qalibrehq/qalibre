import { describe, expect, it } from 'vitest';
import { openDb, type OrderRow } from '../src/db.js';
import { TOKENS } from '../src/config.js';
import { buyTokenInQms, feeQms, improvement, savedQms } from '../src/value.js';

const DOG = '0xb3b3426CDc928377e8221f9DB75CF3Fdd26a3763';
const e18 = 10n ** 18n;

function order(o: Partial<OrderRow>): OrderRow {
  return {
    id: 'o1', tg_id: 1, account: '0x', sell_token: TOKENS.WQMS, buy_token: DOG, sell_amount: String(e18), min_buy_amount: '0', max_network_fee: '0',
    network_fee: '0', valid_to: 0, nonce: '0', signature: '0x', status: 'filled', mode: 'instant', created_ms: 0, confirmed: 1, reason: null,
    tx_hash: '0x', buy_amount: '0', fee: '0', direct_quote: '0', batch_id: 1, created_at: 0, updated_at: 0, status_msg_id: null, agent_key_id: null, ...o,
  };
}

describe('valuing a fill in QMS', () => {
  it('values buy-token amounts at the fill price, not a guess', () => {
    // Paid 1 QMS, received 1,000 DOG gross (990 net + 10 fee): 1 DOG = 0.001 QMS.
    const o = order({ buy_amount: String(990n * e18), fee: String(10n * e18), direct_quote: String(980n * e18) });
    expect(buyTokenInQms(o, 10n * e18)).toBe(e18 / 100n);
    expect(feeQms(o)).toBe(e18 / 100n);
    // Improvement: 990 - 980 = 10 DOG = 0.01 QMS.
    expect(improvement(o)).toBe(10n * e18);
    expect(savedQms(o)).toBe(e18 / 100n);
  });
  it('counts a QMS payout directly', () => {
    const o = order({ sell_token: DOG, buy_token: TOKENS.WQMS, sell_amount: String(1000n * e18), buy_amount: String(e18), direct_quote: String(e18 - 10n ** 15n) });
    expect(savedQms(o)).toBe(10n ** 15n);
  });
  it('never reports negative savings, and ignores unfilled orders', () => {
    expect(improvement(order({ buy_amount: '100', direct_quote: '200' }))).toBe(0n);
    expect(improvement(order({ status: 'expired', buy_amount: '300', direct_quote: '200' }))).toBe(0n);
  });
  it('compares before the at-cost network fee, like the receipt', () => {
    const o = order({ buy_amount: '995', network_fee: '10', direct_quote: '1000' });
    expect(improvement(o)).toBe(5n);
  });
});

describe('referrals', () => {
  it('attach once, never to yourself, never after a wallet exists', () => {
    const db = openDb(':memory:');
    for (const id of [1, 2, 3]) db.upsertUser(id, null);
    const code = db.refCode(1, () => 'abc123');
    expect(db.refCode(1, () => 'other')).toBe(code); // stable
    expect(db.userByRefCode(code)?.tg_id).toBe(1);
    expect(db.setReferrer(1, 1)).toBe(false); // self
    expect(db.setReferrer(2, 1)).toBe(true);
    expect(db.setReferrer(2, 3)).toBe(false); // already has an inviter
    db.setAccount(3, '0xabc', '0xdef', '0xfac');
    expect(db.setReferrer(3, 1)).toBe(false); // existing wallet: not an invite
  });
  it('rewards are paid exactly once', () => {
    const db = openDb(':memory:');
    db.upsertUser(1, null);
    db.addReward({ orderId: 'a', referrer: 1, referee: 2, amountQms: '100' });
    db.addReward({ orderId: 'a', referrer: 1, referee: 2, amountQms: '100' }); // same fill again: ignored
    db.addReward({ orderId: 'b', referrer: 1, referee: 2, amountQms: '50' });
    const due = db.unpaidRewards();
    expect(due).toHaveLength(1);
    expect(due[0]!.total).toBe('150');
    db.markRewardsPaid(due[0]!.ids.split(','), '0xtx');
    expect(db.unpaidRewards()).toHaveLength(0);
    expect(db.referralStats(1)).toMatchObject({ earned: 150n, paid: 150n });
  });
  it('group alerts repeat only after the quiet period', () => {
    const db = openDb(':memory:');
    expect(db.alertSeen(-100, DOG, 3600)).toBe(false);
    expect(db.alertSeen(-100, DOG.toUpperCase(), 3600)).toBe(true);
    expect(db.alertSeen(-200, DOG, 3600)).toBe(false); // another group
  });
});
