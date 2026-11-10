/**
 * One batch, end to end:
 *   1. QUBO: choose which orders to clear now (exported in QMS's Matrix Market format)
 *   2. Clearing: uniform price + AMM leg, dropping any order that would be worse than direct
 *   3. Build settle() arguments, simulate, submit, wait for confirmations
 *   4. Read TradeSettled events back as receipts
 *
 * The optimizer step is isolated behind `selectOrders` so it can later be handed to QMS miners
 * through the useful-work marketplace instead of being solved locally.
 */
import { decodeEventLog, type Address, type Hex, type LocalAccount, type PublicClient } from 'viem';
import { buildQubo, solveAnneal, toMatrixMarket, type Qubo } from './qubo.js';
import { clearPair, PRICE_ONE, type Clearing, type FeeConfig, type PairOrder } from './clearing.js';
import { QalibreSettlementAbi, readReserves, waitForConfirmations, walletClient, WQMS, type Deployment, type Order } from './chain.js';

export interface SignedOrder {
  id: string;
  order: Order;
  signature: Hex;
}

export interface BatchPlan {
  tokenA: Address;
  tokenB: Address;
  qubo: Qubo;
  selection: number[];
  matrixMarket: string;
  clearing: Clearing;
  args: [Address[], bigint[], TradeArg[], unknown[]];
  reservesBlock: bigint;
  /** WQMS per unit of token B and A, for converting gas cost (QMS) into each trader's buy token. */
  qmsPer: { a: number; b: number; tokenA: Address };
}

interface TradeArg {
  sellTokenIndex: bigint;
  buyTokenIndex: bigint;
  order: Order;
  signature: Hex;
  networkFee: bigint;
  /** headroom between the expected payout and the order's minimum, never exceeded by the network fee */
  headroom: bigint;
  expectedGross: bigint;
}

export interface BatchResult {
  hash: Hex;
  block: bigint;
  receipts: { account: Address; orderDigest: Hex; sellAmount: bigint; buyAmount: bigint; fee: bigint; networkFee: bigint; directQuote: bigint }[];
}

/** Urgency weight in the QUBO: how much executing now is worth relative to price impact. */
const RHO = Number(process.env.QUBO_RHO ?? '0.02');

/** Pluggable optimizer: local simulated annealing today, QMS useful-work marketplace later. */
export type Optimizer = (Q: Qubo) => Promise<number[]>;
export const localOptimizer: Optimizer = async (Q) => solveAnneal(Q);

export async function planBatch(
  client: PublicClient,
  dep: Deployment,
  orders: SignedOrder[],
  fees: FeeConfig,
  optimizer: Optimizer = localOptimizer,
): Promise<BatchPlan | null> {
  if (orders.length === 0) return null;
  const first = orders[0]!.order;
  const [tokenA, tokenB] = first.sellToken.toLowerCase() < first.buyToken.toLowerCase()
    ? [first.sellToken, first.buyToken]
    : [first.buyToken, first.sellToken];
  for (const o of orders) {
    const pair = [o.order.sellToken.toLowerCase(), o.order.buyToken.toLowerCase()].sort();
    if (pair[0] !== tokenA.toLowerCase() || pair[1] !== tokenB.toLowerCase()) throw new Error('planBatch takes one token pair');
  }
  const res = await readReserves(client, dep.qwapRouter, tokenA, tokenB);

  // 1. QUBO selection. Sizes in A units relative to the A reserve.
  const spot = (res.b * PRICE_ONE) / res.a;
  const items = orders.map((o) => {
    const sellsA = o.order.sellToken.toLowerCase() === tokenA.toLowerCase();
    const inA = sellsA ? o.order.sellAmount : (o.order.sellAmount * PRICE_ONE) / spot;
    return { v: Number((inA * 1_000_000_000n) / res.a) / 1e9, d: (sellsA ? 1 : -1) as 1 | -1 };
  });
  const qubo = buildQubo(items, RHO);
  const selection = await optimizer(qubo);
  const chosen = orders.filter((_, i) => selection[i] === 1);
  if (chosen.length === 0) return null;

  // 2. Uniform clearing price and the AMM leg.
  const pairOrders: PairOrder[] = chosen.map((o) => ({
    id: o.id,
    sellsA: o.order.sellToken.toLowerCase() === tokenA.toLowerCase(),
    sellAmount: o.order.sellAmount,
    minBuyAmount: o.order.minBuyAmount,
  }));
  const clearing = clearPair(pairOrders, { a: res.a, b: res.b }, fees);
  if (!clearing || clearing.fills.length === 0) return null;

  // 3. settle() arguments. tokens = [A, B], prices = [r, PRICE_ONE].
  const filled = new Set(clearing.fills.map((f) => f.id));
  const trades = chosen
    .filter((o) => filled.has(o.id))
    .map((o) => {
      const sellsA = o.order.sellToken.toLowerCase() === tokenA.toLowerCase();
      const fill = clearing.fills.find((f) => f.id === o.id)!;
      return {
        sellTokenIndex: sellsA ? 0n : 1n,
        buyTokenIndex: sellsA ? 1n : 0n,
        order: o.order,
        signature: o.signature,
        networkFee: 0n,
        headroom: fill.net > o.order.minBuyAmount ? fill.net - o.order.minBuyAmount : 0n,
        expectedGross: fill.gross,
      };
    });
  const interactions = clearing.swap
    ? [{
        adapter: dep.qwapAdapter,
        tokenInIndex: clearing.swap.sellsA ? 0n : 1n,
        tokenOutIndex: clearing.swap.sellsA ? 1n : 0n,
        amountIn: clearing.swap.amountIn,
        minAmountOut: clearing.swap.minAmountOut,
        data: '0x' as Hex,
      }]
    : [];
  const args = [[tokenA, tokenB], [clearing.r, PRICE_ONE], trades, interactions] as [Address[], bigint[], TradeArg[], unknown[]];
  // QMS value of one base unit of each token, from the pool (1 for WQMS itself).
  const aIsQms = tokenA.toLowerCase() === WQMS.toLowerCase();
  const bIsQms = tokenB.toLowerCase() === WQMS.toLowerCase();
  const qmsPer = {
    tokenA,
    a: aIsQms ? 1 : bIsQms ? Number(res.b) / Number(res.a) : 0,
    b: bIsQms ? 1 : aIsQms ? Number(res.a) / Number(res.b) : 0,
  };

  return {
    tokenA,
    tokenB,
    qubo,
    selection,
    matrixMarket: toMatrixMarket(qubo, `Qalibre batch, pair ${tokenA}/${tokenB}, reserves at block ${res.block}`),
    clearing,
    args,
    reservesBlock: res.block,
    qmsPer,
  };
}

