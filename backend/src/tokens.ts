/**
 * Token lookup and the safety check. See docs/CHAT_TRADING.md for the threat list this implements.
 */
import { getAddress, isAddress, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { TOKENS } from './config.js';
import { SAFETY_PROBE_CODE, safetyProbeAbi } from './probe.js';
import { loadDeployment, publicClient, readReserves } from '../../solver/src/chain.js';

const dep = loadDeployment();
const client = publicClient();
const EXPLORER_API = 'https://testnet.qmsscan.io/api/v2';

const erc20Meta = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
]);

export interface TokenInfo {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  verified: boolean; // in Qalibre's own registry (QMS, USDC)
}

export interface Finding {
  level: 'danger' | 'caution' | 'pass' | 'unknown';
  title: string;
  detail: string;
}

export interface Safety {
  token: TokenInfo;
  verdict: 'blocked' | 'high' | 'caution' | 'ok';
  score: number;
  findings: Finding[];
  tradable: boolean; // false => no Buy buttons anywhere
  reason?: string; // why not tradable, in plain words
  priceUsd: number;
  priceQms: number;
  liquidityUsd: number;
  checkedAt: number;
}

/** Registry of tokens Qalibre vouches for. Symbols resolve only to these; everything else needs an address. */
const REGISTRY: TokenInfo[] = [
  { address: TOKENS.WQMS, symbol: 'QMS', name: 'QMS', decimals: 18, verified: true },
  { address: TOKENS.USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, verified: true },
];

/** Strip control, bidi and zero-width characters (look-alike tricks), collapse spaces, cap length. */
export function cleanText(s: string, max = 32): string {
  const cleaned = s
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned || 'Unknown';
}

const metaCache = new Map<string, TokenInfo>();

export async function tokenInfo(address: Address): Promise<TokenInfo> {
  const key = address.toLowerCase();
  const reg = REGISTRY.find((t) => t.address.toLowerCase() === key);
  if (reg) return reg;
  const cached = metaCache.get(key);
  if (cached) return cached;
  const code = await client.getCode({ address });
  if (!code || code === '0x') throw new Error('not_a_contract');
  const read = async <T>(fn: 'name' | 'symbol' | 'decimals'): Promise<T | null> => {
    try {
      return (await client.readContract({ address, abi: erc20Meta, functionName: fn })) as T;
    } catch {
      return null;
    }
  };
  const [name, symbol, decimals] = await Promise.all([read<string>('name'), read<string>('symbol'), read<number>('decimals')]);
  if (decimals === null || decimals > 36) throw new Error('not_a_token');
  const info: TokenInfo = { address: getAddress(address), symbol: cleanText(symbol ?? '?', 12), name: cleanText(name ?? 'Unknown token', 32), decimals: Number(decimals), verified: false };
  metaCache.set(key, info);
  return info;
}

/**
 * Resolve user input to a token. Addresses resolve directly. Symbols resolve only to registry tokens; an
 * unknown symbol never silently picks one of possibly many copycats.
 */
export async function resolveToken(input: string): Promise<{ token?: TokenInfo; error?: string }> {
  const raw = input.trim().replace(/^\$/, '');
  const m = raw.match(/0x[0-9a-fA-F]{40}/);
  if (m && isAddress(m[0])) {
    try {
      return { token: await tokenInfo(getAddress(m[0]) as Address) };
    } catch (e) {
      return { error: (e as Error).message === 'not_a_contract' ? 'There is no contract at that address on QMS.' : 'That address doesn\'t look like a token on QMS. Check it and paste it again.' };
    }
  }
  const sym = raw.toUpperCase();
  const hit = REGISTRY.find((t) => t.symbol === sym || (sym === 'WQMS' && t.symbol === 'QMS'));
  if (hit) return { token: hit };
  return { error: `To avoid copycat tokens, Qalibre only recognises QMS and USDC by name. Paste the token's contract address instead.` };
}

// ---------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------

let usdCache = { at: 0, v: 0 };
/** USD per QMS from the QMS/USDC pool. Used for display only, so a 5-second cache is fine. */
export async function qmsUsd(): Promise<number> {
  if (Date.now() - usdCache.at < 5_000) return usdCache.v;
  // readReserves orients by argument order: a = WQMS reserve, b = USDC reserve.
  const r = await readReserves(client, dep.qwapRouter, TOKENS.WQMS, TOKENS.USDC);
  usdCache = { at: Date.now(), v: Number(r.b) / 1e6 / (Number(r.a) / 1e18) };
  return usdCache.v;
}

