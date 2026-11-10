import { describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { verifyInitData } from '../src/telegram.js';
import { decrypt, encrypt } from '../src/crypto.js';

const BOT = '123456:TEST-token';

function sign(fields: Record<string, string>, token = BOT): string {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe('Telegram initData verification', () => {
  const now = 1_800_000_000;
  const user = JSON.stringify({ id: 42, first_name: 'Ada' });

  it('accepts correctly signed, fresh data', () => {
    expect(verifyInitData(sign({ auth_date: String(now - 10), query_id: 'q', user }), BOT, 3600, now)?.id).toBe(42);
  });

  it('rejects a tampered user id', () => {
    const good = sign({ auth_date: String(now), user });
    const forged = good.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":43'));
    expect(verifyInitData(forged, BOT, 3600, now)).toBeNull();
  });

  it('rejects data signed with another bot token', () => {
    expect(verifyInitData(sign({ auth_date: String(now), user }, '999:other'), BOT, 3600, now)).toBeNull();
  });

  it('rejects stale data', () => {
    expect(verifyInitData(sign({ auth_date: String(now - 7200), user }), BOT, 3600, now)).toBeNull();
  });

  it('rejects missing or malformed hash', () => {
    expect(verifyInitData('auth_date=1&user=%7B%7D', BOT, 3600, now)).toBeNull();
    expect(verifyInitData('', BOT, 3600, now)).toBeNull();
  });
});

describe('session key encryption', () => {
  const k = randomBytes(32).toString('hex');

  it('round-trips', () => {
    const blob = encrypt('0xsecret', k, 'user:42');
    expect(blob).not.toContain('secret');
    expect(decrypt(blob, k, 'user:42')).toBe('0xsecret');
  });

  it('cannot be decrypted for a different user (AAD binding)', () => {
    expect(() => decrypt(encrypt('0xsecret', k, 'user:42'), k, 'user:43')).toThrow();
  });

  it('cannot be decrypted with a different key', () => {
    expect(() => decrypt(encrypt('0xsecret', k, 'user:42'), randomBytes(32).toString('hex'), 'user:42')).toThrow();
  });
});
