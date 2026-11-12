/**
 * Everything that touches the QMS chain: clients, order signing, pool reads, batch submission.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  concat,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type LocalAccount,
} from 'viem';
import { QalibreSettlementAbi } from './abi/QalibreSettlement.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface Deployment {
  chainId: number;
  settlement: Address;
  accountFactory: Address;
  qwapAdapter: Address;
  qwapRouter: Address;
  entryPoint: Address;
  solver: Address;
}

export function loadDeployment(): Deployment {
  const path = join(here, '..', '..', 'contracts', 'deployments', '19480.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Deployment;
}

export const RPC_URL = process.env.QMS_RPC_URL ?? 'https://rpc.testnet.qms.finance';
/** Wrapped native QMS on QMS testnet (the token the QWAP pools use). */
export const WQMS: Address = '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34';
/** Measured gas for one trade inside a batch (settle overhead amortised), used for up-front estimates. */
export const GAS_PER_TRADE = 260_000n;
export const EXPLORER = 'https://testnet.qmsscan.io';

export const qmsTestnet = defineChain({
  id: 19480,
  name: 'QMS Testnet',
  nativeCurrency: { name: 'QMS', symbol: 'QMS', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'QMS Explorer', url: EXPLORER } },
});

export function publicClient(): PublicClient {
  return createPublicClient({ chain: qmsTestnet, transport: http(RPC_URL, { retryCount: 4, retryDelay: 500 }) }) as PublicClient;
}

export function walletClient(account: LocalAccount): WalletClient {
  return createWalletClient({ account, chain: qmsTestnet, transport: http(RPC_URL, { retryCount: 4, retryDelay: 500 }) });
}

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function deposit() payable',
]);

export const factoryV2Abi = parseAbi(['function getPair(address,address) view returns (address)']);
export const pairAbi = parseAbi([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
]);
export const routerAbi = parseAbi([
  'function factory() view returns (address)',
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])',
]);

// ---------------------------------------------------------------------------------------------
// Orders (EIP-712, domain bound to the settlement contract)
// ---------------------------------------------------------------------------------------------

export interface Order {
  account: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  minBuyAmount: bigint;
  maxNetworkFee: bigint;
  validTo: bigint;
  nonce: bigint;
}

export const orderTypes = {
  Order: [
    { name: 'account', type: 'address' },
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'minBuyAmount', type: 'uint256' },
    { name: 'maxNetworkFee', type: 'uint256' },
    { name: 'validTo', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export const SIG_KIND_OWNER = '0x00' as const;
export const SIG_KIND_SESSION = '0x01' as const;

export function orderDomain(settlement: Address) {
  return { name: 'Qalibre Settlement', version: '2', chainId: qmsTestnet.id, verifyingContract: settlement } as const;
}

/** Sign an order with a session key. The account checks the key's limits on-chain. */
export async function signOrderAsSession(session: LocalAccount, settlement: Address, order: Order): Promise<Hex> {
  const sig = await session.signTypedData({ domain: orderDomain(settlement), types: orderTypes, primaryType: 'Order', message: order });
  return concat([SIG_KIND_SESSION, sig]);
}

// ---------------------------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------------------------

/**
 * Reserves of the QWAP pair for (tokenA, tokenB), oriented by ARGUMENT ORDER:
 * `a` is always the reserve of `tokenA` (the first argument) and `b` of `tokenB`, whatever their addresses.
 */
const factoryOf = new Map<string, Address>();
const pairOf = new Map<string, { pair: Address; token0: Address }>();

/**
 * Pair address and token0 never change once a pool exists, so they are cached for the life of the process
 * (a missing pool is not cached: it may be created later). Reserves and the block are always read fresh.
 */
async function pairInfo(client: PublicClient, router: Address, tokenA: Address, tokenB: Address) {
  const key = [router, tokenA, tokenB].map((x) => x.toLowerCase()).sort().join(':');
  const hit = pairOf.get(key);
  if (hit) return hit;
  let factory = factoryOf.get(router.toLowerCase());
  if (!factory) {
    factory = await client.readContract({ address: router, abi: routerAbi, functionName: 'factory' });
    factoryOf.set(router.toLowerCase(), factory);
  }
  const pair = await client.readContract({ address: factory, abi: factoryV2Abi, functionName: 'getPair', args: [tokenA, tokenB] });
  if (pair === '0x0000000000000000000000000000000000000000') throw new Error('no QWAP pool for this pair');
  const token0 = await client.readContract({ address: pair, abi: pairAbi, functionName: 'token0' });
  const info = { pair, token0 };
  pairOf.set(key, info);
  return info;
}

export async function readReserves(client: PublicClient, router: Address, tokenA: Address, tokenB: Address) {
  const { pair, token0 } = await pairInfo(client, router, tokenA, tokenB);
  const [[r0, r1], block] = await Promise.all([
    client.readContract({ address: pair, abi: pairAbi, functionName: 'getReserves' }),
    client.getBlockNumber(),
  ]);
  const aIs0 = token0.toLowerCase() === tokenA.toLowerCase();
  return { pair, a: aIs0 ? r0 : r1, b: aIs0 ? r1 : r0, block };
}

// ---------------------------------------------------------------------------------------------
// Confirmations: QMS testnet's `finalized` tag returns genesis, so count blocks instead.
// ---------------------------------------------------------------------------------------------

export const CONFIRMATIONS = BigInt(process.env.CONFIRMATIONS ?? '3');

/** Thrown when a transaction left the chain in a reorganization and did not come back. */
export class DroppedByReorg extends Error {}

/**
 * Wait until `hash` is `confirmations` blocks deep on the canonical chain.
 * QMS blocks are probabilistic and short reorganizations happen (observed on testnet). A transaction that is
 * reorganized out is usually re-included from the mempool in a later block, so we follow it: if it reappears,
 * counting restarts from its new block. If it does not reappear within `reincludeMs`, DroppedByReorg is thrown.
 */
export async function waitForConfirmations(client: PublicClient, hash: Hex, confirmations = CONFIRMATIONS, reincludeMs = 120_000) {
  let receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 700 });
  for (let reorgs = 0; reorgs < 5; reorgs++) {
    if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
    const target = receipt.blockNumber + confirmations - 1n;
    while ((await client.getBlockNumber()) < target) await new Promise((r) => setTimeout(r, 1_500));
    const again = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (again && again.blockHash === receipt.blockHash) return receipt;
    // Reorganized: wait for the transaction to be re-included, then count again from its new block.
    try {
      receipt = again ?? (await client.waitForTransactionReceipt({ hash, timeout: reincludeMs, pollingInterval: 1_000 }));
    } catch {
      throw new DroppedByReorg(`transaction left the chain in a reorganization and was not re-included: ${hash}`);
    }
  }
  throw new DroppedByReorg(`transaction kept being reorganized: ${hash}`);
}

export { QalibreSettlementAbi };