/** Token price in QMS from its QMS pool, and the QMS side of the pool. */
export async function poolOf(token: TokenInfo) {
  // readReserves orients by argument order: a = token reserve, b = WQMS reserve.
  const r = await readReserves(client, dep.qwapRouter, token.address, TOKENS.WQMS);
  const [t, w] = [r.a, r.b];
  const priceQms = Number(w) / 1e18 / (Number(t) / 10 ** token.decimals);
  return { tokenReserve: t, qmsReserve: w, priceQms };
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

/** Known function selectors that signal creator powers (searched as PUSH4 operands in the bytecode). */
const POWERS: { sel: string; title: string; detail: string; weight: number }[] = [
  { sel: '40c10f19', title: 'The creator can make more', detail: 'New tokens can be created at any time, which can push the price down.', weight: 20 },
  { sel: 'a0712d68', title: 'The creator can make more', detail: 'New tokens can be created at any time, which can push the price down.', weight: 20 },
  { sel: '8456cb59', title: 'Trading can be paused', detail: 'The creator can stop all transfers, which would lock your tokens.', weight: 15 },
  { sel: 'f9f92be4', title: 'Wallets can be blacklisted', detail: 'The creator can block specific wallets from selling.', weight: 20 },
  { sel: '44337ea1', title: 'Wallets can be blacklisted', detail: 'The creator can block specific wallets from selling.', weight: 20 },
  { sel: '061c82d0', title: 'Fees can be changed', detail: 'The creator can add or raise a transfer tax later.', weight: 15 },
  { sel: 'ec28438a', title: 'Trade size can be capped', detail: 'The creator can limit how much can be sold at once.', weight: 10 },
];
const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const safetyCache = new Map<string, Safety>();

/** Listeners told about every completed check (the public counters). Registry tokens are not counted. */
const checkedListeners: ((s: Safety) => void)[] = [];
export function onTokenChecked(fn: (s: Safety) => void) {
  checkedListeners.push(fn);
}
const CACHE_MS = 120_000;

async function explorer<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${EXPLORER_API}${path}`, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Simulated buy and sell, with a random throwaway address and a randomized amount. Nothing is spent. */
export async function probe(token: Address, valueWei: bigint) {
  const probeAddr = privateKeyToAccount(generatePrivateKey()).address;
  const caller = privateKeyToAccount(generatePrivateKey()).address;
  const { data } = await client.call({
    account: caller,
    to: probeAddr,
    value: valueWei,
    gas: 3_000_000n,
    data: (await import('viem')).encodeFunctionData({ abi: safetyProbeAbi, functionName: 'probe', args: [dep.qwapRouter, TOKENS.WQMS, token] }),
    stateOverride: [
      { address: probeAddr, code: SAFETY_PROBE_CODE as Hex },
      { address: caller, balance: valueWei * 10n },
    ],
  });
  const { decodeFunctionResult } = await import('viem');
  const r = decodeFunctionResult({ abi: safetyProbeAbi, functionName: 'probe', data: data! }) as unknown as {
    buyOk: boolean; sellOk: boolean; expectedBuy: bigint; bought: bigint; expectedSell: bigint; soldFor: bigint;
  };
  const taxBps = (expected: bigint, got: bigint) => (expected > 0n && got < expected ? Number(((expected - got) * 10_000n) / expected) : 0);
  return { buyOk: r.buyOk, sellOk: r.sellOk, buyTaxBps: taxBps(r.expectedBuy, r.bought), sellTaxBps: taxBps(r.expectedSell, r.soldFor) };
}

export async function checkToken(address: Address, opts: { fresh?: boolean } = {}): Promise<Safety> {
  const key = address.toLowerCase();
  const cached = safetyCache.get(key);
  if (!opts.fresh && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;

  const token = await tokenInfo(address);
  const usdPerQms = await qmsUsd();
  if (token.verified) {
    const s: Safety = {
      token, verdict: 'ok', score: 100, tradable: true,
      findings: [{ level: 'pass', title: 'Verified by Qalibre', detail: 'A core QMS testnet asset Qalibre supports directly.' }],
      priceQms: token.address.toLowerCase() === TOKENS.WQMS.toLowerCase() ? 1 : 1 / usdPerQms,
      priceUsd: token.address.toLowerCase() === TOKENS.WQMS.toLowerCase() ? usdPerQms : 1,
      liquidityUsd: 0, checkedAt: Date.now(),
    };
    safetyCache.set(key, s);
    return s;
  }

  // The four checks are independent, so they run in parallel; the verdict's precedence is applied after.
  type Part = { findings: Finding[]; delta: number; blocked?: string };

  const poolPart = async (): Promise<Part & { priceQms: number; liquidityUsd: number }> => {
    try {
      const pool = await poolOf(token);
      const liquidityUsd = (Number(pool.qmsReserve) / 1e18) * usdPerQms * 2;
      const usd = `$${Math.round(liquidityUsd).toLocaleString('en-US')}`;
      return liquidityUsd < 1_000
        ? { priceQms: pool.priceQms, liquidityUsd, delta: -20, findings: [{ level: 'caution', title: 'Small pool', detail: `About ${usd} available to trade. Even small trades move the price.` }] }
        : { priceQms: pool.priceQms, liquidityUsd, delta: 0, findings: [{ level: 'pass', title: 'Pool size', detail: `About ${usd} available to trade.` }] };
    } catch {
      return { priceQms: 0, liquidityUsd: 0, delta: 0, blocked: 'This token has no QWAP pool against QMS, so Qalibre cannot trade it.', findings: [{ level: 'danger', title: 'No pool against QMS', detail: 'There is nowhere to trade it.' }] };
    }
  };

  const probePart = async (): Promise<Part> => {
    try {
      const amount = 10n ** 16n + BigInt(Math.floor(Math.random() * 1e15)); // ~0.01 QMS, randomized
      const p = await probe(token.address, amount);
      if (!p.buyOk) return { delta: 0, blocked: 'A simulated purchase failed, so this token cannot be bought right now.', findings: [{ level: 'danger', title: 'Buying fails', detail: 'A simulated purchase did not go through.' }] };
      if (!p.sellOk) return { delta: 0, blocked: 'You could buy this token but not sell it. This is a honeypot.', findings: [{ level: 'danger', title: 'You cannot sell it', detail: 'A simulated sale was blocked. This is how honeypot scams work.' }] };
      if (p.buyTaxBps > 50 || p.sellTaxBps > 50) {
        return {
          delta: 0,
          blocked: `This token takes a hidden tax (about ${(p.buyTaxBps / 100).toFixed(0)}% to buy, ${(p.sellTaxBps / 100).toFixed(0)}% to sell). Qalibre does not trade taxed tokens yet.`,
          findings: [{ level: 'danger', title: 'Hidden transfer tax', detail: `About ${(p.buyTaxBps / 100).toFixed(1)}% on buys and ${(p.sellTaxBps / 100).toFixed(1)}% on sells.` }],
        };
      }
      return { delta: 0, findings: [{ level: 'pass', title: 'You can sell it', detail: 'A simulated buy and sale both went through, with no hidden tax.' }] };
    } catch {
      return { delta: -25, findings: [{ level: 'unknown', title: 'Sale could not be simulated', detail: 'We could not test selling this token right now.' }] };
    }
  };

  const codePart = async (): Promise<Part> => {
    const findings: Finding[] = [];
    let delta = 0;
    try {
      const [code, impl, owner] = await Promise.all([
        client.getCode({ address: token.address }),
        client.getStorageAt({ address: token.address, slot: EIP1967_IMPL }),
        client.readContract({ address: token.address, abi: erc20Meta, functionName: 'owner' }).catch(() => null), // no owner() is fine
      ]);
      const seen = new Set<string>();
      for (const p of POWERS) {
        if ((code ?? '0x').includes('63' + p.sel) && !seen.has(p.title)) {
          seen.add(p.title);
          findings.push({ level: 'caution', title: p.title, detail: p.detail });
          delta -= p.weight;
        }
      }
      if (impl && BigInt(impl) !== 0n) {
        findings.push({ level: 'caution', title: 'The code can be changed', detail: 'This token is upgradeable, so its rules can change after you buy.' });
        delta -= 15;
      }
      if (owner !== null) {
        if (BigInt(owner) === 0n || owner.toLowerCase() === '0x000000000000000000000000000000000000dead') {
          findings.push({ level: 'pass', title: 'No owner', detail: 'The creator has given up control of the contract.' });
        } else if (seen.size > 0) {
          findings.push({ level: 'caution', title: 'The creator still has control', detail: 'The powers above are still active.' });
          delta -= 5;
        }
      }
    } catch {
      findings.push({ level: 'unknown', title: 'Code could not be read', detail: 'We could not check the contract for creator powers.' });
      delta -= 10;
    }
    return { findings, delta };
  };

  // Explorer: verified source, age, holder concentration. Unknown is never "passed".
  const explorerPart = async (): Promise<Part> => {
    const findings: Finding[] = [];
    let delta = 0;
    const [addr, holders, supply] = await Promise.all([
      explorer<{ is_verified?: boolean; creation_tx_hash?: string }>(`/addresses/${token.address}`),
      explorer<{ items?: { value?: string; address?: { hash?: string; is_contract?: boolean } }[] }>(`/tokens/${token.address}/holders`),
      client.readContract({ address: token.address, abi: erc20Meta, functionName: 'totalSupply' }).catch(() => 0n),
    ]);
    if (addr === null) return { delta: -10, findings: [{ level: 'unknown', title: 'Explorer unavailable', detail: 'Source code, age and holders could not be checked right now.' }] };
    if (addr.is_verified) findings.push({ level: 'pass', title: 'Code is public', detail: 'Its source is verified on the QMS Explorer.' });
    else {
      findings.push({ level: 'caution', title: 'Code is hidden', detail: 'The source is not verified, so nobody can easily check what it does.' });
      delta -= 10;
    }
    if (addr.creation_tx_hash) {
      const tx = await explorer<{ timestamp?: string }>(`/transactions/${addr.creation_tx_hash}`);
      if (tx?.timestamp) {
        const ageH = (Date.now() - Date.parse(tx.timestamp)) / 3_600_000;
        if (ageH < 24) {
          findings.push({ level: 'caution', title: 'Brand new', detail: `Created ${ageH < 1 ? 'less than an hour' : Math.floor(ageH) + ' hours'} ago.` });
          delta -= 10;
        }
      }
    }
    if (holders?.items && supply > 0n) {
      const top = holders.items.filter((h) => !h.address?.is_contract).slice(0, 5).reduce((s, h) => s + BigInt(h.value ?? '0'), 0n);
      const pct = Number((top * 1000n) / supply) / 10;
      if (pct > 50) {
        findings.push({ level: 'caution', title: `Five wallets hold ${Math.round(pct)}%`, detail: 'A few holders selling could move the price sharply.' });
        delta -= 15;
      }
    }
    return { findings, delta };
  };

  const [pool, sim, codeRes, exp] = await Promise.all([poolPart(), probePart(), codePart(), explorerPart()]);
  // Without a pool the simulation is meaningless, so the pool verdict comes first.
  const blocked = pool.blocked ?? sim.blocked;
  const parts = pool.blocked ? [pool, codeRes, exp] : [pool, sim, codeRes, exp];
  const findings: Finding[] = parts.flatMap((p) => p.findings);
  let score = 100 + parts.reduce((s, p) => s + p.delta, 0);
  const { priceQms, liquidityUsd } = pool;

  score = Math.max(0, Math.min(100, score));
  const verdict: Safety['verdict'] = blocked ? 'blocked' : score < 50 ? 'high' : score < 80 ? 'caution' : 'ok';
  if (blocked) score = Math.min(score, 10);
  // Dangers first, then cautions, unknowns, passes.
  const order = { danger: 0, caution: 1, unknown: 2, pass: 3 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  const s: Safety = { token, verdict, score, findings, tradable: !blocked, reason: blocked, priceQms, priceUsd: priceQms * usdPerQms, liquidityUsd, checkedAt: Date.now() };
  safetyCache.set(key, s);
  for (const fn of checkedListeners) {
    try {
      fn(s);
    } catch {
      /* a counter must never break a check */
    }
  }
  return s;
}
