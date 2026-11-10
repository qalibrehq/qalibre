import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');

/** Reads contracts/.env (the single secrets file) without printing anything. Process env wins. */
function loadEnvFile(): Record<string, string> {
  try {
    const text = readFileSync(join(ROOT, 'contracts', '.env'), 'utf8');
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
    );
  } catch {
    return {};
  }
}

const file = loadEnvFile();
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? file[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`missing config: ${name}`);
  return v;
}

export const config = {
  rpcUrl: env('QMS_RPC_URL', 'https://rpc.testnet.qms.finance'),
  botToken: env('TELEGRAM_BOT_TOKEN'),
  miniAppUrl: process.env.MINIAPP_URL ?? file.MINIAPP_URL ?? '',
  port: Number(env('PORT', '8787')),
  /** Relayer pays gas for account creation and test-token drips (the deployer on testnet). */
  relayerKey: env('DEPLOYER_PRIVATE_KEY') as Hex,
  solverKey: env('SOLVER_PRIVATE_KEY') as Hex,
  sponsorKey: env('SPONSOR_SIGNER_PRIVATE_KEY') as Hex,
  sessionEncKey: env('SESSION_ENC_KEY'),
  /** How often the engine looks for a batch to run. */
  tickMs: Number(env('TICK_MS', '1000')),
  /** Best-price orders wait at most this long for a trader on the other side. */
  bestWindowMs: Number(env('BEST_WINDOW_MS', '5000')),
  /** Blocks before a fill is marked final (the first block already shows it as filled). */
  finalConfirmations: BigInt(env('FINAL_CONFIRMATIONS', '3')),
  orderTtlSec: Number(env('ORDER_TTL_SEC', '300')),
  defaultSlippageBps: BigInt(env('DEFAULT_SLIPPAGE_BPS', '50')),
  /** Test tokens given to each new user so they can trade within 30 seconds (testnet only). */
  drip: {
    wqms: BigInt(env('DRIP_WQMS_WEI', '100000000000000000')), // 0.1 WQMS
    usdc: BigInt(env('DRIP_USDC_UNITS', '200000')), // 0.2 USDC
  },
  dbPath: env('DB_PATH', join(ROOT, 'backend', 'data', 'qalibre.sqlite')),
  /** Allowed Mini App origins for CORS. */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? file.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
};

export const TOKENS = {
  WQMS: '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34' as Address,
  USDC: '0xDfF68E53a0A8275212927c12017f5aB5f1842a04' as Address,
};

export const TOKEN_INFO: Record<string, { symbol: string; decimals: number; name: string }> = {
  [TOKENS.WQMS.toLowerCase()]: { symbol: 'QMS', decimals: 18, name: 'QMS' },
  [TOKENS.USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6, name: 'USD Coin' },
};
