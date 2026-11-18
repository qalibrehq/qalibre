/**
 * We keep watching after you buy. Every few minutes the watcher takes a cheap reading of each token people
 * bought through Qalibre (the pool's QMS and the total supply), and every so often re-runs the full safety
 * check on a couple of them in turn. When something changes for the worse, everyone still holding it gets
 * one message with a one-tap Sell all.
 *
 * Built to stay inside free limits: one reading per token no matter how many people hold it, a hard cap on
 * tokens per tick, two full checks per tick, state kept in memory (no database writes), and holder balances
 * looked up only when there is something to say. After a restart the first reading becomes the new baseline.
 */
import type { Address } from 'viem';

export type AlertKind = 'liquidity' | 'minted' | 'blocked';

export interface Reading {
  qmsReserve: bigint;
  supply: bigint;
}

export interface WatchDeps {
  tokens(): string[];
  read(token: string): Promise<Reading>;
  /** A fresh full check: is selling now blocked (honeypot, frozen, taxed to nothing)? */
  sellBlocked(token: string): Promise<{ blocked: boolean; reason?: string }>;
  holders(token: string): Promise<{ tgId: number; balance: bigint }[]>;
  alert(tgId: number, token: Address, kind: AlertKind, detail: string): Promise<void>;
  now?: () => number;
}

export const WATCH = {
  everyMs: 5 * 60_000,
  liquidityDrop: 0.5, // the pool lost at least half its QMS since its peak
  mintGrowth: 0.1, // supply grew by at least 10%
  fullChecksPerTick: 2,
  cooldownMs: 24 * 3_600_000, // one alert per token and kind per day
};

interface State {
  peakQms: bigint;
  supply: bigint;
  blocked: boolean;
}

export function createWatcher(deps: WatchDeps) {
  const now = deps.now ?? Date.now;
  const state = new Map<string, State>();
  const lastAlert = new Map<string, number>();
  let rotation = 0;
  let running = false;

  async function raise(token: string, kind: AlertKind, detail: string) {
    const key = `${token}:${kind}`;
    if (now() - (lastAlert.get(key) ?? -Infinity) < WATCH.cooldownMs) return 0;
    lastAlert.set(key, now());
    const holders = (await deps.holders(token)).filter((h) => h.balance > 0n);
    for (const h of holders) await deps.alert(h.tgId, token as Address, kind, detail).catch((e) => console.error('watch alert', (e as Error).message));
    return holders.length;
  }

  /** One pass. Returns how many alerts went out, for logs and tests. */
  async function tick(): Promise<number> {
    if (running) return 0; // never overlap passes
    running = true;
    let sent = 0;
    try {
      const tokens = deps.tokens().map((t) => t.toLowerCase());
      for (const token of tokens) {
        const r = await deps.read(token).catch(() => null);
        if (!r) continue;
        const s = state.get(token);
        if (!s) {
          state.set(token, { peakQms: r.qmsReserve, supply: r.supply, blocked: false });
          continue;
        }
        if (s.peakQms > 0n && r.qmsReserve * 1000n <= s.peakQms * BigInt(Math.round((1 - WATCH.liquidityDrop) * 1000))) {
          const pct = Number(((s.peakQms - r.qmsReserve) * 100n) / s.peakQms);
          sent += await raise(token, 'liquidity', `Its pool has lost ${pct}% of its QMS. Selling gets harder as the pool shrinks.`);
          s.peakQms = r.qmsReserve; // the new level is the new baseline
        } else if (r.qmsReserve > s.peakQms) s.peakQms = r.qmsReserve;
        if (s.supply > 0n && r.supply * 1000n >= s.supply * BigInt(Math.round((1 + WATCH.mintGrowth) * 1000))) {
          const pct = Number(((r.supply - s.supply) * 100n) / s.supply);
          sent += await raise(token, 'minted', `Its creator just made ${pct}% more tokens. New supply can push the price down fast.`);
          s.supply = r.supply;
        }
      }
      // A full re-check on a few tokens, taking turns, catches selling being switched off.
      const known = tokens.filter((t) => state.has(t));
      for (let i = 0; i < Math.min(WATCH.fullChecksPerTick, known.length); i++) {
        const token = known[(rotation + i) % known.length]!;
        const s = state.get(token)!;
        const c = await deps.sellBlocked(token).catch(() => null);
        if (!c) continue;
        if (c.blocked && !s.blocked) sent += await raise(token, 'blocked', c.reason ?? 'A test sale of this token now fails. You may not be able to sell it.');
        s.blocked = c.blocked;
      }
      rotation += WATCH.fullChecksPerTick;
    } finally {
      running = false;
    }
    return sent;
  }

  function start() {
    const t = setInterval(() => void tick().then((n) => n && console.log(`watch: ${n} alert(s) sent`)).catch((e) => console.error('watch', (e as Error).message)), WATCH.everyMs);
    t.unref?.();
    return () => clearInterval(t);
  }

  return { tick, start };
}
