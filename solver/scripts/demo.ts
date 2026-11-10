/**
 * Live demo on QMS testnet: four users trade WQMS/USDC at the same time through Qalibre.
 *
 *   npm run demo
 *
 * Uses DEPLOYER_PRIVATE_KEY (funder) and SOLVER_PRIVATE_KEY from contracts/.env. Demo user keys and
 * the backend session key are generated once and kept in solver/.demo/keys.json (git-ignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits, parseUnits, type Address, type Hex, type LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { QalibreAccountFactoryAbi } from '../src/abi/QalibreAccountFactory.js';
import { QalibreSettlementAbi } from '../src/abi/QalibreSettlement.js';
import { EXPLORER, erc20Abi, loadDeployment, publicClient, routerAbi, signOrderAsSession, walletClient, waitForConfirmations, type Order } from '../src/chain.js';
import { executeBatch, planBatch, type SignedOrder } from '../src/solver.js';
import { getAmountOut } from '../src/amm.js';
import { readReserves } from '../src/chain.js';

const here = dirname(fileURLToPath(import.meta.url));
const WQMS: Address = '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34';
const USDC: Address = '0xDfF68E53a0A8275212927c12017f5aB5f1842a04';

function loadEnv(): Record<string, string> {
  const text = readFileSync(join(here, '..', '..', 'contracts', '.env'), 'utf8');
  return Object.fromEntries(
    text.split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

function demoKeys(): Record<string, Hex> {
  const dir = join(here, '..', '.demo');
  const file = join(dir, 'keys.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(dir, { recursive: true });
  const keys = { session: generatePrivateKey(), alice: generatePrivateKey(), bob: generatePrivateKey(), carol: generatePrivateKey(), dave: generatePrivateKey() };
  writeFileSync(file, JSON.stringify(keys, null, 2));
  return keys;
}

const fmt = (v: bigint, token: Address) => formatUnits(v, token === USDC ? 6 : 18);
const sym = (token: Address) => (token === USDC ? 'USDC' : 'WQMS');

async function main() {
  const env = loadEnv();
  const dep = loadDeployment();
  const client = publicClient();
  const funder = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
  const solver = privateKeyToAccount(env.SOLVER_PRIVATE_KEY as Hex);
  const keys = demoKeys();
  const session = privateKeyToAccount(keys.session!);
  const fw = walletClient(funder);

  const send = async (label: string, hash: Hex) => {
    await waitForConfirmations(client, hash, 1n);
    console.log(`  ${label.padEnd(34)} ${EXPLORER}/tx/${hash}`);
  };

  console.log('\nQalibre live demo · QMS testnet\n');
  console.log(`settlement ${dep.settlement}\nsolver     ${solver.address}\nsession    ${session.address}\n`);

  // 1. Funder gets WQMS and USDC.
  const wqmsBal = await client.readContract({ address: WQMS, abi: erc20Abi, functionName: 'balanceOf', args: [funder.address] });
  const usdcBal = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [funder.address] });
  if (wqmsBal < parseUnits('0.5', 18) || usdcBal < parseUnits('0.7', 6)) {
    console.log('Funding the demo:');
    await send('wrap 1.4 QMS -> WQMS', await fw.writeContract({ address: WQMS, abi: erc20Abi, functionName: 'deposit', value: parseUnits('1.4', 18), chain: fw.chain, account: funder }));
    await send('approve QWAP router', await fw.writeContract({ address: WQMS, abi: erc20Abi, functionName: 'approve', args: [dep.qwapRouter, parseUnits('0.6', 18)], chain: fw.chain, account: funder }));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    await send('swap 0.6 WQMS -> USDC on QWAP', await fw.writeContract({ address: dep.qwapRouter, abi: routerAbi, functionName: 'swapExactTokensForTokens', args: [parseUnits('0.6', 18), 0n, [WQMS, USDC], funder.address, deadline], chain: fw.chain, account: funder }));
  }

  // 2. Four Qalibre accounts, each owned by its user, all approving the same backend session key.
  const people: { name: string; owner: LocalAccount; sell: Address; buy: Address; amount: bigint }[] = [
    { name: 'Alice', owner: privateKeyToAccount(keys.alice!), sell: WQMS, buy: USDC, amount: parseUnits('0.30', 18) },
    { name: 'Carol', owner: privateKeyToAccount(keys.carol!), sell: WQMS, buy: USDC, amount: parseUnits('0.08', 18) },
    { name: 'Bob', owner: privateKeyToAccount(keys.bob!), sell: USDC, buy: WQMS, amount: parseUnits('0.45', 6) },
    { name: 'Dave', owner: privateKeyToAccount(keys.dave!), sell: USDC, buy: WQMS, amount: parseUnits('0.20', 6) },
  ];
  const now = BigInt(Math.floor(Date.now() / 1000));
  const accounts: Record<string, Address> = {};
  console.log('\nCreating user accounts (owners sign their own setup):');
  for (const p of people) {
    const setup = {
      owner: p.owner.address,
      salt: 0n,
      session: {
        key: session.address,
        validUntil: Number(now + 30n * 86400n),
        anyBuyToken: false,
        limits: [
          { token: WQMS, perTrade: parseUnits('5', 18), perDay: parseUnits('10', 18) },
          { token: USDC, perTrade: parseUnits('50', 6), perDay: parseUnits('100', 6) },
        ],
        buyTokens: [WQMS, USDC],
      },
    };
    const addr = await client.readContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'getAddress', args: [p.owner.address, 0n] });
    accounts[p.name] = addr;
    const code = await client.getCode({ address: addr });
    if (!code || code === '0x') {
      const h = await client.readContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'setupHash', args: [setup] });
      const ownerSig = await p.owner.signMessage({ message: { raw: h } });
      await send(`${p.name}'s account`, await fw.writeContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'createAccount', args: [setup, ownerSig], chain: fw.chain, account: funder }));
    } else {
      console.log(`  ${(p.name + "'s account").padEnd(34)} exists at ${addr}`);
    }
    const have = await client.readContract({ address: p.sell, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
    if (have < p.amount) {
      await send(`fund ${p.name} ${fmt(p.amount - have, p.sell)} ${sym(p.sell)}`, await fw.writeContract({ address: p.sell, abi: erc20Abi, functionName: 'transfer', args: [addr, p.amount - have], chain: fw.chain, account: funder }));
    }
  }

  // 3. Everyone places an order at the same moment, signed by the session key.
  const res0 = await readReserves(client, dep.qwapRouter, WQMS, USDC);
  const wqmsIsA = WQMS.toLowerCase() < USDC.toLowerCase();
  const direct = (sell: Address, amount: bigint) => {
    const sellIsA = (sell === WQMS) === wqmsIsA;
    return sellIsA ? getAmountOut(amount, res0.a, res0.b) : getAmountOut(amount, res0.b, res0.a);
  };
  const pending: SignedOrder[] = [];
  const directAtOrder: Record<string, bigint> = {};
  for (const p of people) {
    const d = direct(p.sell, p.amount);
    directAtOrder[p.name] = d;
    const order: Order = {
      account: accounts[p.name]!,
      sellToken: p.sell,
      buyToken: p.buy,
      sellAmount: p.amount,
      minBuyAmount: (d * 995n) / 1000n, // 0.5% slippage limit
      validTo: now + 900n,
      nonce: BigInt(Date.now()) * 10n + BigInt(people.indexOf(p)),
    };
    pending.push({ id: p.name, order, signature: await signOrderAsSession(session, dep.settlement, order) });
  }
  console.log('\nOrders placed:');
  for (const p of people) console.log(`  ${p.name.padEnd(6)} sells ${fmt(p.amount, p.sell).padStart(5)} ${sym(p.sell)}   direct on QWAP would pay ${fmt(directAtOrder[p.name]!, p.buy)} ${sym(p.buy)}`);

  // 4. Run batches until every order is filled.
  const fees = {
    feeBps: await client.readContract({ address: dep.settlement, abi: QalibreSettlementAbi, functionName: 'feeBps' }),
    surplusShareBps: await client.readContract({ address: dep.settlement, abi: QalibreSettlementAbi, functionName: 'surplusShareBps' }),
  };
  const outDir = join(here, '..', 'out');
  mkdirSync(outDir, { recursive: true });
  const results: Record<string, { got: bigint; fee: bigint; direct: bigint; batch: number; tx: Hex }> = {};
  let queue = [...pending];
  for (let round = 1; queue.length > 0 && round <= 4; round++) {
    // Re-plan from fresh pool reserves on every attempt: if the pool moves between simulation and
    // inclusion, the batch reverts as a whole (nobody is filled at a worse price) and we try again.
    let plan: Awaited<ReturnType<typeof planBatch>> = null;
    let r: Awaited<ReturnType<typeof executeBatch>> | null = null;
    for (let attempt = 1; attempt <= 4 && !r; attempt++) {
      plan = await planBatch(client, dep, queue, fees);
      if (!plan) break;
      try {
        r = await executeBatch(client, dep, solver, plan);
      } catch (e) {
        console.log(`  attempt ${attempt}: pool moved before inclusion, batch safely reverted; re-planning`);
      }
    }
    if (!plan || !r) {
      console.log('\nNo valid batch for the remaining orders.');
      break;
    }
    const mtx = join(outDir, `batch-${Date.now()}.mtx`);
    writeFileSync(mtx, plan.matrixMarket);
    const filledIds = plan.clearing.fills.map((f) => f.id);
    console.log(`\nBatch ${round}: QUBO over ${queue.length} orders -> clearing ${filledIds.join(', ')}${plan.clearing.dropped.length ? `; held for next batch: ${plan.clearing.dropped.map((d) => `${d.id} (${d.reason})`).join(', ')}` : ''}`);
    console.log(`  QUBO instance (QMS Matrix Market format): ${mtx}`);
    if (plan.clearing.swap) console.log(`  leftover routed to QWAP: ${fmt(plan.clearing.swap.amountIn, plan.clearing.swap.sellsA === wqmsIsA ? WQMS : USDC)} ${plan.clearing.swap.sellsA === wqmsIsA ? 'WQMS' : 'USDC'}`);
    console.log(`  settled in block ${r.block}, ${r.receipts.length} trades: ${EXPLORER}/tx/${r.hash}`);
    for (const rec of r.receipts) {
      const name = Object.entries(accounts).find(([, a]) => a.toLowerCase() === rec.account.toLowerCase())?.[0] ?? rec.account;
      results[name] = { got: rec.buyAmount, fee: rec.fee, direct: rec.directQuote, batch: round, tx: r.hash };
    }
    const done = new Set(filledIds);
    queue = queue.filter((o) => !done.has(o.id));
  }

  // 5. Receipts: on-chain direct quote vs what each user actually received.
  console.log('\nResults (all numbers read from on-chain TradeSettled events):\n');
  console.log('  user    receives   direct on QWAP   with Qalibre     difference   Qalibre fee');
  for (const p of people) {
    const r = results[p.name];
    if (!r) {
      console.log(`  ${p.name.padEnd(7)} not filled`);
      continue;
    }
    const diff = r.got - r.direct;
    const pct = r.direct > 0n ? Number((diff * 1_000_000n) / r.direct) / 10_000 : 0;
    console.log(`  ${p.name.padEnd(7)} ${sym(p.buy).padEnd(9)}  ${fmt(r.direct, p.buy).padStart(14)}  ${fmt(r.got, p.buy).padStart(14)}  ${(pct >= 0 ? '+' : '') + pct.toFixed(3) + '%'}`.padEnd(80) + `${fmt(r.fee, p.buy)}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