/**
 * Network fee at cost: estimate the batch's gas, split it evenly per trade, convert to each trader's buy token,
 * and never exceed the signed maximum, the contract's 0.5% cap, or the trade's headroom above its minimum.
 */
async function applyNetworkFees(client: PublicClient, dep: Deployment, solver: LocalAccount, plan: BatchPlan) {
  const [tokens, prices, trades, interactions] = plan.args;
  const strip = (t: TradeArg) => ({ sellTokenIndex: t.sellTokenIndex, buyTokenIndex: t.buyTokenIndex, order: t.order, signature: t.signature, networkFee: t.networkFee });
  const gas = await client.estimateContractGas({ address: dep.settlement, abi: QalibreSettlementAbi, functionName: 'settle', args: [tokens, prices, trades.map(strip), interactions] as never, account: solver });
  // At cost: the block's base fee, which is what the batch actually pays (we add only a negligible tip).
  // Deliberately not eth_gasPrice, which suggests about 2x the base fee and would overcharge users.
  const baseFee = (await client.getBlock({ blockTag: 'latest' })).baseFeePerGas ?? 0n;
  // eth_estimateGas runs ~30% above gas actually used (measured: 601k used), so charge 70% of the estimate:
  // users pay at cost or less, and Qalibre absorbs any difference.
  const perTradeWei = (gas * baseFee * 70n) / 100n / BigInt(Math.max(1, trades.length));
  for (const t of trades) {
    const buyIsA = t.order.buyToken.toLowerCase() === plan.qmsPer.tokenA.toLowerCase();
    const qmsPerUnit = buyIsA ? plan.qmsPer.a : plan.qmsPer.b;
    let fee = qmsPerUnit > 0 ? BigInt(Math.ceil(Number(perTradeWei) / qmsPerUnit)) : 0n;
    const cap = (t.expectedGross * 50n) / 10_000n;
    for (const limit of [t.order.maxNetworkFee, cap, t.headroom]) if (fee > limit) fee = limit;
    t.networkFee = fee;
  }
  return trades.map(strip);
}

/** Simulate against the current chain state, then submit and wait for confirmations. */
export async function executeBatch(client: PublicClient, dep: Deployment, solver: LocalAccount, plan: BatchPlan, confirmations?: bigint): Promise<BatchResult> {
  const trades = await applyNetworkFees(client, dep, solver, plan);
  const { request } = await client.simulateContract({
    address: dep.settlement,
    abi: QalibreSettlementAbi,
    functionName: 'settle',
    args: [plan.args[0], plan.args[1], trades, plan.args[3]] as never,
    account: solver,
  });
  // Explicit fees: a negligible tip keeps the real cost at the base fee we charged against.
  const base = (await client.getBlock({ blockTag: 'latest' })).baseFeePerGas ?? 0n;
  const hash = await walletClient(solver).writeContract({ ...(request as object), maxPriorityFeePerGas: 1_000n, maxFeePerGas: base * 2n + 1_000n } as never);
  const receipt = await waitForConfirmations(client, hash, confirmations);
  const receipts: BatchResult['receipts'] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== dep.settlement.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: QalibreSettlementAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'TradeSettled') {
        const a = ev.args as unknown as BatchResult['receipts'][number];
        receipts.push({ account: a.account, orderDigest: a.orderDigest, sellAmount: a.sellAmount, buyAmount: a.buyAmount, fee: a.fee, networkFee: a.networkFee, directQuote: a.directQuote });
      }
    } catch {
      /* not one of ours */
    }
  }
  return { hash, block: receipt.blockNumber, receipts };
}
