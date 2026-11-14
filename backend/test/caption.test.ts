import { describe, expect, it } from 'vitest';
import { cardText } from '../src/chat.js';
import type { Safety } from '../src/tokens.js';

const base: Safety = {
  token: { address: '0xbBB43127661FaD739FD793f3aAc5b35EeCbA3800', symbol: 'QTPLAIN', name: 'Plain', decimals: 18, verified: false },
  verdict: 'caution', score: 70, tradable: true, priceUsd: 0, priceQms: 0, liquidityUsd: 14, checkedAt: Date.now(),
  findings: [
    { level: 'pass', title: 'You can sell it', detail: 'A simulated buy and sale both went through.' },
    { level: 'caution', title: 'Small pool', detail: 'About $14 is available to trade, so even small trades move the price.' },
    { level: 'danger', title: 'Wallets can be blacklisted', detail: 'The creator can block specific wallets from selling.' },
  ],
};

describe('the chat caption reads as plain language', () => {
  const text = cardText(base, [], true);
  it('groups findings under headings, most serious first', () => {
    expect(text.indexOf('<b>Warning</b>')).toBeLessThan(text.indexOf('<b>Worth knowing</b>'));
    expect(text.indexOf('<b>Worth knowing</b>')).toBeLessThan(text.indexOf('<b>Looks fine</b>'));
  });
  it('explains each problem in a sentence', () => {
    expect(text).toContain('Small pool: about $14 is available to trade, so even small trades move the price.');
  });
  it('uses no codes or symbols', () => {
    expect(text).not.toMatch(/\bWatch\b|\bOK\b|\bRisk\b|[✓✕!?]\s/);
  });
  it('stays within Telegram\'s caption limit even with many findings', () => {
    const many = { ...base, findings: Array.from({ length: 12 }, (_, i) => ({ level: 'caution' as const, title: `Finding ${i}`, detail: 'x'.repeat(150) })) };
    expect(cardText(many, [], true).length).toBeLessThanOrEqual(1000);
  });
});
