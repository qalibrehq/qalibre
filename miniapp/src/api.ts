import { tg } from './tg';

export const TOKENS = {
  QMS: { address: '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34', decimals: 18, symbol: 'QMS' },
  USDC: { address: '0xDfF68E53a0A8275212927c12017f5aB5f1842a04', decimals: 6, symbol: 'USDC' },
} as const;
export type Sym = keyof typeof TOKENS;

export class ApiError extends Error {
  /** `code` names a refusal the app can act on (needs_approval, high_impact); `data` carries its details. */
  constructor(message: string, readonly status: number, readonly code?: string, readonly data: Record<string, unknown> = {}) {
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
  if (!res.ok) {
    const b = body as { error?: string; code?: string } & Record<string, unknown>;
    throw new ApiError(b.error ?? 'Something went wrong. Please try again.', res.status, b.code, b);
  }
  return body as T;
}

export interface Me {
  registered: boolean;
  upgraded?: boolean;
  account?: string;
  owner?: string;
  firstName?: string;
  price?: { usdcPerQms: number };
  holdings?: { symbol: string; name: string; amount: number; valueUsd: number; token: string }[];
  /** Tokens bought through chat trading. `balance` is in base units; value is what selling all would return now. */
  positions?: { symbol: string; name: string; token: string; decimals: number; balance: string; amount: number; valueUsd: number; pnlPct: number | null }[];
  totalUsd?: number;
  /** The user's invite link and what it has earned (QMS amounts in base units). */
  invite?: { link: string; invited: number; trading: number; earnedQms: string; paidQms: string; sharePct: number; days: number };
  /** The bot's username, to return to the chat. */
  bot?: string;
  savedUsd?: number;
  trades?: number;
  session?: { active: boolean; validUntil: number; anyBuyToken?: boolean };
  limits?: { token: string; symbol: string; decimals: number; perTrade: number; perDay: number; spentToday: number }[];
  unwrappedQms?: number;
  testFundsAt?: number;
}

export interface BatchStatus { nextBatchInMs: number; waiting: number; batch: number; intervalMs: number; lastRunAt: number }
export interface Quote { direct: string; minOut: string; likely: string; waiting: number; maxNetworkFee: string }
export interface OrderRow {
  id: string;
  account: string;
  sell_token: string;
  buy_token: string;
  sell_amount: string;
  min_buy_amount: string;
  max_network_fee: string;
  network_fee: string | null;
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

export interface Safety {
  token: { address: string; symbol: string; name: string; decimals: number; verified: boolean };
  verdict: 'blocked' | 'high' | 'caution' | 'ok';
  score: number;
  findings: { level: 'danger' | 'caution' | 'pass' | 'unknown'; title: string; detail: string }[];
  tradable: boolean;
  reason?: string;
  priceQms: number;
  priceUsd: number;
  liquidityUsd: number;
  checkedAt: number;
}

export const api = {
  token: (address: string) => call<Safety>(`/api/token?address=${encodeURIComponent(address)}`),
  me: () => call<Me>('/api/me'),
  batch: () => call<BatchStatus>('/api/batch'),
  prepare: (owner: string) => call<{ setupHash: `0x${string}`; account: string; limits: { token: string; perTrade: string; perDay: string }[]; validUntil: number }>('/api/register/prepare', { method: 'POST', body: JSON.stringify({ owner }) }),
  complete: (signature: string) => call<{ account: string }>('/api/register/complete', { method: 'POST', body: JSON.stringify({ signature }) }),
  quote: (sell: string, buy: string, amount: bigint) => call<Quote>(`/api/quote?sell=${sell}&buy=${buy}&amount=${amount}`),
  order: (sell: string, buy: string, amount: bigint, mode: 'instant' | 'best', acceptImpact = false) => call<{ id: string; minOut: string; likely: string; direct: string; nextBatchInMs: number }>('/api/orders', { method: 'POST', body: JSON.stringify({ sell, buy, amount: amount.toString(), mode, acceptImpact }) }),
  orders: () => call<{ orders: OrderRow[] }>('/api/orders'),
  testFunds: () => call<{ wqms: string; usdc: string }>('/api/test-funds', { method: 'POST' }),
  orderById: (id: string) => call<OrderRow>(`/api/orders/${id}`),
};


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

/** A token the app can show: address, symbol, decimals. */
export interface TokenRef {
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * Every token this user may see: QMS, USDC, and the tokens they hold from chat trading. Unknown addresses get a
 * short-address label and 18 decimals rather than being mistaken for a known token.
 */
export function tokenMeta(me: Me, extra: TokenRef[] = []) {
  const m = new Map<string, TokenRef>();
  for (const t of [TOKENS.QMS, TOKENS.USDC]) m.set(t.address.toLowerCase(), t);
  for (const p of me.positions ?? []) m.set(p.token.toLowerCase(), { address: p.token, symbol: p.symbol, decimals: p.decimals });
  for (const t of extra) m.set(t.address.toLowerCase(), t);
  return (a: string): TokenRef => m.get(a.toLowerCase()) ?? { address: a, symbol: `${a.slice(0, 6)}…`, decimals: 18 };
}
