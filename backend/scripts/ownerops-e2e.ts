/**
 * End-to-end check of owner actions on QMS testnet, playing the phone exactly as the Mini App will:
 * encode the call locally, verify the server's prepared operation, compute the hash locally, sign, submit.
 *
 *   npx tsx scripts/ownerops-e2e.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { openDb } from '../src/db.js';
import { createOwnerOps } from '../src/ownerops.js';
import { ROOT, TOKENS } from '../src/config.js';
import { QalibreAccountAbi } from '../../solver/src/abi/QalibreAccount.js';
import { QalibreAccountFactoryAbi } from '../../solver/src/abi/QalibreAccountFactory.js';
import { erc20Abi, loadDeployment, publicClient } from '../../solver/src/chain.js';

const keys = JSON.parse(readFileSync(join(ROOT, 'solver', '.demo', 'keys.json'), 'utf8')) as Record<string, Hex>;
const owner = privateKeyToAccount(keys.alice!);
const dep = loadDeployment();
const client = publicClient();
const db = openDb(':memory:');
const ops = createOwnerOps(db);
const TG = 1;

function fromWire(w: Record<string, string>): UserOperation<'0.7'> {
  const big = ['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'];
  const o: Record<string, unknown> = { ...w };
  for (const k of big) o[k] = BigInt(w[k]!);
  return o as unknown as UserOperation<'0.7'>;
}

/** What the phone does: encode, check the server did not change the call or the wallet, hash locally, sign. */
async function run(label: string, account: Address, callData: Hex) {
  const prep = await ops.prepare(TG, callData);
  const op = fromWire(prep.op);
  if (op.callData !== callData) throw new Error('server changed the call');
  if (op.sender.toLowerCase() !== account.toLowerCase()) throw new Error('server changed the wallet');
  const hash = getUserOperationHash({ chainId: prep.chainId, entryPointAddress: prep.entryPoint as Address, entryPointVersion: '0.7', userOperation: op });
  const signature = await owner.signMessage({ message: { raw: hash } });
  const res = await ops.send(TG, { ...prep.op, signature });
  console.log(`  ${label.padEnd(30)} ${res.tx}`);
}

async function main() {
  const account = await client.readContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'getAddress', args: [owner.address, 0n] });
  db.upsertUser(TG, 'Alice');
  db.setAccount(TG, account, dep.settlement, dep.accountFactory);
  const active = () => client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'sessionActive' });
  console.log(`Alice's wallet ${account}, trading permission on: ${await active()}\n`);

  // 1. Turn trading off.
  await run('turn trading off', account, encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'revokeSession' }));
  console.log(`    trading permission on: ${await active()}`);

  // 2. Turn it back on with a fresh key issued by the server.
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
  await run('turn trading on (new key)', account, encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'setSession', args: [session] }));
  const live = await client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'sessionKey' });
  console.log(`    trading permission on: ${await active()}, key matches issued key: ${live.toLowerCase() === key.toLowerCase()}, activated in db: ${db.getUser(TG)?.session_address?.toLowerCase() === key.toLowerCase()}`);

  // 3. Edit limits (two settings in one action).
  const datas = [
    encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'setTokenLimit', args: [TOKENS.USDC, 5n * 10n ** 6n, 25n * 10n ** 6n] }),
    encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'setTokenLimit', args: [TOKENS.WQMS, 2n * 10n ** 18n, 8n * 10n ** 18n] }),
  ];
  await run('edit limits', account, encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'executeBatch', args: [[account, account], [0n, 0n], datas] }));
  const lim = await client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'tokenLimit', args: [TOKENS.USDC] });
  console.log(`    USDC limit now: ${Number(lim[0]) / 1e6} per trade, ${Number(lim[1]) / 1e6} per day`);

  // 4. Send 0.01 USDC to an address of the owner's choosing (here: the owner key itself).
  const before = await client.readContract({ address: TOKENS.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
  const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [owner.address, 10_000n] });
  await run('send 0.01 USDC', account, encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'execute', args: [TOKENS.USDC, 0n, transfer] }));
  const after = await client.readContract({ address: TOKENS.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
  console.log(`    recipient received: ${Number(after - before) / 1e6} USDC`);

  // 5. Policy: sponsoring an arbitrary contract call must be refused before anything is signed.
  try {
    await ops.prepare(TG, encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'execute', args: [dep.settlement, 0n, '0x12345678'] }));
    console.log('  POLICY FAILURE: arbitrary call was sponsored');
  } catch (e) {
    console.log(`  arbitrary contract call refused: "${(e as Error).message}"`);
  }
  // 6. A signature from anyone but the owner must not go through.
  try {
    const prep = await ops.prepare(TG, encodeFunctionData({ abi: QalibreAccountAbi, functionName: 'revokeSession' }));
    const op = fromWire(prep.op);
    const hash = getUserOperationHash({ chainId: prep.chainId, entryPointAddress: prep.entryPoint as Address, entryPointVersion: '0.7', userOperation: op });
    const intruder = privateKeyToAccount(keys.bob!);
    await ops.send(TG, { ...prep.op, signature: await intruder.signMessage({ message: { raw: hash } }) });
    console.log('  SECURITY FAILURE: non-owner signature accepted');
  } catch (e) {
    console.log(`  non-owner signature refused: "${(e as Error).message}"`);
  }
  console.log(`\n  trading permission on at the end: ${await active()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
