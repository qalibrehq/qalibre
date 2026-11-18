import { describe, expect, it } from 'vitest';
import { createWatcher, type AlertKind, type Reading } from '../src/watch.js';

function setup() {
  const readings = new Map<string, Reading>([['0xaa', { qmsReserve: 1000n, supply: 1_000_000n }]]);
  const blocked = new Set<string>();
  const sent: { tgId: number; kind: AlertKind }[] = [];
  let clock = 0;
  let holderLookups = 0;
  const w = createWatcher({
    tokens: () => [...readings.keys()],
    read: async (t) => readings.get(t)!,
    sellBlocked: async (t) => ({ blocked: blocked.has(t) }),
    holders: async () => (holderLookups++, [{ tgId: 1, balance: 5n }, { tgId: 2, balance: 0n }]),
    alert: async (tgId, _t, kind) => void sent.push({ tgId, kind }),
    now: () => clock,
  });
  return { w, readings, blocked, sent, advance: (ms: number) => (clock += ms), lookups: () => holderLookups };
}

describe('watcher', () => {
  it('stays quiet when nothing changes, and looks up no balances', async () => {
    const s = setup();
    await s.w.tick();
    await s.w.tick();
    expect(s.sent).toEqual([]);
    expect(s.lookups()).toBe(0);
  });
  it('alerts current holders only when the pool loses half its QMS from its peak', async () => {
    const s = setup();
    await s.w.tick();
    s.readings.set('0xaa', { qmsReserve: 2000n, supply: 1_000_000n }); // pool grows: new peak
    await s.w.tick();
    s.readings.set('0xaa', { qmsReserve: 1100n, supply: 1_000_000n }); // 45% down: not yet
    await s.w.tick();
    expect(s.sent).toEqual([]);
    s.readings.set('0xaa', { qmsReserve: 900n, supply: 1_000_000n }); // 55% down
    await s.w.tick();
    expect(s.sent).toEqual([{ tgId: 1, kind: 'liquidity' }]); // the holder with a zero balance is skipped
  });
  it('alerts on new supply and when selling becomes blocked', async () => {
    const s = setup();
    await s.w.tick();
    s.readings.set('0xaa', { qmsReserve: 1000n, supply: 1_200_000n });
    s.blocked.add('0xaa');
    await s.w.tick();
    expect(s.sent.map((x) => x.kind).sort()).toEqual(['blocked', 'minted']);
  });
  it('sends one alert per token and kind per day', async () => {
    const s = setup();
    await s.w.tick();
    s.readings.set('0xaa', { qmsReserve: 400n, supply: 1_000_000n });
    await s.w.tick();
    s.readings.set('0xaa', { qmsReserve: 100n, supply: 1_000_000n }); // falls again within the day
    await s.w.tick();
    expect(s.sent).toHaveLength(1);
    s.advance(25 * 3_600_000);
    s.readings.set('0xaa', { qmsReserve: 20n, supply: 1_000_000n });
    await s.w.tick();
    expect(s.sent).toHaveLength(2);
  });
  it('does not alert again while selling stays blocked', async () => {
    const s = setup();
    s.blocked.add('0xaa');
    await s.w.tick(); // first sight: baseline only, then the full check finds it blocked
    s.advance(25 * 3_600_000);
    await s.w.tick();
    expect(s.sent.filter((x) => x.kind === 'blocked')).toHaveLength(1);
  });
});
