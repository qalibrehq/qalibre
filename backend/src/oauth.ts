/**
 * OAuth 2.1 for the agent connector, so an AI app (claude.ai, Claude Desktop, any MCP client) connects without
 * anyone copying a key. Approval happens in Telegram, where the user already is.
 *
 *   1. The client discovers us (RFC 9728 protected-resource metadata, RFC 8414 server metadata) and registers
 *      itself (RFC 7591 dynamic registration).
 *   2. It opens /oauth/authorize. Our page shows a pairing code and an "Approve in Telegram" button that opens the
 *      bot with a one-time start parameter.
 *   3. The bot shows who is asking, what it can do, and the same pairing code. Allow trading, Read only, or Deny.
 *   4. The page sees the decision and returns to the client's registered redirect URI with a single-use code.
 *   5. The client exchanges the code plus its PKCE verifier for a 1-hour access token and a rotating refresh token.
 *
 * Security: PKCE S256 is required; redirect URIs must match a registered one exactly (https, or http on localhost);
 * codes are single-use, bound to client, redirect URI and challenge, and live 2 minutes; every token is stored only
 * as a SHA-256 hash; each grant is an ordinary agent key, so /agent lists it and revoking it kills every token.
 * The pairing code defends against consent phishing (someone sending you a link to approve *their* session).
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentKeyRow, Db } from './db.js';
import { hashKey, issueAgentKey } from './agent.js';
import { cleanText } from './tokens.js';

const ACCESS_TTL = 3_600; // seconds
const REFRESH_TTL = 90 * 86_400;
const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const MAX_BODY = 16 * 1024;

const b64url = (n: number) => randomBytes(n).toString('base64url');
const sha256b64url = (s: string) => createHash('sha256').update(s).digest('base64url');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Client { client_id: string; client_name: string; redirect_uris: string[] }
interface AuthRequest {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  challenge: string;
  pairing: string;
  createdAt: number;
  decision?: { allow: false } | { allow: true; keyId: string };
}
interface Code { clientId: string; redirectUri: string; challenge: string; keyId: string; at: number }

/** https anywhere, or plain http only on the loopback address (desktop apps receive the redirect locally). */
function validRedirect(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...extra });
  res.end(JSON.stringify(body));
};
const oauthError = (res: ServerResponse, status: number, error: string, description: string) => json(res, status, { error, error_description: description });

export function createOAuth(db: Db, opts: { issuer: string; botUsername: string }) {
  const issuer = opts.issuer.replace(/\/$/, '');
  const requests = new Map<string, AuthRequest>();
  const codes = new Map<string, Code>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, r] of requests) if (now - r.createdAt > REQUEST_TTL_MS) requests.delete(k);
    for (const [k, c] of codes) if (now - c.at > CODE_TTL_MS) codes.delete(k);
  };

  db.raw.exec(`CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.raw.exec(`CREATE TABLE IF NOT EXISTS oauth_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, key_id TEXT NOT NULL, client_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)`);
  const getClient = (id: string) => {
    const r = db.raw.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(id) as { client_id: string; client_name: string; redirect_uris: string } | undefined;
    return r ? ({ client_id: r.client_id, client_name: r.client_name, redirect_uris: JSON.parse(r.redirect_uris) as string[] } satisfies Client) : undefined;
  };
  const now = () => Math.floor(Date.now() / 1000);

  function issueTokens(keyId: string, clientId: string) {
    const access = 'qat_' + b64url(32);
    const refresh = 'qrt_' + b64url(32);
    const ins = db.raw.prepare('INSERT INTO oauth_tokens (token_hash, kind, key_id, client_id, expires_at) VALUES (?, ?, ?, ?, ?)');
    ins.run(hashKey(access), 'access', keyId, clientId, now() + ACCESS_TTL);
    ins.run(hashKey(refresh), 'refresh', keyId, clientId, now() + REFRESH_TTL);
    const key = db.agentKey(keyId)!;
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: key.can_trade ? 'read trade' : 'read' };
  }

  /** Resolves an OAuth access token to its agent key (null when unknown, expired or the grant was revoked). */
  function resolveAccessToken(token: string): AgentKeyRow | null {
    if (!/^qat_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const t = db.raw.prepare("SELECT key_id, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(hashKey(token)) as { key_id: string; expires_at: number } | undefined;
    if (!t || t.expires_at <= now()) return null;
    const key = db.agentKey(t.key_id);
    return key && !key.revoked_at && key.expires_at > now() ? key : null;
  }

  const metadata = {
    resource: () => ({ resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['read', 'trade'], resource_name: 'Qalibre' }),
    server: () => ({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'trade'],
    }),
  };

  /** The authorize page: pairing code, a button into Telegram, and a quiet poll for the decision. */
  function authorizePage(r: AuthRequest, nonce: string): string {
    const link = `https://t.me/${opts.botUsername}?start=oa_${r.id}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${esc(r.clientName)} to Qalibre</title>
