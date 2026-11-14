import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTickers } from '../src/chat.js';

afterEach(() => vi.useRealTimers());

describe('the live trade timer', () => {
  it('counts up while pending, then hands over to the result without ever overwriting it', async () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    let release: () => void = () => undefined;
    let pending = true;
    // Edits are slow (Telegram round trip): the third one is still in flight when the fill arrives.
    const edit = vi.fn((_t: number, _m: number, html: string) => new Promise<void>((r) => { release = () => { shown.push(html); r(); }; if (!html.includes('6s')) { shown.push(html); r(); } }));
    const t = createTickers(edit, () => pending);
    t.start(1, 'o1', 10, (s) => `confirming ${s}s`);
    await vi.advanceTimersByTimeAsync(6_000); // ticks at 2s, 4s, 6s; the 6s edit hangs
    expect(edit).toHaveBeenCalledTimes(3);

    // The fill arrives while the 6s edit is still in flight.
    pending = false;
    const stopping = t.stop('o1').then(() => shown.push('DONE'));
    // Let everything that can run, run, before the slow edit lands: an unguarded stop would write DONE now and be
    // overwritten by the stale timer edit a moment later.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    release(); // the slow edit lands
    await stopping;
    await vi.advanceTimersByTimeAsync(10_000); // no more ticks after the result
    expect(shown.at(-1)).toBe('DONE');
    expect(edit).toHaveBeenCalledTimes(3);
    expect(t.size()).toBe(0);
  });

  it('stops by itself when the order is no longer pending, or after three minutes', async () => {
    vi.useFakeTimers();
    let pending = true;
    const edit = vi.fn(async () => undefined);
    const t = createTickers(edit, () => pending);
    t.start(1, 'a', 1, (s) => `${s}s`);
    await vi.advanceTimersByTimeAsync(4_000);
    pending = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.size()).toBe(0);
    const calls = edit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(edit.mock.calls.length).toBe(calls);

    pending = true;
    t.start(1, 'b', 2, (s) => `${s}s`);
    await vi.advanceTimersByTimeAsync(190_000);
    expect(t.size()).toBe(0);
  });
});
