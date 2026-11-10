/**
 * Telegram: Mini App login verification and Bot API calls.
 *
 * Every API request carries Telegram's signed `initData`. We verify it server-side exactly as the
 * Telegram docs specify (HMAC-SHA256, key = HMAC_SHA256("WebAppData", bot_token)) and reject stale
 * data, so nobody can impersonate a Telegram user against our API.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export function verifyInitData(initData: string, botToken: string, maxAgeSec = 24 * 3600, nowSec = Math.floor(Date.now() / 1000)): TelegramUser | null {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAgeSec || authDate - nowSec > 60) return null;

  try {
    const user = JSON.parse(params.get('user') ?? '') as TelegramUser;
    return typeof user?.id === 'number' ? user : null;
  } catch {
    return null;
  }
}

export class Bot {
  constructor(private readonly token: string) {}

  async call<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }
}

/** Escape user-visible text for Telegram's HTML parse mode. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
