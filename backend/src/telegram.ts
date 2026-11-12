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

export class TelegramError extends Error {
  constructor(readonly method: string, readonly description: string) {
    super(`telegram ${method}: ${description}`);
  }
}

export class Bot {
  constructor(private readonly token: string) {}

  async call<T = unknown>(method: string, body: Record<string, unknown> = {}, retries = 2): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 40_000 : 15_000),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string; parameters?: { retry_after?: number } };
    // Flood control: Telegram says how long to wait. Wait (bounded) and retry, so a final status edit is never lost.
    if (!json.ok && res.status === 429 && retries > 0) {
      const wait = Math.min(30, json.parameters?.retry_after ?? 2);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.call<T>(method, body, retries - 1);
    }
    if (!json.ok) throw new TelegramError(method, json.description ?? String(res.status));
    return json.result;
  }

  /** Send a PNG we rendered (multipart upload), with an HTML caption and optional buttons. */
  async sendPhoto(chatId: number, png: Buffer, caption: string, extra: Record<string, unknown> = {}, retries = 2): Promise<{ message_id: number }> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', caption);
    form.set('parse_mode', 'HTML');
    for (const [k, v] of Object.entries(extra)) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    form.set('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'qalibre.png');
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
    const json = (await res.json()) as { ok: boolean; result: { message_id: number }; description?: string; parameters?: { retry_after?: number } };
    if (!json.ok && res.status === 429 && retries > 0) {
      await new Promise((r) => setTimeout(r, Math.min(30, json.parameters?.retry_after ?? 2) * 1000));
      return this.sendPhoto(chatId, png, caption, extra, retries - 1);
    }
    if (!json.ok) throw new TelegramError('sendPhoto', json.description ?? String(res.status));
    return json.result;
  }

  /** Replace the image, caption and buttons of a photo message we sent (editMessageMedia, multipart). */
  async editPhoto(chatId: number, messageId: number, png: Buffer, caption: string, replyMarkup?: unknown): Promise<void> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('message_id', String(messageId));
    form.set('media', JSON.stringify({ type: 'photo', media: 'attach://card', caption, parse_mode: 'HTML' }));
    if (replyMarkup) form.set('reply_markup', JSON.stringify(replyMarkup));
    form.set('card', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'qalibre.png');
    const res = await fetch(`https://api.telegram.org/bot${this.token}/editMessageMedia`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok && !(json.description ?? '').includes('message is not modified')) throw new TelegramError('editMessageMedia', json.description ?? String(res.status));
  }

  editMessage(chatId: number, messageId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch((e) => {
      // Editing to identical content is not an error for us.
      if (e instanceof TelegramError && e.description.includes('message is not modified')) return null;
      throw e;
    });
  }

  answer(callbackId: string, text?: string, alert = false) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text, show_alert: alert } : {}) }).catch(() => null);
  }

  sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }
}

/** Escape user-visible text for Telegram's HTML parse mode. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
