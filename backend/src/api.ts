import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAddress, isHex, type Address, type Hex } from 'viem';
import { config } from './config.js';
import type { Db } from './db.js';
import { verifyInitData, type TelegramUser } from './telegram.js';
import { UserError, type Service } from './service.js';

const MAX_BODY = 16 * 1024;

function send(res: ServerResponse, status: number, body: unknown, origin?: string) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (origin && (config.allowedOrigins.includes(origin) || config.allowedOrigins.includes('*'))) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new UserError('Request too large.');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new UserError('Invalid request.');
  }
}

/** Small per-user rate limit: 40 requests per 10 seconds. */
const hits = new Map<number, number[]>();
function rateLimited(id: number): boolean {
  const now = Date.now();
  const recent = (hits.get(id) ?? []).filter((t) => now - t < 10_000);
  recent.push(now);
  hits.set(id, recent);
  return recent.length > 40;
}

function parseAmount(v: unknown): bigint {
  if (typeof v !== 'string' || !/^\d{1,40}$/.test(v)) throw new UserError('Invalid amount.');
  return BigInt(v);
}

export function startApi(db: Db, svc: Service) {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin && config.allowedOrigins.includes(origin) ? origin : '',
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type, x-telegram-init-data',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    try {
      if (url.pathname === '/api/health') return send(res, 200, { ok: true, ...svc.batchStatus() }, origin);

      // Everything else requires a verified Telegram user.
      const user: TelegramUser | null = verifyInitData(String(req.headers['x-telegram-init-data'] ?? ''), config.botToken);
      if (!user) return send(res, 401, { error: 'Please open Qalibre from Telegram.' }, origin);
      if (rateLimited(user.id)) return send(res, 429, { error: 'Too many requests. Please slow down.' }, origin);
      db.upsertUser(user.id, user.first_name ?? null);

      if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, await svc.portfolio(user.id), origin);
      if (req.method === 'GET' && url.pathname === '/api/batch') return send(res, 200, svc.batchStatus(), origin);

      if (req.method === 'POST' && url.pathname === '/api/register/prepare') {
        const body = await readJson(req);
        if (typeof body.owner !== 'string' || !isAddress(body.owner)) throw new UserError('Invalid wallet address.');
        return send(res, 200, await svc.prepareRegistration(user.id, body.owner), origin);
      }
      if (req.method === 'POST' && url.pathname === '/api/register/complete') {
        const body = await readJson(req);
        if (typeof body.signature !== 'string' || !isHex(body.signature) || body.signature.length !== 132) throw new UserError('Invalid signature.');
        return send(res, 200, await svc.completeRegistration(user.id, body.signature as Hex), origin);
      }
      if (req.method === 'GET' && url.pathname === '/api/quote') {
        const sell = url.searchParams.get('sell') ?? '';
        const buy = url.searchParams.get('buy') ?? '';
        if (!isAddress(sell) || !isAddress(buy)) throw new UserError('Invalid tokens.');
        return send(res, 200, await svc.quote(sell as Address, buy as Address, parseAmount(url.searchParams.get('amount'))), origin);
      }
      if (req.method === 'POST' && url.pathname === '/api/orders') {
        const body = await readJson(req);
        if (typeof body.sell !== 'string' || !isAddress(body.sell) || typeof body.buy !== 'string' || !isAddress(body.buy)) throw new UserError('Invalid tokens.');
        return send(res, 200, await svc.placeOrder(user.id, body.sell as Address, body.buy as Address, parseAmount(body.amount)), origin);
      }
      if (req.method === 'GET' && url.pathname === '/api/orders') {
        return send(res, 200, { orders: db.userOrders(user.id).map(({ signature: _s, nonce: _n, ...o }) => o) }, origin);
      }
      const m = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/);
      if (req.method === 'GET' && m) {
        const o = db.getOrder(m[1]!);
        if (!o || o.tg_id !== user.id) return send(res, 404, { error: 'Order not found.' }, origin);
        const { signature: _s, nonce: _n, ...rest } = o;
        return send(res, 200, rest, origin);
      }
      return send(res, 404, { error: 'Not found.' }, origin);
    } catch (e) {
      if (e instanceof UserError) return send(res, 400, { error: e.message }, origin);
      console.error('api error', e);
      return send(res, 500, { error: 'Something went wrong on our side. Your funds are safe; please try again.' }, origin);
    }
  });
  server.listen(config.port, () => console.log(`api listening on :${config.port}`));
  return server;
}
