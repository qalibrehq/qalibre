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
    { name: 'validTo', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export const SIG_KIND_OWNER = '0x00' as const;
export const SIG_KIND_SESSION = '0x01' as const;

export function orderDomain(settlement: Address) {
  return { name: 'Qalibre Settlement', version: '1', chainId: qmsTestnet.id, verifyingContract: settlement } as const;
}

/** Sign an order with a session key. The account checks the key's limits on-chain. */
export async function signOrderAsSession(session: LocalAccount, settlement: Address, order: Order): Promise<Hex> {
  const sig = await session.signTypedData({ domain: orderDomain(settlement), types: orderTypes, primaryType: 'Order', message: order });
  return concat([SIG_KIND_SESSION, sig]);
}

// ---------------------------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------------------------

/** Reserves of the QWAP pair, oriented so `a` is the lower-address token. */
export async function readReserves(client: PublicClient, router: Address, tokenA: Address, tokenB: Address) {
  const factory = await client.readContract({ address: router, abi: routerAbi, functionName: 'factory' });
  const pair = await client.readContract({ address: factory, abi: factoryV2Abi, functionName: 'getPair', args: [tokenA, tokenB] });
  if (pair === '0x0000000000000000000000000000000000000000') throw new Error('no QWAP pool for this pair');
  const [[r0, r1], token0, block] = await Promise.all([
    client.readContract({ address: pair, abi: pairAbi, functionName: 'getReserves' }),
    client.readContract({ address: pair, abi: pairAbi, functionName: 'token0' }),
    client.getBlockNumber(),
  ]);
  const aIs0 = token0.toLowerCase() === tokenA.toLowerCase();
  return { pair, a: aIs0 ? r0 : r1, b: aIs0 ? r1 : r0, block };
}

// ---------------------------------------------------------------------------------------------
// Confirmations: QMS testnet's `finalized` tag returns genesis, so count blocks instead.
// ---------------------------------------------------------------------------------------------

export const CONFIRMATIONS = BigInt(process.env.CONFIRMATIONS ?? '3');

export async function waitForConfirmations(client: PublicClient, hash: Hex, confirmations = CONFIRMATIONS) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 2_000 });
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
  const target = receipt.blockNumber + confirmations - 1n;
  for (;;) {
    const head = await client.getBlockNumber();
    if (head >= target) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  // Re-check the receipt is still canonical after waiting (probabilistic block times can reorg).
  const again = await client.getTransactionReceipt({ hash });
  if (again.blockHash !== receipt.blockHash) throw new Error(`transaction was reorganized: ${hash}`);
  return receipt;
}

export { QalibreSettlementAbi };
