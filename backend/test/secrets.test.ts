import { describe, expect, it } from 'vitest';
import { english, generateMnemonic, generatePrivateKey } from 'viem/accounts';
import { detectSecret } from '../src/secrets.js';

describe('secrets pasted by mistake are caught', () => {
  it('private keys, with or without 0x, alone or inside a sentence', () => {
    const k = generatePrivateKey();
    expect(detectSecret(k)?.kind).toBe('private_key');
    expect(detectSecret(k.slice(2))?.kind).toBe('private_key');
    expect(detectSecret(`support said to send my key ${k} to verify`)?.kind).toBe('private_key');
  });

  it('recovery phrases of 12 and 24 words, in any case and spacing', () => {
    for (const strength of [128, 256]) {
      const phrase = generateMnemonic(english, strength);
      expect(detectSecret(phrase)?.kind).toBe('recovery_phrase');
      expect(detectSecret(phrase.toUpperCase().replace(/ /g, '\n'))?.kind).toBe('recovery_phrase');
      expect(detectSecret(`my words: ${phrase.split(' ').map((w, i) => `${i + 1}. ${w}`).join(' ')}`)?.kind).toBe('recovery_phrase');
    }
  });

  it('agent keys, and returns them so they can be revoked', () => {
    const key = 'qak_' + 'aB3_-'.repeat(8) + 'xyz';
    const r = detectSecret(`here is my key ${key} thanks`);
    expect(r?.kind).toBe('agent_key');
    expect(r?.agentKeys).toEqual([key]);
  });
});

describe('ordinary messages are left alone', () => {
  const ordinary = [
    '0xb3b3426CDc928377e8221f9DB75CF3Fdd26a3763', // a token address (40 hex)
    'buy 0xb3b3426CDc928377e8221f9DB75CF3Fdd26a3763 0.5',
    '/start',
    'hello, can you check this token for me please',
    'I want to buy some more of the dog token if the price is still fair today',
    'Please check the account balance and tell me about any risk before I buy again',
    'gm',
    'what is the fee on a trade of about ten qms',
  ];
  for (const text of ordinary) {
    it(JSON.stringify(text.slice(0, 40)), () => expect(detectSecret(text)).toBeNull());
  }

  it('a long ordinary paragraph does not look like a phrase', () => {
    const text = 'Qalibre checks every token before you buy it. The safety check simulates a buy and a sale, and it scans the code for creator powers. If something looks wrong, you see it before you spend anything at all.';
    expect(detectSecret(text)).toBeNull();
  });
});
