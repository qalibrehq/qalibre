/**
 * Live check: one bad order must not block other users.
 * Bob places a valid order; Alice's order is signed with a key that is no longer her trading key.
 * Expected: Alice's order is removed with a clear message, Bob's order settles.
 *
 *   npx tsx scripts/blocker-e2e.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { ROOT, TOKENS } from '../src/config.js';
import { QalibreAccountFactoryAbi } from '../../solver/src/abi/QalibreAccountFactory.js';
import { loadDeployment, publicClient, readReserves, signOrderAsSession, type Order } from '../../solver/src/chain.js';
import { getAmountOut } from '../../solver/src/amm.js';

const keys = JSON.parse(readFileSync(join(ROOT, 'solver', '.demo', 'keys.json'), 'utf8')) as Record<string, Hex>;
const dep = loadDeployment();
const client = publicClient();
const db = openDb(':memory:');
const messages: string[] = [];
const svc = createService(db, async (tg, html) => void messages.push(`[user ${tg}] ${html.replace(/<[^>]+>/g, '').replace(/\n/g, ' ')}`));

async function accountOf(pk: Hex): Promise<Address> {
  return client.readContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'getAddress', args: [privateKeyToAccount(pk).address, 0n] });
}

async function main() {
  const session = privateKeyToAccount(keys.session!); // still Bob's key; no longer Alice's (she rotated it)
  const [alice, bob] = await Promise.all([accountOf(keys.alice!), accountOf(keys.bob!)]);
  const res = await readReserves(client, dep.qwapRouter, TOKENS.WQMS, TOKENS.USDC);
  const wqmsIsA = TOKENS.WQMS.toLowerCase() < TOKENS.USDC.toLowerCase();
  const amount = 10n ** 16n; // 0.01 WQMS each
  const direct = wqmsIsA ? getAmountOut(amount, res.a, res.b) : getAmountOut(amount, res.b, res.a);
  const now = BigInt(Math.floor(Date.now() / 1000));

  for (const [tg, name, account] of [[1, 'Alice', alice], [2, 'Bob', bob]] as const) {
    db.upsertUser(tg, name);
    db.setAccount(tg, account, dep.settlement);
    const order: Order = { account, sellToken: TOKENS.WQMS, buyToken: TOKENS.USDC, sellAmount: amount, minBuyAmount: (direct * 99n) / 100n, maxNetworkFee: direct / 100n, validTo: now + 300n, nonce: BigInt(Date.now()) * 10n + BigInt(tg) };
    db.insertOrder({
      id: randomUUID(), tg_id: tg, account, sell_token: order.sellToken, buy_token: order.buyToken, sell_amount: amount.toString(),
      min_buy_amount: order.minBuyAmount.toString(), max_network_fee: order.maxNetworkFee.toString(), valid_to: Number(order.validTo),
      nonce: order.nonce.toString(), signature: await signOrderAsSession(session, dep.settlement, order), mode: 'instant',
    });
  }
  console.log('Two instant orders queued: Bob (valid) and Alice (signed with a revoked key).\n');
  await svc.runBatch();
  for (const o of db.pendingOrders().concat(...[1, 2].map((tg) => db.userOrders(tg)))) void o;
  for (const tg of [1, 2]) {
    const o = db.userOrders(tg)[0]!;
    console.log(`  ${tg === 1 ? 'Alice' : 'Bob  '} -> ${o.status.padEnd(7)} ${o.tx_hash ? 'https://testnet.qmsscan.io/tx/' + o.tx_hash : o.reason ?? ''}`);
  }
  console.log('\nMessages sent:');
  for (const m of messages) console.log('  ' + m);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
