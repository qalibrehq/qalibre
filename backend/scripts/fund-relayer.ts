/**
 * Tops up the hosted server's relayer key (RELAYER_PRIVATE_KEY) from the deployer, so the admin key never has to
 * live on the server. The relayer pays gas for wallet creation and owner actions and sends test-fund drips.
 * Dry run by default.
 *
 *   npx tsx scripts/fund-relayer.ts          (show balances and what would be sent)
 *   npx tsx scripts/fund-relayer.ts --send   (send)
 */
import { formatUnits, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config, TOKENS, deployerKey } from '../src/config.js';
import { erc20Abi, publicClient, walletClient } from '../../solver/src/chain.js';

// Targets: enough for many wallet creations and about 25 new users' test funds; top up from the QMS faucet as needed.
const TARGET = { QMS: parseUnits('3', 18), WQMS: parseUnits('2.5', 18), USDC: parseUnits('7', 6) };

const send = process.argv.includes('--send');
if (!deployerKey) throw new Error('DEPLOYER_PRIVATE_KEY is not set (run this on the machine that holds it).');
const deployer = privateKeyToAccount(deployerKey);
const relayer = privateKeyToAccount(config.relayerKey);
if (relayer.address === deployer.address) throw new Error('RELAYER_PRIVATE_KEY is not set: the relayer is still the deployer.');

const client = publicClient();
const wallet = walletClient(deployer);
const bal = async (who: `0x${string}`) => ({
  QMS: await client.getBalance({ address: who }),
  WQMS: await client.readContract({ address: TOKENS.WQMS, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
  USDC: await client.readContract({ address: TOKENS.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
});
const show = (b: Awaited<ReturnType<typeof bal>>) => `${formatUnits(b.QMS, 18)} QMS, ${formatUnits(b.WQMS, 18)} WQMS, ${formatUnits(b.USDC, 6)} USDC`;

const d = await bal(deployer.address);
const r = await bal(relayer.address);
console.log(`deployer ${deployer.address}: ${show(d)}`);
console.log(`relayer  ${relayer.address}: ${show(r)}`);

const need = {
  QMS: TARGET.QMS > r.QMS ? TARGET.QMS - r.QMS : 0n,
  WQMS: TARGET.WQMS > r.WQMS ? TARGET.WQMS - r.WQMS : 0n,
  USDC: TARGET.USDC > r.USDC ? TARGET.USDC - r.USDC : 0n,
};
console.log(`to send: ${show(need)}`);
if (!send) process.exit(0);

if (need.QMS > 0n) {
  const h = await wallet.sendTransaction({ account: deployer, chain: wallet.chain, to: relayer.address, value: need.QMS });
  await client.waitForTransactionReceipt({ hash: h });
  console.log('QMS sent', h);
}
for (const sym of ['WQMS', 'USDC'] as const) {
  if (need[sym] === 0n) continue;
  const h = await wallet.writeContract({ account: deployer, chain: wallet.chain, address: TOKENS[sym], abi: erc20Abi, functionName: 'transfer', args: [relayer.address, need[sym]] });
  await client.waitForTransactionReceipt({ hash: h });
  console.log(`${sym} sent`, h);
}
console.log(`relayer now: ${show(await bal(relayer.address))}`);
