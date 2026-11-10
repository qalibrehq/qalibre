import { randomUUID } from 'node:crypto';
import { hashTypedData, type Address, type Hex, isAddress, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { config, TOKENS, TOKEN_INFO } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import type { Db, OrderRow } from './db.js';
import { QalibreAccountFactoryAbi } from '../../solver/src/abi/QalibreAccountFactory.js';
import { QalibreAccountAbi } from '../../solver/src/abi/QalibreAccount.js';
import { QalibreSettlementAbi } from '../../solver/src/abi/QalibreSettlement.js';
import {
  erc20Abi,
  loadDeployment,
  orderDomain,
  orderTypes,
  publicClient,
  readReserves,
  signOrderAsSession,
  waitForConfirmations,
  walletClient,
  type Order,
} from '../../solver/src/chain.js';
import { executeBatch, planBatch, type SignedOrder } from '../../solver/src/solver.js';
import { clearPair, type PairOrder } from '../../solver/src/clearing.js';
import { getAmountOut } from '../../solver/src/amm.js';

export class UserError extends Error {}

const dep = loadDeployment();
const client = publicClient();
const relayer = privateKeyToAccount(config.relayerKey);
const solver = privateKeyToAccount(config.solverKey);
const SUPPORTED = new Set([TOKENS.WQMS.toLowerCase(), TOKENS.USDC.toLowerCase()]);

const jsonBig = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Default limits for a new account (testnet). The owner can change them at any time. */
function defaultSession(sessionKey: Address) {
  const now = Math.floor(Date.now() / 1000);
  return {
    key: sessionKey,
    validUntil: now + 30 * 86400,
    anyBuyToken: false,
    limits: [
      { token: TOKENS.WQMS, perTrade: 50n * 10n ** 18n, perDay: 200n * 10n ** 18n },
      { token: TOKENS.USDC, perTrade: 100n * 10n ** 6n, perDay: 400n * 10n ** 6n },
    ],
    buyTokens: [TOKENS.WQMS, TOKENS.USDC],
  };
}

function reviveSetup(json: string) {
  const s = JSON.parse(json);
  return {
    owner: s.owner as Address,
    salt: BigInt(s.salt),
    session: {
      key: s.session.key as Address,
      validUntil: Number(s.session.validUntil),
      anyBuyToken: Boolean(s.session.anyBuyToken),
      limits: s.session.limits.map((l: { token: Address; perTrade: string; perDay: string }) => ({ token: l.token, perTrade: BigInt(l.perTrade), perDay: BigInt(l.perDay) })),
      buyTokens: s.session.buyTokens as Address[],
    },
  };
}

export function createService(db: Db, notify: (tgId: number, html: string) => Promise<void>) {
  // ---------------------------------------------------------------------------------------------
  // Registration: the owner key lives on the user's device; we only ever see its address and its
  // signature over the account setup. We generate the session key and keep it encrypted.
  // ---------------------------------------------------------------------------------------------
  async function prepareRegistration(tgId: number, owner: string) {
    if (!isAddress(owner)) throw new UserError('Invalid wallet address.');
    const user = db.getUser(tgId);
    if (user?.account) throw new UserError('You already have a Qalibre wallet.');
    const sessionPk = generatePrivateKey();
    const session = privateKeyToAccount(sessionPk);
    const setup = { owner: getAddress(owner), salt: 0n, session: defaultSession(session.address) };
    const setupHash = await client.readContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'setupHash', args: [setup] });
    const account = await client.readContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'getAddress', args: [setup.owner, 0n] });
    db.setPending(tgId, {
      owner: setup.owner,
      session_address: session.address,
      session_key_enc: encrypt(sessionPk, config.sessionEncKey, `user:${tgId}`),
      pending_setup: jsonBig(setup),
    });
    return { setupHash, account, limits: setup.session.limits.map((l) => ({ token: l.token, perTrade: l.perTrade.toString(), perDay: l.perDay.toString() })), validUntil: setup.session.validUntil };
  }

  async function completeRegistration(tgId: number, ownerSignature: Hex) {
    const user = db.getUser(tgId);
    if (!user?.pending_setup) throw new UserError('Start signup first.');
    const setup = reviveSetup(user.pending_setup);
    const account = await client.readContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'getAddress', args: [setup.owner, 0n] });
    const code = await client.getCode({ address: account });
    if (!code || code === '0x') {
      // Simulate first: the factory rejects a signature that is not the owner's.
      try {
        await client.simulateContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'createAccount', args: [setup, ownerSignature], account: relayer });
      } catch {
        throw new UserError('Signature did not match your wallet. Please try again.');
      }
      const hash = await walletClient(relayer).writeContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'createAccount', args: [setup, ownerSignature], account: relayer, chain: walletClient(relayer).chain });
      await waitForConfirmations(client, hash, 1n);
    }
    db.setAccount(tgId, account);
    void drip(tgId, account);
    return { account };
  }

  /** Testnet only: send a little WQMS and USDC so a new user can trade immediately. */
  async function drip(tgId: number, account: Address) {
    const u = db.getUser(tgId);
    if (!u || u.dripped) return;
    try {
      const w = walletClient(relayer);
      for (const [token, amount] of [[TOKENS.WQMS, config.drip.wqms], [TOKENS.USDC, config.drip.usdc]] as const) {
        const bal = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [relayer.address] });
        if (bal < amount) continue;
        const h = await w.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [account, amount], account: relayer, chain: w.chain });
        await waitForConfirmations(client, h, 1n);
      }
      db.markDripped(tgId);
      await notify(tgId, 'Your Qalibre wallet is ready, and we added some <b>test QMS and USDC</b> so you can try your first trade.');
    } catch (e) {
      console.error('drip failed', (e as Error).message);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Quotes and orders
  // ---------------------------------------------------------------------------------------------
  function checkPair(sell: string, buy: string) {
    if (!SUPPORTED.has(sell.toLowerCase()) || !SUPPORTED.has(buy.toLowerCase()) || sell.toLowerCase() === buy.toLowerCase()) {
      throw new UserError('That pair is not available yet.');
    }
  }

  async function quote(sellToken: Address, buyToken: Address, sellAmount: bigint) {
    checkPair(sellToken, buyToken);
    if (sellAmount <= 0n) throw new UserError('Enter an amount.');
    const [a, b] = sellToken.toLowerCase() < buyToken.toLowerCase() ? [sellToken, buyToken] : [buyToken, sellToken];
    const res = await readReserves(client, dep.qwapRouter, a, b);
    const sellsA = sellToken.toLowerCase() === a.toLowerCase();
    const direct = sellsA ? getAmountOut(sellAmount, res.a, res.b) : getAmountOut(sellAmount, res.b, res.a);
    const minOut = (direct * (10_000n - config.defaultSlippageBps)) / 10_000n;
    // "Likely": what this order would get if the next batch cleared right now with everyone waiting.
    const fees = await feeConfig();
    const pending: PairOrder[] = db
      .pendingOrders()
      .filter((o) => [o.sell_token, o.buy_token].map((t) => t.toLowerCase()).sort().join() === [a, b].map((t) => t.toLowerCase()).sort().join())
      .map((o) => ({ id: o.id, sellsA: o.sell_token.toLowerCase() === a.toLowerCase(), sellAmount: BigInt(o.sell_amount), minBuyAmount: BigInt(o.min_buy_amount) }));
    const sim = clearPair([...pending, { id: 'quote', sellsA, sellAmount, minBuyAmount: minOut }], { a: res.a, b: res.b }, fees);
    const likely = sim?.fills.find((f) => f.id === 'quote')?.net ?? direct;
    return { direct, minOut, likely: likely > direct ? likely : direct, waiting: pending.length };
  }

  let feeCache: { feeBps: bigint; surplusShareBps: bigint; at: number } | null = null;
  async function feeConfig() {
    if (feeCache && Date.now() - feeCache.at < 60_000) return feeCache;
    const [feeBps, surplusShareBps] = await Promise.all([
      client.readContract({ address: dep.settlement, abi: QalibreSettlementAbi, functionName: 'feeBps' }),
      client.readContract({ address: dep.settlement, abi: QalibreSettlementAbi, functionName: 'surplusShareBps' }),
    ]);
    feeCache = { feeBps, surplusShareBps, at: Date.now() };
    return feeCache;
  }

  async function placeOrder(tgId: number, sellToken: Address, buyToken: Address, sellAmount: bigint) {
    const user = db.getUser(tgId);
    if (!user?.account || !user.session_key_enc) throw new UserError('Create your wallet first.');
    checkPair(sellToken, buyToken);
    const account = user.account as Address;
    const [bal, limit, spent, active] = await Promise.all([
      client.readContract({ address: sellToken, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'tokenLimit', args: [sellToken] }),
      client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'spentToday', args: [sellToken] }),
      client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'sessionActive' }),
    ]);
    const sym = TOKEN_INFO[sellToken.toLowerCase()]?.symbol ?? 'tokens';
    if (!active) throw new UserError('Trading permission is off. Turn it on in Control.');
    if (sellAmount > bal) throw new UserError(`You don't have enough ${sym}.`);
    const [perTrade, perDay] = limit as readonly [bigint, bigint];
    if (sellAmount > perTrade) throw new UserError('That is above your per-trade limit.');
    const reserved = db.pendingOrders().filter((o) => o.tg_id === tgId && o.sell_token.toLowerCase() === sellToken.toLowerCase()).reduce((s, o) => s + BigInt(o.sell_amount), 0n);
    if (spent + reserved + sellAmount > perDay) throw new UserError('That would pass your daily limit.');
    if (reserved + sellAmount > bal) throw new UserError(`You already have pending orders using this ${sym}.`);

    const q = await quote(sellToken, buyToken, sellAmount);
    const now = Math.floor(Date.now() / 1000);
    const order: Order = {
      account,
      sellToken: getAddress(sellToken),
      buyToken: getAddress(buyToken),
      sellAmount,
      minBuyAmount: q.minOut,
      validTo: BigInt(now + config.orderTtlSec),
      nonce: BigInt('0x' + randomUUID().replace(/-/g, '')),
    };
    const session = privateKeyToAccount(decrypt(user.session_key_enc, config.sessionEncKey, `user:${tgId}`) as Hex);
    const signature = await signOrderAsSession(session, dep.settlement, order);
    const id = randomUUID();
    db.insertOrder({
      id,
      tg_id: tgId,
      account,
      sell_token: order.sellToken,
      buy_token: order.buyToken,
      sell_amount: sellAmount.toString(),
      min_buy_amount: q.minOut.toString(),
      valid_to: Number(order.validTo),
      nonce: order.nonce.toString(),
      signature,
    });
    return { id, minOut: q.minOut, likely: q.likely, direct: q.direct, nextBatchInMs: msToNextBatch() };
  }

  // ---------------------------------------------------------------------------------------------
  // Batch engine
  // ---------------------------------------------------------------------------------------------
  let lastRun = Date.now();
  let running = false;
  const msToNextBatch = () => Math.max(0, config.batchIntervalMs - (Date.now() - lastRun));

  function toSigned(o: OrderRow): SignedOrder {
    return {
      id: o.id,
      signature: o.signature as Hex,
      order: {
        account: o.account as Address,
        sellToken: o.sell_token as Address,
        buyToken: o.buy_token as Address,
        sellAmount: BigInt(o.sell_amount),
        minBuyAmount: BigInt(o.min_buy_amount),
        validTo: BigInt(o.valid_to),
        nonce: BigInt(o.nonce),
      },
    };
  }

  async function runBatch() {
    if (running) return;
    running = true;
    lastRun = Date.now();
    try {
      const now = Math.floor(Date.now() / 1000);
      for (const o of db.pendingOrders()) {
        if (o.valid_to < now + 20) {
          db.markStatus(o.id, 'expired', 'Not filled in time. Nothing was traded.');
          await notify(o.tg_id, 'Your order expired before it could be filled at a fair price. <b>Nothing was traded</b>, and your funds are untouched.');
        }
      }
      const groups = new Map<string, OrderRow[]>();
      for (const o of db.pendingOrders()) {
        const key = [o.sell_token.toLowerCase(), o.buy_token.toLowerCase()].sort().join('/');
        groups.set(key, [...(groups.get(key) ?? []), o]);
      }
      const fees = await feeConfig();
      for (const rows of groups.values()) {
        let queue = rows.map(toSigned);
        for (let sub = 0; sub < 4 && queue.length > 0; sub++) {
          let done = false;
          for (let attempt = 0; attempt < 3 && !done; attempt++) {
            const plan = await planBatch(client, dep, queue, fees);
            if (!plan) {
              queue = [];
              break;
            }
            try {
              const r = await executeBatch(client, dep, solver, plan);
              const batchId = db.insertBatch({ tx: r.hash, block: Number(r.block), trades: r.receipts.length, mtx: plan.matrixMarket });
              const byDigest = new Map(queue.map((s) => [hashTypedData({ domain: orderDomain(dep.settlement), types: orderTypes, primaryType: 'Order', message: s.order }).toLowerCase(), s]));
              for (const rec of r.receipts) {
                const s = byDigest.get(rec.orderDigest.toLowerCase());
                if (!s) continue;
                db.markFilled(s.id, { tx: r.hash, buy: rec.buyAmount.toString(), fee: rec.fee.toString(), direct: rec.directQuote.toString(), batchId });
                const row = db.getOrder(s.id)!;
                await notify(row.tg_id, fillMessage(row));
              }
              const filled = new Set(plan.clearing.fills.map((f) => f.id));
              queue = queue.filter((q) => !filled.has(q.id));
              done = true;
            } catch (e) {
              console.warn(`batch attempt ${attempt + 1} reverted, re-planning:`, (e as Error).message.split('\n')[0]);
            }
          }
          if (!done) break;
        }
      }
    } catch (e) {
      console.error('batch loop error', e);
    } finally {
      running = false;
    }
  }

  function fillMessage(o: OrderRow): string {
    const buy = TOKEN_INFO[o.buy_token.toLowerCase()]!;
    const got = BigInt(o.buy_amount ?? '0');
    const direct = BigInt(o.direct_quote ?? '0');
    const pct = direct > 0n ? Number(((got - direct) * 1_000_000n) / direct) / 10_000 : 0;
    const fmt = (v: bigint) => trimUnits(v, buy.decimals);
    return [
      `<b>Order filled: +${fmt(got)} ${buy.symbol}</b>`,
      pct > 0 ? `${pct.toFixed(2)}% more than swapping directly on QWAP (${fmt(direct)}).` : `Same price as swapping directly on QWAP.`,
      `<a href="https://testnet.qmsscan.io/tx/${o.tx_hash}">Verify on QMS Explorer</a>`,
    ].join('\n');
  }

  // ---------------------------------------------------------------------------------------------
  // Portfolio
  // ---------------------------------------------------------------------------------------------
  async function portfolio(tgId: number) {
    const user = db.getUser(tgId);
    if (!user?.account) return { registered: false as const };
    const account = user.account as Address;
    const res = await readReserves(client, dep.qwapRouter, TOKENS.WQMS, TOKENS.USDC);
    const wqmsIsA = TOKENS.WQMS.toLowerCase() < TOKENS.USDC.toLowerCase();
    const usdcPerQms = wqmsIsA ? Number(res.b) / 1e6 / (Number(res.a) / 1e18) : Number(res.a) / 1e6 / (Number(res.b) / 1e18);
    const [wqms, usdc, native, active, validUntil] = await Promise.all([
      client.readContract({ address: TOKENS.WQMS, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      client.readContract({ address: TOKENS.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      client.getBalance({ address: account }),
      client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'sessionActive' }),
      client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'sessionValidUntil' }),
    ]);
    const qms = Number(wqms + native) / 1e18;
    const usd = Number(usdc) / 1e6;
    const filled = db.userOrders(tgId, 200).filter((o) => o.status === 'filled');
    let savedUsd = 0;
    for (const o of filled) {
      const diff = BigInt(o.buy_amount!) - BigInt(o.direct_quote!);
      savedUsd += o.buy_token.toLowerCase() === TOKENS.USDC.toLowerCase() ? Number(diff) / 1e6 : (Number(diff) / 1e18) * usdcPerQms;
    }
    return {
      registered: true as const,
      account,
      owner: user.owner,
      firstName: user.first_name,
      price: { usdcPerQms },
      holdings: [
        { symbol: 'QMS', name: 'QMS', amount: qms, valueUsd: qms * usdcPerQms, token: TOKENS.WQMS },
        { symbol: 'USDC', name: 'USD Coin', amount: usd, valueUsd: usd, token: TOKENS.USDC },
      ],
      totalUsd: qms * usdcPerQms + usd,
      savedUsd,
      trades: filled.length,
      session: { active, validUntil: Number(validUntil) },
    };
  }

  function batchStatus() {
    return { nextBatchInMs: msToNextBatch(), waiting: db.countPending(), batch: db.lastBatchId() + 1, intervalMs: config.batchIntervalMs };
  }

  return { prepareRegistration, completeRegistration, quote, placeOrder, runBatch, portfolio, batchStatus, fillMessage, deployment: dep };
}

export function trimUnits(v: bigint, decimals: number, maxFrac = 6): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  let frac = (a % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export type Service = ReturnType<typeof createService>;
