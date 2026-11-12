import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { ROOT } from './config.js';
import { isAddress, isHex, type Address, type Hex } from 'viem';
import { config } from './config.js';
import type { Db } from './db.js';
import { verifyInitData, type TelegramUser } from './telegram.js';
import { HighImpact, NeedsApproval, UserError, type Service } from './service.js';
import type { OwnerOps } from './ownerops.js';
import { checkToken } from './tokens.js';

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

const DIST = join(ROOT, 'miniapp', 'dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  // Only Telegram may frame the app (Telegram Web runs Mini Apps in an iframe).
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'", // Inter is bundled with the app
    "img-src 'self' data: https://t.me https://*.t.me https://*.telesco.pe", // Telegram profile photos
    "connect-src 'self'",
    "frame-ancestors https://web.telegram.org https://*.telegram.org",
  ].join('; '),
};

/** Serve the built Mini App (same origin as the API, so no CORS is needed). */
async function serveStatic(pathname: string, res: ServerResponse) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(DIST, rel);
  if (!file.startsWith(DIST + sep) && file !== DIST) return false; // path traversal guard
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    file = join(DIST, 'index.html'); // SPA fallback
    try {
      body = await readFile(file);
    } catch {
      return false;
    }
  }
  const ext = extname(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
  return true;
}

/** Extra per-user data the app shows that lives in the chat side (invite link and its numbers). */
export interface ApiExtras {
  invite?: (tgId: number) => { link: string; invited: number; trading: number; earnedQms: string; paidQms: string; sharePct: number; days: number };
  botUsername?: string;
}

export function startApi(db: Db, svc: Service, owner: OwnerOps, extras: ApiExtras = {}) {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (await serveStatic(url.pathname === '/' ? '/index.html' : url.pathname, res)) return;
      res.writeHead(404);
      return res.end();
    }
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
      // Public: the savings counter, shown on the website and in /stats.
      if (req.method === 'GET' && url.pathname === '/api/stats') return send(res, 200, await svc.publicStats(), origin);

      // Everything else requires a verified Telegram user.
      const user: TelegramUser | null = verifyInitData(String(req.headers['x-telegram-init-data'] ?? ''), config.botToken);
      if (!user) return send(res, 401, { error: 'Please open Qalibre from Telegram.' }, origin);
      if (rateLimited(user.id)) return send(res, 429, { error: 'Too many requests. Please slow down.' }, origin);
      db.upsertUser(user.id, user.first_name ?? null);

      if (req.method === 'GET' && url.pathname === '/api/me') {
        const p = await svc.portfolio(user.id);
        return send(res, 200, p.registered ? { ...p, invite: extras.invite?.(user.id), bot: extras.botUsername } : { ...p, bot: extras.botUsername }, origin);
      }
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
      if (req.method === 'POST' && url.pathname === '/api/owner/prepare') {
        const body = await readJson(req);
        if (typeof body.callData !== 'string' || !isHex(body.callData) || body.callData.length > 20_000) throw new UserError('Invalid request.');
        return send(res, 200, await owner.prepare(user.id, body.callData as Hex), origin);
      }
      if (req.method === 'POST' && url.pathname === '/api/owner/send') {
        const body = await readJson(req);
        if (!body.op || typeof body.op !== 'object') throw new UserError('Invalid request.');
        return send(res, 200, await owner.send(user.id, body.op as Record<string, string>), origin);
      }
      if (req.method === 'POST' && url.pathname === '/api/owner/session-key') {
        return send(res, 200, owner.newSessionKey(user.id), origin);
      }
      if (req.method === 'POST' && url.pathname === '/api/test-funds') {
        return send(res, 200, await svc.requestTestFunds(user.id), origin);
      }
      if (req.method === 'GET' && url.pathname === '/api/token') {
        const address = url.searchParams.get('address') ?? '';
        if (!isAddress(address)) throw new UserError('Invalid token address.');
        const s = await checkToken(address as Address).catch(() => {
          throw new UserError('That address doesn\'t look like a token on QMS. Check it and paste it again.');
        });
        return send(res, 200, s, origin);
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
        const mode = body.mode === 'instant' ? 'instant' : 'best';
        return send(res, 200, await svc.placeOrder(user.id, body.sell as Address, body.buy as Address, parseAmount(body.amount), mode, { acceptImpact: body.acceptImpact === true }), origin);
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
      // Refusals the app can act on carry a code: approve the token, or confirm a large price impact.
      if (e instanceof NeedsApproval) return send(res, 400, { error: e.message, code: 'needs_approval', token: e.token }, origin);
      if (e instanceof HighImpact) return send(res, 400, { error: e.message, code: 'high_impact', impactBps: e.impactBps }, origin);
      if (e instanceof UserError) return send(res, 400, { error: e.message }, origin);
      console.error('api error', e);
      return send(res, 500, { error: 'Something went wrong on our side. Your funds are safe; please try again.' }, origin);
    }
  });
  server.listen(config.port, () => console.log(`api listening on :${config.port}`));
  return server;
}
