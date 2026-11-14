import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { createAgentHandler, hashKey, issueAgentKey } from '../src/agent.js';
import type { Service } from '../src/service.js';

const DOG = '0xb3b3426CDc928377e8221f9DB75CF3Fdd26a3763';
const db = openDb(':memory:');
const announced: string[] = [];
// The service is never reached on the paths tested here: every refusal must happen before any trade logic runs.
const svc = new Proxy({}, { get: () => () => { throw new Error('service must not be called'); } }) as unknown as Service;
const handler = createAgentHandler({ db, svc, announce: async (_k, what) => void announced.push(what) });

let server: Server;
let url = '';
beforeAll(async () => {
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const rpc = (method: string, params: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const call = async (key: string, name: string, args: Record<string, unknown>) => {
  const r = await rpc('tools/call', { name, arguments: args }, bearer(key));
  return (await r.json()) as { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } };
};

describe('agent keys', () => {
  it('stores only a hash, never the secret', () => {
    const { id, secret } = issueAgentKey(db, 1, { label: 'Test', canTrade: true });
    expect(secret).toMatch(/^qak_[A-Za-z0-9_-]{43}$/);
    const row = db.agentKey(id)!;
    expect(row.key_hash).toBe(hashKey(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.prefix).toBe(secret.slice(0, 8));
  });

  it('revocation is owner-only', () => {
    const { id } = issueAgentKey(db, 1, { label: 'Mine', canTrade: true });
    expect(db.revokeAgentKey(id, 2)).toBe(false); // someone else's tg id
    expect(db.revokeAgentKey(id, 1)).toBe(true);
    expect(db.revokeAgentKey(id, 1)).toBe(false); // already revoked
  });
});

describe('the /mcp endpoint refuses before doing anything', () => {
  it('without a key', async () => {
    const r = await rpc('tools/list', {});
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('with a malformed or unknown key', async () => {
    expect((await rpc('tools/list', {}, bearer('nope'))).status).toBe(401);
    expect((await rpc('tools/list', {}, bearer('qak_' + 'A'.repeat(43)))).status).toBe(401);
  });

  it('with the key in the query string instead of the header', async () => {
    const { secret } = issueAgentKey(db, 1, { label: 'Q', canTrade: true });
    const r = await fetch(`${url}?key=${secret}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('with a revoked or expired key', async () => {
    const a = issueAgentKey(db, 1, { label: 'R', canTrade: true });
    db.revokeAgentKey(a.id, 1);
    expect((await rpc('tools/list', {}, bearer(a.secret))).status).toBe(401);
    const b = issueAgentKey(db, 1, { label: 'E', canTrade: true });
    db.raw.prepare('UPDATE agent_keys SET expires_at = 1 WHERE id = ?').run(b.id);
    expect((await rpc('tools/list', {}, bearer(b.secret))).status).toBe(401);
  });

  it('from a browser (any Origin header)', async () => {
    const { secret } = issueAgentKey(db, 1, { label: 'B', canTrade: true });
    expect((await rpc('tools/list', {}, { ...bearer(secret), origin: 'https://evil.example' })).status).toBe(403);
  });

  it('for GET and oversized bodies', async () => {
    const { secret } = issueAgentKey(db, 1, { label: 'G', canTrade: true });
    expect((await fetch(url, { headers: bearer(secret) })).status).toBe(405);
    const big = await fetch(url, { method: 'POST', headers: { ...bearer(secret), 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(70_000) }) });
    expect(big.status).toBe(413);
  });
});

describe('what an agent can do', () => {
  it('has no tool that moves money out', async () => {
    const { secret } = issueAgentKey(db, 1, { label: 'L', canTrade: true });
    const r = await rpc('tools/list', {}, bearer(secret));
    expect(r.status).toBe(200);
    const names = ((await r.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['buy', 'check_token', 'get_order', 'get_wallet', 'list_orders', 'quote', 'sell']);
    expect(names.some((n) => /withdraw|send|transfer|approve|limit/.test(n))).toBe(false);
  });

  it('a read-only key cannot trade', async () => {
    const { secret } = issueAgentKey(db, 1, { label: 'RO', canTrade: false });
    const out = await call(secret, 'buy', { token: DOG, qms_amount: '0.1' });
    expect(out.result?.isError).toBe(true);
    expect(out.result?.content[0]!.text).toMatch(/read-only/);
  });

  it('cannot exceed its per-trade cap', async () => {
    const { secret } = issueAgentKey(db, 1, { label: 'C', canTrade: true });
    const out = await call(secret, 'buy', { token: DOG, qms_amount: '1.5' });
    expect(out.result?.content[0]!.text).toMatch(/per-trade cap/);
  });

  it('cannot exceed its daily cap', async () => {
    const { id, secret } = issueAgentKey(db, 1, { label: 'D', canTrade: true });
    // 4.5 QMS already committed today by this key.
    db.insertOrder({ id: '11111111-1111-4111-8111-111111111111', tg_id: 1, account: '0x1', sell_token: '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34', buy_token: DOG, sell_amount: (45n * 10n ** 17n).toString(), min_buy_amount: '0', max_network_fee: '0', valid_to: 0, nonce: '1', signature: '0x', mode: 'best', agent_key_id: id });
    const out = await call(secret, 'buy', { token: DOG, qms_amount: '1' });
    expect(out.result?.content[0]!.text).toMatch(/daily cap/);
  });

  it('rejects malformed amounts and addresses', async () => {
    const { secret } = issueAgentKey(db, 1, { label: 'M', canTrade: true });
    expect((await call(secret, 'buy', { token: 'not-an-address', qms_amount: '0.1' })).result?.content[0]!.text).toMatch(/valid token address/);
    expect((await call(secret, 'buy', { token: DOG, qms_amount: '-1' })).result?.content[0]!.text).toMatch(/plain number/);
    expect((await call(secret, 'buy', { token: DOG, qms_amount: '1e18' })).result?.content[0]!.text).toMatch(/plain number/);
  });

  it('cannot read another user\'s order', async () => {
    db.insertOrder({ id: '22222222-2222-4222-8222-222222222222', tg_id: 99, account: '0x2', sell_token: DOG, buy_token: DOG, sell_amount: '1', min_buy_amount: '0', max_network_fee: '0', valid_to: 0, nonce: '2', signature: '0x', mode: 'best' });
    const { secret } = issueAgentKey(db, 1, { label: 'O', canTrade: true });
    const out = await call(secret, 'get_order', { id: '22222222-2222-4222-8222-222222222222' });
    expect(out.result?.content[0]!.text).toMatch(/No such order/);
  });

  it('nothing was announced, because nothing was placed', () => {
    expect(announced).toEqual([]);
  });
});
