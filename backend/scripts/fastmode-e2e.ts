/**
 * Live end-to-end of Fast mode on QMS testnet, on a brand-new v3 wallet, through the same service the bot uses:
 *   1. create a wallet from the v3 factory (owner-signed setup, relayer pays gas) and get test funds
 *   2. Fast mode off: buying an unapproved token asks for approval
 *   3. Fast mode on, with the QMS limit set in the same owner-signed action (the exact call the Mini App sends)
 *   4. buy the unapproved token, settled at no worse than a direct swap
 *   5. sell all of it back to QMS with no approval and no per-token limit
 *   6. a honeypot is still refused before anything is signed
 *   7. Fast mode off again: the approval list is back
 *
 *   npx tsx scripts/fastmode-e2e.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, formatUnits, parseUnits, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { openDb } from '../src/db.js';
import { createOwnerOps } from '../src/ownerops.js';
import { createService, NeedsApproval, UserError } from '../src/service.js';
import { ROOT, TOKENS } from '../src/config.js';
import { QalibreAccountAbi } from '../../solver/src/abi/QalibreAccount.js';
import { erc20Abi, loadDeployment, publicClient } from '../../solver/src/chain.js';

delete process.env.TURSO_DATABASE_URL; // a throwaway local database; production storage is never touched
const tt = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', '19480-testtokens.json'), 'utf8')) as Record<string, Address>;
const owner = privateKeyToAccount(generatePrivateKey()); // a fresh user every run
const dep = loadDeployment();
const client = publicClient();
const db = openDb(':memory:');
const ops = createOwnerOps(db);
const svc = createService(db, async () => undefined);
const TG = 4242;

const fromWire = (w: Record<string, string>) => {
  const big = ['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'];
  const o: Record<string, unknown> = { ...w };
  for (const k of big) o[k] = BigInt(w[k]!);
  return o as unknown as UserOperation<'0.7'>;
};
async function ownerAction(label: string, account: Address, callData: Hex) {
  const prep = await ops.prepare(TG, callData);
  const op = fromWire(prep.op);
  if (op.callData !== callData || op.sender.toLowerCase() !== account.toLowerCase()) throw new Error('server changed the operation');
  const hash = getUserOperationHash({ chainId: prep.chainId, entryPointAddress: prep.entryPoint as Address, entryPointVersion: '0.7', userOperation: op });
  const res = await ops.send(TG, { ...prep.op, signature: await owner.signMessage({ message: { raw: hash } }) });
  console.log(`  ${label.padEnd(36)} ${res.tx}`);
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
const expectRefusal = async (label: string, fn: () => Promise<unknown>, kind: 'approval' | 'user') => {
  try {
    await fn();
    throw new Error(`FAIL: ${label} was accepted`);
  } catch (e) {
    if (kind === 'approval' && !(e instanceof NeedsApproval)) throw e;
    if (kind === 'user' && !(e instanceof UserError)) throw e;
    console.log(`  refused as expected: ${(e as Error).message}`);
  }
};
const step = (n: number, s: string) => console.log(`\n${n}. ${s}`);

async function main() {
  const plain = tt.QTPLAIN!;
  const honey = tt.QTHONEY!;
  console.log(`Factory (v3) ${dep.accountFactory}`);

  step(1, 'Create a v3 wallet and get test funds');
  db.upsertUser(TG, 'Fast');
  const prep = await svc.prepareRegistration(TG, owner.address);
  await svc.completeRegistration(TG, await owner.signMessage({ message: { raw: prep.setupHash as Hex } }));
  const account = db.getUser(TG)!.account as Address;
  const bal = (t: Address) => client.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
  for (let i = 0; i < 30 && (await bal(TOKENS.WQMS)) === 0n; i++) await new Promise((r) => setTimeout(r, 2_000));
  console.log(`  wallet ${account}  QMS ${formatUnits(await bal(TOKENS.WQMS), 18)}  fast mode: ${await client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'sessionFastMode' })}`);

  step(2, 'Fast mode off: buying an unapproved token asks for approval');
  await expectRefusal('unapproved buy', () => svc.placeOrder(TG, TOKENS.WQMS, plain, parseUnits('0.02', 18), 'instant'), 'approval');

  step(3, 'Turn Fast mode on, with a 1 QMS per trade / 2 QMS per day limit, in one owner-signed action');
  const datas = [
    encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'setTokenLimit', args: [TOKENS.WQMS, parseUnits('1', 18), parseUnits('2', 18)] }),
    encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'setFastMode', args: [true] }),
  ];
  await ownerAction('turn on Fast mode', account, encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'executeBatch', args: [[account, account], [0n, 0n], datas] }));
  const ctx = await svc.tradeContext(TG, plain);
  console.log(`  fast mode: ${ctx?.fastMode}  may buy: ${ctx?.buyAllowed}  may sell: ${ctx?.canSell}`);
  if (!ctx?.fastMode || !ctx.buyAllowed || !ctx.canSell) throw new Error('FAIL: fast mode not active');

  step(4, 'Buy QTPLAIN with 0.02 QMS, never approved');
  const buy = await svc.placeOrder(TG, TOKENS.WQMS, plain, parseUnits('0.02', 18), 'instant');
  const b = await waitFill(buy.id);
  if (b.o.status !== 'filled') throw new Error(`FAIL: buy ${b.o.status}: ${b.o.reason}`);
  if (BigInt(b.o.buy_amount!) + BigInt(b.o.network_fee ?? '0') < BigInt(b.o.direct_quote!)) throw new Error('FAIL: below direct price');
  console.log(`  filled in ${(b.ms / 1000).toFixed(1)}s  +${formatUnits(BigInt(b.o.buy_amount!), 18)} QTPLAIN (direct swap ${formatUnits(BigInt(b.o.direct_quote!), 18)})  tx ${b.o.tx_hash}`);

  step(5, 'Sell all of it back to QMS: no approval, no per-token limit');
  const held = await bal(plain);
  const qmsBefore = await bal(TOKENS.WQMS);
  const sell = await svc.placeOrder(TG, plain, TOKENS.WQMS, held, 'instant');
  const s = await waitFill(sell.id);
  if (s.o.status !== 'filled') throw new Error(`FAIL: sell ${s.o.status}: ${s.o.reason}`);
  console.log(`  filled in ${(s.ms / 1000).toFixed(1)}s  QTPLAIN left ${formatUnits(await bal(plain), 18)}  +${formatUnits((await bal(TOKENS.WQMS)) - qmsBefore, 18)} QMS  tx ${s.o.tx_hash}`);

  step(6, 'A honeypot is still refused before anything is signed');
  await expectRefusal('honeypot buy', () => svc.placeOrder(TG, TOKENS.WQMS, honey, parseUnits('0.01', 18), 'instant'), 'user');

  step(7, 'Fast mode off: the approval list is back');
  await ownerAction('turn off Fast mode', account, encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'setFastMode', args: [false] }));
  await expectRefusal('unapproved buy after turning off', () => svc.placeOrder(TG, TOKENS.WQMS, plain, parseUnits('0.02', 18), 'instant'), 'approval');

  console.log('\nAll Fast mode checks passed on testnet.');
  process.exit(0);
}
main().catch((e) => {
  console.error('\n' + (e as Error).message);
  process.exit(1);
});
