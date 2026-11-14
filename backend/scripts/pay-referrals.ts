/**
 * Weekly referral payout: pays each inviter's unpaid rewards in WQMS to their Qalibre wallet, from the fee
 * wallet (the settlement's fee recipient, the deployer on testnet). Each payment is recorded against the exact
 * rewards it covers, so running this twice never pays twice. Dry run by default.
 *
 *   npx tsx scripts/pay-referrals.ts          (show what would be paid)
 *   npx tsx scripts/pay-referrals.ts --pay    (pay)
 */
import { formatUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config, TOKENS, deployerKey } from '../src/config.js';
import { openDb } from '../src/db.js';
import { erc20Abi, publicClient, walletClient, waitForConfirmations } from '../../solver/src/chain.js';

const MIN_PAYOUT = 10n ** 14n; // 0.0001 QMS: smaller balances roll over to next week
const pay = process.argv.includes('--pay');
const db = openDb(config.dbPath);
const client = publicClient();
if (!deployerKey) throw new Error('DEPLOYER_PRIVATE_KEY is not set: payouts come from the fee wallet.');
const payer = privateKeyToAccount(deployerKey);

const due = db.unpaidRewards();
if (due.length === 0) {
  console.log('Nothing to pay.');
  process.exit(0);
}
let funds = await client.readContract({ address: TOKENS.WQMS, abi: erc20Abi, functionName: 'balanceOf', args: [payer.address] });
console.log(`Fee wallet ${payer.address}: ${formatUnits(funds, 18)} WQMS\n`);
for (const r of due) {
  const total = BigInt(r.total);
  const user = db.getUser(r.referrer_tg);
  const to = user?.account as Address | undefined;
  const label = `inviter ${r.referrer_tg}: ${formatUnits(total, 18)} QMS`;
  if (!to) {
    console.log(`  ${label}  skipped: no wallet yet (rolls over)`);
    continue;
  }
  if (total < MIN_PAYOUT) {
    console.log(`  ${label}  below minimum (rolls over)`);
    continue;
  }
  if (total > funds) {
    console.log(`  ${label}  skipped: fee wallet too low`);
    continue;
  }
  if (!pay) {
    console.log(`  ${label}  -> ${to}  (dry run)`);
    continue;
  }
  const hash = await walletClient(payer).writeContract({ address: TOKENS.WQMS, abi: erc20Abi, functionName: 'transfer', args: [to, total], chain: undefined, account: payer });
  await waitForConfirmations(client, hash);
  db.markRewardsPaid(r.ids.split(','), hash);
  funds -= total;
  console.log(`  ${label}  -> ${to}  paid ${hash}`);
}
process.exit(0);
