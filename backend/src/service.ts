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
  GAS_PER_TRADE,
  DroppedByReorg,
  type Order,
} from '../../solver/src/chain.js';
import { executeBatch, planBatch, simulateBatch, type SignedOrder } from '../../solver/src/solver.js';
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
      // Conservative until the external audit (docs/AUDIT.md 1.1). Owners can raise them.
      { token: TOKENS.WQMS, perTrade: 10n * 10n ** 18n, perDay: 50n * 10n ** 18n },
      { token: TOKENS.USDC, perTrade: 20n * 10n ** 6n, perDay: 100n * 10n ** 6n },
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

/** A wallet is current when it was created for the deployed settlement contract (older versions need re-opening). */
function isCurrent<T extends { account: string | null; settlement: string | null }>(u: T | undefined): u is T & { account: string } {
  return Boolean(u?.account && u.settlement && u.settlement.toLowerCase() === dep.settlement.toLowerCase());
}

export function createService(db: Db, notify: (tgId: number, html: string) => Promise<void>) {
  // ---------------------------------------------------------------------------------------------
  // Registration: the owner key lives on the user's device; we only ever see its address and its
  // signature over the account setup. We generate the session key and keep it encrypted.
  // ---------------------------------------------------------------------------------------------
  async function prepareRegistration(tgId: number, owner: string) {
    if (!isAddress(owner)) throw new UserError('Invalid wallet address.');
    const user = db.getUser(tgId);
    if (isCurrent(user)) throw new UserError('You already have a Qalibre wallet.');
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
    db.setAccount(tgId, account, dep.settlement);
    void drip(tgId, account);
    return { account };
  }

  /** Testnet only: send a little WQMS and USDC so a user can trade. On signup, and once a day on request. */
  async function sendTestFunds(account: Address): Promise<{ wqms: bigint; usdc: bigint }> {
    const w = walletClient(relayer);
    const sent = { wqms: 0n, usdc: 0n };
    for (const [token, amount, key] of [[TOKENS.WQMS, config.drip.wqms, 'wqms'], [TOKENS.USDC, config.drip.usdc, 'usdc']] as const) {
      const bal = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [relayer.address] });
      if (bal < amount) continue;
      const h = await w.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [account, amount], account: relayer, chain: w.chain });
      await waitForConfirmations(client, h, 1n);
      sent[key] = amount;
    }
    return sent;
  }

  async function drip(tgId: number, account: Address) {
    const u = db.getUser(tgId);
    if (!u || u.dripped) return;
    try {
      const sent = await sendTestFunds(account);
      db.markDripped(tgId);
      if (sent.wqms > 0n || sent.usdc > 0n) {
        await notify(tgId, '<b>Your wallet is ready.</b>\nWe added a little test QMS and USDC so you can make your first trade right away.');
      } else {
        await notify(tgId, '<b>Your wallet is ready.</b>\nOur test-fund reserve is being refilled. Tap Get test funds in the app a little later.');
      }
    } catch (e) {
      console.error('drip failed', (e as Error).message);
    }
  }

  const dripInFlight = new Set<number>();
  async function requestTestFunds(tgId: number) {
    const u = db.getUser(tgId);
    if (!isCurrent(u)) throw new UserError('Open your wallet first.');
    const wait = u.last_drip_at + 86_400 - Math.floor(Date.now() / 1000);
    if (wait > 0) {
      const h = Math.ceil(wait / 3600);
      throw new UserError(`You can request test funds again in about ${h} ${h === 1 ? 'hour' : 'hours'}.`);
    }
    if (dripInFlight.has(tgId)) throw new UserError('Your test funds are already on their way.');
    dripInFlight.add(tgId);
    try {
      const sent = await sendTestFunds(u.account as Address);
      if (sent.wqms === 0n && sent.usdc === 0n) throw new UserError('Our test-fund reserve is being refilled. Please try again later.');
      db.markDripped(tgId);
      return { wqms: sent.wqms.toString(), usdc: sent.usdc.toString() };
    } finally {
      dripInFlight.delete(tgId);
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
    const maxNetworkFee = await networkFeeCap(buyToken, res.a, res.b, a);
    return { direct, minOut, likely: likely > direct ? likely : direct, waiting: pending.length, maxNetworkFee };
  }

  /**
   * The most the user signs for network costs: 3x today's measured gas cost for one trade, converted into the
   * token they receive. The solver charges actual cost, which is normally a fraction of this.
   */
  async function networkFeeCap(buyToken: Address, resA: bigint, resB: bigint, tokenA: Address): Promise<bigint> {
    const gasPrice = await client.getGasPrice();
    const wei = GAS_PER_TRADE * gasPrice * 3n;
    if (buyToken.toLowerCase() === TOKENS.WQMS.toLowerCase()) return wei > 0n ? wei : 1n;
    // Convert QMS -> buy token at the pool price.
    const buyIsA = buyToken.toLowerCase() === tokenA.toLowerCase();
    const [qmsRes, buyRes] = buyIsA ? [resB, resA] : [resA, resB];
    const v = (wei * buyRes) / qmsRes;
    return v > 0n ? v : 1n;
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

  async function placeOrder(tgId: number, sellToken: Address, buyToken: Address, sellAmount: bigint, mode: 'instant' | 'best' = 'best') {
    const user = db.getUser(tgId);
    if (!isCurrent(user) || !user?.session_key_enc) throw new UserError('Open your wallet first.');
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
      maxNetworkFee: q.maxNetworkFee,
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
      max_network_fee: q.maxNetworkFee.toString(),
      valid_to: Number(order.validTo),
      nonce: order.nonce.toString(),
      signature,
      mode,
    });
    void runBatch();
    return { id, minOut: q.minOut, likely: q.likely, direct: q.direct, maxNetworkFee: q.maxNetworkFee, nextBatchInMs: mode === 'instant' ? 0 : msToNextBatch() };
  }

  // ---------------------------------------------------------------------------------------------
  // Batch engine
  // ---------------------------------------------------------------------------------------------
  let running = false;
  let lastRunAt = 0;
  const pairKey = (o: { sell_token: string; buy_token: string }) => [o.sell_token.toLowerCase(), o.buy_token.toLowerCase()].sort().join('/');

  /** How long until the oldest waiting order is guaranteed to run (0 when something can run now). */
  function msToNextBatch(): number {
    const pending = db.pendingOrders();
    if (pending.length === 0) return 0;
    const oldest = Math.min(...pending.map((o) => o.created_ms ?? o.created_at * 1000));
    return Math.max(0, config.bestWindowMs - (Date.now() - oldest));
  }

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
        maxNetworkFee: BigInt(o.max_network_fee ?? '0'),
        validTo: BigInt(o.valid_to),
        nonce: BigInt(o.nonce),
      },
    };
  }

  /**
   * A pair is ready to clear when any of these is true:
   *  - an order asked for Instant execution
   *  - traders on both sides are waiting (a match is available right now)
   *  - the oldest Best-price order has waited its full window
   */
  function ready(rows: OrderRow[]): boolean {
    if (rows.some((o) => o.mode === 'instant')) return true;
    const sides = new Set(rows.map((o) => o.sell_token.toLowerCase()));
    if (sides.size > 1) return true;
    const oldest = Math.min(...rows.map((o) => o.created_ms ?? o.created_at * 1000));
    return Date.now() - oldest >= config.bestWindowMs;
  }

  async function isolateBlockers(queue: SignedOrder[], fees: { feeBps: bigint; surplusShareBps: bigint }): Promise<SignedOrder[]> {
    const blockers: SignedOrder[] = [];
    for (const q of queue) {
      try {
        const plan = await planBatch(client, dep, [q], fees);
        if (plan) await simulateBatch(client, dep, solver, plan);
      } catch (e) {
        console.warn(`order ${q.id} fails on its own, removing it from the batch:`, (e as Error).message.split('\n')[0]);
        blockers.push(q);
      }
    }
    return blockers;
  }

  async function runBatch() {
    if (running) return;
    running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      for (const o of db.pendingOrders()) {
        if (o.valid_to < now + 20) {
          db.markStatus(o.id, 'expired', 'Not filled in time. Nothing was traded.');
          await notify(o.tg_id, "<b>Order not filled.</b>\nWe couldn't fill it within your price limit in time, so nothing was traded. Your balance is unchanged.");
        }
      }
      const groups = new Map<string, OrderRow[]>();
      for (const o of db.pendingOrders()) groups.set(pairKey(o), [...(groups.get(pairKey(o)) ?? []), o]);
      const fees = await feeConfig();
      for (const rows of groups.values()) {
        if (!ready(rows)) continue;
        lastRunAt = Date.now();
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
              // Report the fill as soon as it is in a block; finality is tracked in the background.
              const r = await executeBatch(client, dep, solver, plan, 1n);
              const batchId = db.insertBatch({ tx: r.hash, block: Number(r.block), trades: r.receipts.length, mtx: plan.matrixMarket });
              const byDigest = new Map(queue.map((q) => [hashTypedData({ domain: orderDomain(dep.settlement), types: orderTypes, primaryType: 'Order', message: q.order }).toLowerCase(), q]));
              for (const rec of r.receipts) {
                const q = byDigest.get(rec.orderDigest.toLowerCase());
                if (!q) continue;
                db.markFilled(q.id, { tx: r.hash, buy: rec.buyAmount.toString(), fee: rec.fee.toString(), networkFee: rec.networkFee.toString(), direct: rec.directQuote.toString(), batchId });
                const row = db.getOrder(q.id)!;
                void notify(row.tg_id, fillMessage(row));
              }
              void waitForConfirmations(client, r.hash, config.finalConfirmations)
                .then(() => db.markConfirmed(r.hash))
                .catch((e) => {
                  if (e instanceof DroppedByReorg) {
                    // The settlement never happened on-chain; settle these orders again and say so plainly.
                    for (const row of db.requeueByTx(r.hash)) {
                      void notify(row.tg_id, '<b>Re-settling your order.</b>\nThe QMS network reorganized the block with your trade, so it did not complete. It is back in the queue at your original price limit. Your balance was never at risk.');
                    }
                  }
                  console.error(`settlement ${r.hash} did not reach finality:`, (e as Error).message);
                });
              const filled = new Set(plan.clearing.fills.map((f) => f.id));
              queue = queue.filter((q) => !filled.has(q.id));
              done = true;
            } catch (e) {
              console.warn(`batch attempt ${attempt + 1} reverted, re-planning:`, (e as Error).message.split('\n')[0]);
            }
          }
          if (!done) {
            // One order must never block everyone else: test each order alone and remove only ones that fail alone.
            const blockers = await isolateBlockers(queue, fees);
            if (blockers.length === 0) break; // transient (for example the pool kept moving): retry next tick
            for (const b of blockers) {
              db.markStatus(b.id, 'failed', 'This order could not be settled, so nothing was traded. Your balance is unchanged.');
              const row = db.getOrder(b.id);
              if (row) void notify(row.tg_id, '<b>Order not filled.</b>\nIt could not be settled, so nothing was traded. Your balance is unchanged. Check your trading permission and limits, then try again.');
            }
            const ids = new Set(blockers.map((b) => b.id));
            queue = queue.filter((q) => !ids.has(q.id));
          }
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
    const networkFee = BigInt(o.network_fee ?? '0');
    const direct = BigInt(o.direct_quote ?? '0');
    // Trade price vs a direct swap, before the at-cost network fee (a direct swap pays its own gas too).
    const priced = got + networkFee;
    const pct = direct > 0n ? Number(((priced - direct) * 1_000_000n) / direct) / 10_000 : 0;
    const fmt = (v: bigint) => trimUnits(v, buy.decimals);
    return [
      `<b>Filled. +${fmt(got)} ${buy.symbol}</b>`,
      pct > 0
        ? `A ${pct.toFixed(2)}% better price than a direct swap on QWAP, which would have paid ${fmt(direct)}.`
        : `The same as a direct swap on QWAP, with no Qalibre fee.`,
      networkFee > 0n ? `Network fee at cost: ${trimUnits(networkFee, buy.decimals, 8)} ${buy.symbol}.` : '',
      `<a href="https://testnet.qmsscan.io/tx/${o.tx_hash}">View the settlement on QMS Explorer</a>`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---------------------------------------------------------------------------------------------
  // Portfolio
  // ---------------------------------------------------------------------------------------------
  async function portfolio(tgId: number) {
    const user = db.getUser(tgId);
    if (!isCurrent(user)) return { registered: false as const, upgraded: Boolean(user?.account) };
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
    // Live limits and today's usage, read from the wallet contract itself.
    const limitFor = async (token: Address, decimals: number, symbol: string) => {
      const [[perTrade, perDay], spent] = await Promise.all([
        client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'tokenLimit', args: [token] }),
        client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'spentToday', args: [token] }),
      ]);
      const d = 10 ** decimals;
      return { token, symbol, decimals, perTrade: Number(perTrade) / d, perDay: Number(perDay) / d, spentToday: Number(spent) / d };
    };
    const [limQms, limUsdc, anyBuyToken] = await Promise.all([
      limitFor(TOKENS.WQMS, 18, 'QMS'),
      limitFor(TOKENS.USDC, 6, 'USDC'),
      client.readContract({ address: account, abi: QalibreAccountAbi, functionName: 'sessionAnyBuyToken' }),
    ]);
    const qms = Number(wqms) / 1e18;
    const unwrapped = Number(native) / 1e18;
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
      /** Native QMS (e.g. from the faucet) is not tradeable until wrapped; shown separately and honestly. */
      unwrappedQms: unwrapped,
      savedUsd,
      trades: filled.length,
      session: { active, validUntil: Number(validUntil), anyBuyToken },
      limits: [limQms, limUsdc],
      testFundsAt: user.last_drip_at + 86_400,
    };
  }

  function batchStatus() {
    return { nextBatchInMs: msToNextBatch(), waiting: db.countPending(), batch: db.lastBatchId() + 1, intervalMs: config.bestWindowMs, lastRunAt };
  }

  return { prepareRegistration, completeRegistration, quote, placeOrder, runBatch, portfolio, batchStatus, fillMessage, requestTestFunds, deployment: dep };
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
