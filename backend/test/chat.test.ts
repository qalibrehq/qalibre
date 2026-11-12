import { describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import { buySizes, fmtSig, fmtToken, LADDER, parseTyped } from '../src/chat.js';

const q = (v: string) => parseUnits(v, 18);

describe('number formatting', () => {
  it('never prints exponent form for tiny prices', () => {
    expect(fmtSig(0.000000163456)).toBe('0.0000001635');
    expect(fmtSig(1.6e-7, 3)).toBe('0.00000016');
    expect(fmtSig(0)).toBe('0');
  });
  it('groups large numbers and trims small ones', () => {
    expect(fmtSig(12345.678)).toBe('12,346');
    expect(fmtSig(3.14159)).toBe('3.14');
    expect(fmtToken(5_000_000n * 10n ** 18n, 18)).toBe('5,000,000');
    expect(fmtToken(15n * 10n ** 4n, 6)).toBe('0.15');
  });
});

describe('typed amounts', () => {
  it('accepts plain human input', () => {
    expect(parseTyped('0.5', 18)).toBe(q('0.5'));
    expect(parseTyped('.25', 18)).toBe(q('0.25'));
    expect(parseTyped('1,000', 6)).toBe(1_000_000_000n);
  });
  it('rejects anything that is not a clean positive number', () => {
    for (const bad of ['0', '-1', '1e18', 'abc', '1.2.3', '', ' ', '0x10', '1/2']) expect(parseTyped(bad, 18)).toBeNull();
  });
  it('rejects more decimals than the token has instead of rounding silently', () => {
    expect(parseTyped('0.0000001', 6)).toBeNull();
  });
});

describe('buy sizes on a card', () => {
  it('fit the wallet, the per-trade limit and the pool', () => {
    // 0.12 QMS spendable, 10 QMS limit, deep pool: largest three that fit the wallet.
    expect(buySizes(q('0.12'), q('10'), q('1000')).map((i) => LADDER[i])).toEqual(['0.01', '0.05', '0.1']);
    // Per-trade limit of 1 QMS caps the sizes even with a large balance.
    expect(buySizes(q('100'), q('1'), q('1000')).map((i) => LADDER[i])).toEqual(['0.25', '0.5', '1']);
  });
  it('never offers a size the pool would refuse (impact above 30%)', () => {
    // A 0.8 QMS pool: 0.5 QMS would move the price ~38%, so it is not offered.
    const sizes = buySizes(q('100'), q('10'), q('0.8')).map((i) => LADDER[i]);
    expect(sizes).not.toContain('0.5');
    expect(sizes.at(-1)).toBe('0.25');
  });
  it('offers nothing when the wallet cannot afford the smallest size', () => {
    expect(buySizes(q('0.001'), q('10'), q('1000'))).toEqual([]);
  });
});
