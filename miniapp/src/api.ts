import { tg } from './tg';

export const TOKENS = {
  QMS: { address: '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34', decimals: 18, symbol: 'QMS' },
  USDC: { address: '0xDfF68E53a0A8275212927c12017f5aB5f1842a04', decimals: 6, symbol: 'USDC' },
} as const;
export type Sym = keyof typeof TOKENS;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': tg?.initData ?? '', ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError('No connection. Check your internet and try again.', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? 'Something went wrong. Please try again.', res.status);
  return body as T;
}

export interface Me {
  registered: boolean;
  account?: string;
  owner?: string;
  firstName?: string;
  price?: { usdcPerQms: number };
  holdings?: { symbol: string; name: string; amount: number; valueUsd: number; token: string }[];
  totalUsd?: number;
  savedUsd?: number;
  trades?: number;
  session?: { active: boolean; validUntil: number };
  unwrappedQms?: number;
  testFundsAt?: number;
}

export interface BatchStatus { nextBatchInMs: number; waiting: number; batch: number; intervalMs: number; lastRunAt: number }
export interface Quote { direct: string; minOut: string; likely: string; waiting: number }
export interface OrderRow {
  id: string;
  account: string;
  sell_token: string;
  buy_token: string;
  sell_amount: string;
  min_buy_amount: string;
  status: 'pending' | 'filled' | 'expired' | 'failed';
  reason: string | null;
  tx_hash: string | null;
  buy_amount: string | null;
  fee: string | null;
  direct_quote: string | null;
  batch_id: number | null;
  created_at: number;
  updated_at: number;
}

export const api = {
  me: () => call<Me>('/api/me'),
  batch: () => call<BatchStatus>('/api/batch'),
  prepare: (owner: string) => call<{ setupHash: `0x${string}`; account: string; limits: { token: string; perTrade: string; perDay: string }[]; validUntil: number }>('/api/register/prepare', { method: 'POST', body: JSON.stringify({ owner }) }),
  complete: (signature: string) => call<{ account: string }>('/api/register/complete', { method: 'POST', body: JSON.stringify({ signature }) }),
  quote: (sell: string, buy: string, amount: bigint) => call<Quote>(`/api/quote?sell=${sell}&buy=${buy}&amount=${amount}`),
  order: (sell: string, buy: string, amount: bigint, mode: 'instant' | 'best') => call<{ id: string; minOut: string; likely: string; direct: string; nextBatchInMs: number }>('/api/orders', { method: 'POST', body: JSON.stringify({ sell, buy, amount: amount.toString(), mode }) }),
  orders: () => call<{ orders: OrderRow[] }>('/api/orders'),
  testFunds: () => call<{ wqms: string; usdc: string }>('/api/test-funds', { method: 'POST' }),
  orderById: (id: string) => call<OrderRow>(`/api/orders/${id}`),
};

export function tokenBy(address: string) {
  return Object.values(TOKENS).find((t) => t.address.toLowerCase() === address.toLowerCase()) ?? TOKENS.USDC;
}

/** Parse a decimal string ("12.5") into base units. */
export function toUnits(value: string, decimals: number): bigint {
  const [w = '0', f = ''] = value.split('.');
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Format base units for display with up to `max` decimals, trimming zeros. */
export function fromUnits(v: bigint | string, decimals: number, max = 4): string {
  const x = typeof v === 'string' ? BigInt(v) : v;
  const neg = x < 0n;
  const a = neg ? -x : x;
  const base = 10n ** BigInt(decimals);
  const whole = (a / base).toLocaleString('en-US');
  const frac = (a % base).toString().padStart(decimals, '0').slice(0, max).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
