import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { createOAuth } from '../src/oauth.js';

const db = openDb(':memory:');
let base = '';
let server: Server;
let oauth: ReturnType<typeof createOAuth>;
beforeAll(async () => {
  server = createServer((req, res) => {
    void oauth.handle(req, res, new URL(req.url ?? '/', 'http://x')).then((done) => {
      if (!done) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  oauth = createOAuth(db, { issuer: base, botUsername: 'QalibreBot' });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
async function register(name = 'Claude', uris = [REDIRECT]) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: uris }) });
  return { status: r.status, body: (await r.json()) as { client_id: string; error?: string } };
}
/** Opens the authorize page and returns the request id the page polls with. */
async function authorize(clientId: string, challenge: string, redirect = REDIRECT) {
  const u = new URL(`${base}/oauth/authorize`);
  Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { redirect: 'manual' });
  const html = await r.text();
  return { status: r.status, location: r.headers.get('location'), id: /var id="([A-Za-z0-9_-]{22})"/.exec(html)?.[1], html, csp: r.headers.get('content-security-policy') };
}
const status = async (id: string) => (await (await fetch(`${base}/oauth/status?request=${id}`)).json()) as { redirect?: string; pending?: boolean; expired?: boolean };
const token = async (form: Record<string, string>) => {
  const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  return { status: r.status, body: (await r.json()) as { access_token?: string; refresh_token?: string; error?: string } };
};
db.upsertUser(7, 'Kingsley');

/** Full happy path up to a code. */
async function approvedCode(trade = true) {
  const { body: c } = await register();
  const p = pkce();
  const a = await authorize(c.client_id, p.challenge);
  expect(oauth.pending(a.id!)?.clientName).toBe('Claude');
  oauth.decide(a.id!, 7, true, trade, (n) => n);
  const s = await status(a.id!);
  const code = new URL(s.redirect!).searchParams.get('code')!;
  return { clientId: c.client_id, verifier: p.verifier, code, redirect: s.redirect! };
}

describe('discovery', () => {
  it('publishes resource and server metadata', async () => {
    const res = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as { authorization_servers: string[] };
    expect(res.authorization_servers).toEqual([base]);
    const srv = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as { code_challenge_methods_supported: string[]; token_endpoint: string };
    expect(srv.code_challenge_methods_supported).toEqual(['S256']);
    expect(srv.token_endpoint).toBe(`${base}/oauth/token`);
  });
});

describe('registration and authorize refuse unsafe requests', () => {
  it('rejects non-https redirect URIs (except localhost)', async () => {
    expect((await register('x', ['http://evil.example/cb'])).status).toBe(400);
    expect((await register('x', ['javascript:alert(1)'])).status).toBe(400);
    expect((await register('desktop', ['http://127.0.0.1:33418/cb'])).status).toBe(201);
  });

  it('never redirects to an unregistered URI', async () => {
    const { body: c } = await register();
    const a = await authorize(c.client_id, pkce().challenge, 'https://evil.example/steal');
    expect(a.status).toBe(400);
    expect(a.location).toBeNull();
  });

  it('requires PKCE S256', async () => {
    const { body: c } = await register();
    const u = new URL(`${base}/oauth/authorize`);
    Object.entries({ response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: 'short', code_challenge_method: 'plain' }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('error=invalid_request');
  });

  it('serves the page with a strict CSP and a pairing code', async () => {
    const { body: c } = await register();
    const a = await authorize(c.client_id, pkce().challenge);
    expect(a.csp).toContain("frame-ancestors 'none'");
    expect(a.csp).toMatch(/script-src 'nonce-/);
    expect(a.html).toMatch(/Pairing code<\/span><b>\d{4}<\/b>/);
    expect(a.html).toContain('t.me/QalibreBot?start=oa_');
  });

  it('escapes a hostile client name', async () => {
    const { body: c } = await register('<script>alert(1)</script>');
    const a = await authorize(c.client_id, pkce().challenge);
    expect(a.html).not.toContain('<script>alert');
  });
});

describe('the code exchange', () => {
  it('waits for the decision, then returns a code with the state', async () => {
    const { body: c } = await register();
    const a = await authorize(c.client_id, pkce().challenge);
    expect((await status(a.id!)).pending).toBe(true);
    oauth.decide(a.id!, 7, true, true, (n) => n);
    const s = await status(a.id!);
    expect(new URL(s.redirect!).searchParams.get('state')).toBe('st8');
    expect((await status(a.id!)).expired).toBe(true); // the redirect is handed out once
  });

  it('a denial returns access_denied and creates nothing', async () => {
    const before = db.activeAgentKeys(7).length;
    const { body: c } = await register();
    const a = await authorize(c.client_id, pkce().challenge);
    oauth.decide(a.id!, 7, false, false, (n) => n);
    expect((await status(a.id!)).redirect).toContain('error=access_denied');
    expect(db.activeAgentKeys(7).length).toBe(before);
  });

  it('issues tokens only with the right verifier, client and redirect, and only once', async () => {
    const g = await approvedCode();
    expect((await token({ grant_type: 'authorization_code', code: g.code, client_id: g.clientId, redirect_uri: REDIRECT, code_verifier: 'wrong'.padEnd(43, 'x') })).body.error).toBe('invalid_grant');
    // The failed attempt burned the code: a correct retry with the same code must fail too.
    expect((await token({ grant_type: 'authorization_code', code: g.code, client_id: g.clientId, redirect_uri: REDIRECT, code_verifier: g.verifier })).body.error).toBe('invalid_grant');

    const h = await approvedCode();
    expect((await token({ grant_type: 'authorization_code', code: h.code, client_id: 'someone-else', redirect_uri: REDIRECT, code_verifier: h.verifier })).body.error).toBe('invalid_grant');

    const k = await approvedCode();
    const ok = await token({ grant_type: 'authorization_code', code: k.code, client_id: k.clientId, redirect_uri: REDIRECT, code_verifier: k.verifier });
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toMatch(/^qat_/);
    expect(oauth.resolveAccessToken(ok.body.access_token!)?.label).toBe('Claude');
  });
});

describe('refresh tokens', () => {
  it('rotate, and a reused refresh token revokes the whole connection', async () => {
    const g = await approvedCode();
    const first = (await token({ grant_type: 'authorization_code', code: g.code, client_id: g.clientId, redirect_uri: REDIRECT, code_verifier: g.verifier })).body;
    const second = (await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token!, client_id: g.clientId })).body;
    expect(second.access_token).toMatch(/^qat_/);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    // Someone replays the old refresh token: that signals theft, so everything is revoked.
    expect((await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token!, client_id: g.clientId })).body.error).toBe('invalid_grant');
    expect(oauth.resolveAccessToken(second.access_token!)).toBeNull();
  });

  it('revoking the agent from Telegram ends its tokens', async () => {
    const g = await approvedCode();
    const t = (await token({ grant_type: 'authorization_code', code: g.code, client_id: g.clientId, redirect_uri: REDIRECT, code_verifier: g.verifier })).body;
    const key = oauth.resolveAccessToken(t.access_token!)!;
    db.revokeAgentKey(key.id, 7);
    expect(oauth.resolveAccessToken(t.access_token!)).toBeNull();
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: g.clientId })).body.error).toBe('invalid_grant');
  });
});
