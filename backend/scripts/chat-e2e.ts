/**
 * Live end-to-end of chat trading on QMS testnet, through the same service the bot uses:
 *   1. a fresh trading key (owner-signed), 2. buying an unapproved token is refused with NeedsApproval,
 *   3. one-time approval (owner-signed, the exact call the Mini App sends), 4. buy QTDOG, 5. position with P&L,
 *   6. sell all, 7. honeypot and taxed tokens are refused before anything is signed.
 *
 *   npx tsx scripts/chat-e2e.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, formatUnits, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { openDb } from '../src/db.js';
import { createOwnerOps } from '../src/ownerops.js';
import { createService, NeedsApproval, UserError } from '../src/service.js';
import { ROOT, TOKENS } from '../src/config.js';
import { QalibreAccountAbi } from '../../solver/src/abi/QalibreAccount.js';
import { QalibreAccountFactoryAbi } from '../../solver/src/abi/QalibreAccountFactory.js';
import { erc20Abi, loadDeployment, publicClient } from '../../solver/src/chain.js';

const keys = JSON.parse(readFileSync(join(ROOT, 'solver', '.demo', 'keys.json'), 'utf8')) as Record<string, Hex>;
const tt = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', '19480-testtokens.json'), 'utf8')) as Record<string, Address>;
const owner = privateKeyToAccount(keys.alice!);
const dep = loadDeployment();
const client = publicClient();
const db = openDb(':memory:');
const ops = createOwnerOps(db);
const TG = 1;
const MAX = 2n ** 128n - 1n;

const notes: { html: string; kind?: string }[] = [];
const svc = createService(db, async (_id, html, ctx) => {
  notes.push({ html, kind: ctx?.kind });
});

function fromWire(w: Record<string, string>): UserOperation<'0.7'> {
  const big = ['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'];
  const o: Record<string, unknown> = { ...w };
  for (const k of big) o[k] = BigInt(w[k]!);
  return o as unknown as UserOperation<'0.7'>;
}

async function ownerAction(label: string, account: Address, callData: Hex) {
  const prep = await ops.prepare(TG, callData);
  const op = fromWire(prep.op);
  if (op.callData !== callData || op.sender.toLowerCase() !== account.toLowerCase()) throw new Error('server changed the operation');
  const hash = getUserOperationHash({ chainId: prep.chainId, entryPointAddress: prep.entryPoint as Address, entryPointVersion: '0.7', userOperation: op });
  const res = await ops.send(TG, { ...prep.op, signature: await owner.signMessage({ message: { raw: hash } }) });
  console.log(`  ${label.padEnd(34)} ${res.tx}`);
}

async function waitFill(id: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    await svc.runBatch();
    const o = db.getOrder(id)!;
    if (o.status !== 'pending') return { o, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('order did not settle in 2 minutes');
}

const step = (n: number, s: string) => console.log(`\n${n}. ${s}`);

async function main() {
  const account = await client.readContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'getAddress', args: [owner.address, 0n] });
  db.upsertUser(TG, 'Alice');
  db.setAccount(TG, account, dep.settlement, dep.accountFactory);
  const dog = tt.QTDOG!;
  const bal = (t: Address) => client.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
  console.log(`Wallet ${account}\n  QMS ${formatUnits((await bal(TOKENS.WQMS)) + (await client.getBalance({ address: account })), 18)}  QTDOG ${formatUnits(await bal(dog), 18)}`);

  step(1, 'Fresh trading key, QTDOG not yet approved');
  const { key } = ops.newSessionKey(TG);
  const session = {
    key,
    validUntil: Math.floor(Date.now() / 1000) + 30 * 86400,
    anyBuyToken: false,
    limits: [
      { token: TOKENS.WQMS, perTrade: 10n * 10n ** 18n, perDay: 50n * 10n ** 18n },
      { token: TOKENS.USDC, perTrade: 20n * 10n ** 6n, perDay: 100n * 10n ** 6n },
    ],
    buyTokens: [TOKENS.WQMS, TOKENS.USDC],
  };
  await ownerAction('turn trading on (new key)', account, encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'setSession', args: [session] }));

  step(2, 'Buying an unapproved token must ask for approval, not trade');
  try {
    await svc.placeOrder(TG, TOKENS.WQMS, dog, parseUnits('0.01', 18), 'instant');
    throw new Error('FAIL: order was accepted without approval');
  } catch (e) {
    if (!(e instanceof NeedsApproval)) throw e;
    console.log(`  refused: ${e.message}`);
  }

  step(3, 'One-time approval, the exact call the Mini App signs');
  const datas = [
    encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'setBuyTokenAllowed', args: [dog, true] }),
    encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'setTokenLimit', args: [dog, MAX, MAX] }),
  ];
  await ownerAction('approve QTDOG', account, encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'executeBatch', args: [[account, account], [0n, 0n], datas] }));
  const ctx = await svc.tradeContext(TG, dog);
  console.log(`  may buy: ${ctx?.buyAllowed}, may sell: ${ctx?.canSell}`);

  if ((await bal(TOKENS.WQMS)) + (await client.getBalance({ address: account })) < parseUnits('0.02', 18)) {
    await svc.requestTestFunds(TG);
    console.log(`  test funds added: QMS ${formatUnits(await bal(TOKENS.WQMS), 18)}`);
  }

  step(4, 'Buy QTDOG with 0.01 QMS (Instant)');
  const before = await bal(dog);
  const q = await svc.quote(TOKENS.WQMS, dog, parseUnits('0.01', 18));
  console.log(`  quote: direct ${formatUnits(q.direct, 18)} QTDOG, price impact ${(q.impactBps / 100).toFixed(2)}%`);
  const buy = await svc.placeOrder(TG, TOKENS.WQMS, dog, parseUnits('0.01', 18), 'instant');
  const b = await waitFill(buy.id);
  if (b.o.status !== 'filled') throw new Error(`FAIL: buy ${b.o.status}: ${b.o.reason}`);
  const got = (await bal(dog)) - before;
  console.log(`  filled in ${(b.ms / 1000).toFixed(1)}s  +${formatUnits(got, 18)} QTDOG  (direct swap: ${formatUnits(BigInt(b.o.direct_quote!), 18)})  tx ${b.o.tx_hash}`);
  if (BigInt(b.o.buy_amount!) + BigInt(b.o.network_fee ?? '0') < BigInt(b.o.direct_quote!)) throw new Error('FAIL: below direct price');

  step(5, 'Position with honest profit and loss');
  for (const p of await svc.positions(TG)) {
    console.log(`  ${p.token.symbol}: ${formatUnits(p.balance, 18)}  sell-now value ${formatUnits(p.exitQms, 18)} QMS  cost ${p.costQms === null ? 'unknown' : formatUnits(p.costQms, 18)} QMS  P&L ${p.pnlPct === null ? 'n/a' : p.pnlPct.toFixed(2) + '%'}`);
  }

  step(6, 'Sell all QTDOG (balance read now)');
  const all = await bal(dog);
  const sell = await svc.placeOrder(TG, dog, TOKENS.WQMS, all, 'instant', { acceptImpact: true });
  const s = await waitFill(sell.id);
  if (s.o.status !== 'filled') throw new Error(`FAIL: sell ${s.o.status}: ${s.o.reason}`);
  console.log(`  filled in ${(s.ms / 1000).toFixed(1)}s  +${formatUnits(BigInt(s.o.buy_amount!), 18)} QMS  QTDOG left: ${formatUnits(await bal(dog), 18)}  tx ${s.o.tx_hash}`);

  step(7, 'Honeypot and taxed tokens are refused before anything is signed');
  for (const [label, t] of [['QTHONEY', tt.QTHONEY!], ['QTTAX', tt.QTTAX!]] as const) {
    try {
      await svc.placeOrder(TG, TOKENS.WQMS, t, parseUnits('0.01', 18), 'instant');
      throw new Error(`FAIL: ${label} order accepted`);
    } catch (e) {
      if (!(e instanceof UserError) || e instanceof NeedsApproval) throw e;
      console.log(`  ${label}: ${e.message}`);
    }
  }
  console.log(`\nNotifications sent: ${notes.map((n) => n.kind ?? 'other').join(', ')}`);
  console.log('\nAll chat-trading checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n' + ((e as Error).message ?? e));
  process.exit(1);
});