<style>
:root{--g:#0F4D3A;--p:#F6F4EF;--i:#111214;--m:#5b5e66;--b:#B08D57}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--p);color:var(--i);font:16px/1.55 Inter,system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}
.card{width:min(420px,100%);background:#fff;border-radius:24px;padding:32px 28px;box-shadow:0 30px 60px -36px rgba(17,18,20,.35)}
.mark{width:44px;height:44px;border-radius:12px;background:var(--g);display:grid;place-items:center;margin-bottom:22px}
h1{font-size:24px;letter-spacing:-.02em;margin:0 0 8px;line-height:1.2}p{margin:0;color:var(--m)}
.code{margin:22px 0;padding:16px;border-radius:14px;background:var(--p);text-align:center}
.code span{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--m)}
.code b{font-size:30px;letter-spacing:.18em;font-variant-numeric:tabular-nums}
a.btn{display:flex;align-items:center;justify-content:center;height:52px;border-radius:14px;background:var(--g);color:#F6F4EF;text-decoration:none;font-weight:600}
ul{margin:18px 0 0;padding:0;list-style:none;color:var(--m);font-size:14px}li{padding-left:18px;position:relative;margin:6px 0}
li:before{content:"";position:absolute;left:2px;top:.6em;width:7px;height:7px;border-radius:4px;background:var(--g)}
li.no:before{background:#a33a2b}.status{margin-top:18px;font-size:14px;text-align:center;color:var(--m)}
</style></head><body><main class="card">
<div class="mark"><svg viewBox="0 0 64 64" width="26" height="26"><g fill="none" stroke="#F6F4EF" stroke-width="8"><circle cx="20" cy="22" r="16"/><path d="M36 6V54"/></g><circle cx="36" cy="58" r="5.6" fill="#B08D57"/></svg></div>
<h1>Connect ${esc(r.clientName)} to Qalibre</h1>
<p>Approve in Telegram. Check that the code there matches this one.</p>
<div class="code"><span>Pairing code</span><b>${r.pairing}</b></div>
<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Approve in Telegram</a>
<ul><li>It can check tokens and trade within your limits</li><li class="no">It can never withdraw or send money out</li><li>Revoke it any time with /agent</li></ul>
<p class="status" id="s">Waiting for your approval…</p>
</main><script nonce="${nonce}">
(function(){var id=${JSON.stringify(r.id)};var s=document.getElementById('s');var tries=0;
function poll(){tries++;fetch('/oauth/status?request='+encodeURIComponent(id),{cache:'no-store'}).then(function(x){return x.json()}).then(function(j){
if(j.redirect){s.textContent=j.allowed?'Approved. Returning you now…':'Declined. Returning you now…';location.replace(j.redirect);return}
if(j.expired){s.textContent='This request expired. Start again from your AI app.';return}
setTimeout(poll,tries<60?1500:4000)}).catch(function(){setTimeout(poll,4000)})}poll()})();
</script></body></html>`;
  }

  /** HTTP routes. Returns true when it handled the request. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (req.method === 'OPTIONS' && (p.startsWith('/.well-known/oauth') || p.startsWith('/oauth/'))) {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version', 'access-control-max-age': '600' });
      res.end();
      return true;
    }
    if (req.method === 'GET' && p.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, metadata.resource()), true;
    if (req.method === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration')) return json(res, 200, metadata.server()), true;

    if (req.method === 'POST' && p === '/oauth/register') {
      let body: { client_name?: unknown; redirect_uris?: unknown };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return oauthError(res, 400, 'invalid_client_metadata', 'Body must be JSON.'), true;
      }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
      if (!uris.length || uris.length > 5 || !uris.every(validRedirect)) return oauthError(res, 400, 'invalid_redirect_uri', 'Redirect URIs must be https, or http on localhost.'), true;
      const client: Client = { client_id: randomUUID(), client_name: cleanText(typeof body.client_name === 'string' ? body.client_name : 'AI agent', 32) || 'AI agent', redirect_uris: uris };
      db.raw.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(client.client_id, client.client_name, JSON.stringify(uris), now());
      return json(res, 201, { ...client, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: now() }), true;
    }

    if (req.method === 'GET' && p === '/oauth/authorize') {
      sweep();
      const q = url.searchParams;
      const client = getClient(q.get('client_id') ?? '');
      const redirectUri = q.get('redirect_uri') ?? '';
      // Never redirect to an unverified URI: errors before this point are shown here, not sent anywhere.
      if (!client || !client.redirect_uris.includes(redirectUri)) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('This connection request is not valid. Start again from your AI app.');
        return true;
      }
      const back = (params: Record<string, string>) => {
        const u = new URL(redirectUri);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        if (q.get('state')) u.searchParams.set('state', q.get('state')!);
        res.writeHead(302, { location: u.toString() });
        res.end();
        return true;
      };
      if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
      const challenge = q.get('code_challenge') ?? '';
      if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required.' });
      const r: AuthRequest = { id: b64url(16), clientId: client.client_id, clientName: client.client_name, redirectUri, state: q.get('state'), challenge, pairing: String(randomInt(1000, 10000)), createdAt: Date.now() };
      requests.set(r.id, r);
      const nonce = b64url(16);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      });
      res.end(authorizePage(r, nonce));
      return true;
    }

    if (req.method === 'GET' && p === '/oauth/status') {
      sweep();
      const r = requests.get(url.searchParams.get('request') ?? '');
      if (!r) return json(res, 200, { expired: true }), true;
      if (!r.decision) return json(res, 200, { pending: true }), true;
      requests.delete(r.id); // the redirect is handed out once
      const u = new URL(r.redirectUri);
      if (r.decision.allow) {
        const code = b64url(32);
        codes.set(code, { clientId: r.clientId, redirectUri: r.redirectUri, challenge: r.challenge, keyId: r.decision.keyId, at: Date.now() });
        u.searchParams.set('code', code);
      } else {
        u.searchParams.set('error', 'access_denied');
      }
      if (r.state) u.searchParams.set('state', r.state);
      return json(res, 200, { redirect: u.toString(), allowed: r.decision.allow }), true;
    }

    if (req.method === 'POST' && p === '/oauth/token') {
      sweep();
      let f: URLSearchParams;
      try {
        const raw = await readBody(req);
        f = (req.headers['content-type'] ?? '').includes('application/json') ? new URLSearchParams(JSON.parse(raw) as Record<string, string>) : new URLSearchParams(raw);
      } catch {
        return oauthError(res, 400, 'invalid_request', 'Unreadable body.'), true;
      }
      const grant = f.get('grant_type');
      if (grant === 'authorization_code') {
        const code = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? ''); // single use, even when the exchange fails
        if (!code) return oauthError(res, 400, 'invalid_grant', 'Code is invalid, used or expired.'), true;
        if (code.clientId !== f.get('client_id') || code.redirectUri !== f.get('redirect_uri')) return oauthError(res, 400, 'invalid_grant', 'Code was issued to another client.'), true;
        if (sha256b64url(f.get('code_verifier') ?? '') !== code.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.'), true;
        return json(res, 200, issueTokens(code.keyId, code.clientId)), true;
      }
      if (grant === 'refresh_token') {
        const token = f.get('refresh_token') ?? '';
        const row = /^qrt_[A-Za-z0-9_-]{43}$/.test(token)
          ? (db.raw.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hashKey(token)) as { token_hash: string; key_id: string; client_id: string; expires_at: number; used_at: number | null } | undefined)
          : undefined;
        if (!row || row.expires_at <= now() || (f.get('client_id') && f.get('client_id') !== row.client_id)) return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired.'), true;
        const key = db.agentKey(row.key_id);
        if (!key || key.revoked_at || key.expires_at <= now()) return oauthError(res, 400, 'invalid_grant', 'This connection was revoked.'), true;
        if (row.used_at) {
          // A refresh token used twice means it leaked: end the whole grant.
          db.revokeExposedAgentKey(key.key_hash);
          return oauthError(res, 400, 'invalid_grant', 'Refresh token reuse detected; the connection was revoked.'), true;
        }
        db.raw.prepare('UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
        return json(res, 200, issueTokens(row.key_id, row.client_id)), true;
      }
      return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.'), true;
    }
    return false;
  }

  /** For the bot: the request behind a /start oa_<id> link, if it is still open. */
  function pending(id: string) {
    sweep();
    const r = requests.get(id);
    return r && !r.decision ? { clientName: r.clientName, pairing: r.pairing } : null;
  }

  /** For the bot: the user's decision. Allowing creates an ordinary agent key named after the client. */
  function decide(id: string, tgId: number, allow: boolean, canTrade: boolean, uniqueLabel: (name: string) => string): string | null {
    sweep();
    const r = requests.get(id);
    if (!r || r.decision) return null;
    if (!allow) {
      r.decision = { allow: false };
      return r.clientName;
    }
    const { id: keyId } = issueAgentKey(db, tgId, { label: uniqueLabel(r.clientName), canTrade });
    r.decision = { allow: true, keyId };
    return r.clientName;
  }

  return { handle, resolveAccessToken, pending, decide, resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource` };
}

export type OAuth = ReturnType<typeof createOAuth>;
