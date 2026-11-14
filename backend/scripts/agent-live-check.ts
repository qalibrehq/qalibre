/**
 * Live read-only check of the agent connector against QMS testnet, on a COPY of a database. Places no orders and
 * starts no bot.   npx tsx scripts/agent-live-check.ts <db-copy.sqlite>
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { createAgentHandler, issueAgentKey } from '../src/agent.js';

delete process.env.TURSO_DATABASE_URL; // never touch production storage from here
const db = openDb(process.argv[2]!);
const user = db.raw.prepare('SELECT tg_id FROM users WHERE account IS NOT NULL LIMIT 1').get() as { tg_id: number };
const svc = createService(db, async () => undefined);
const { secret } = issueAgentKey(db, user.tg_id, { label: 'Live check', canTrade: false });
const handler = createAgentHandler({ db, svc, announce: async () => undefined });
const server = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
const dog = (JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', '19480-testtokens.json'), 'utf8')) as Record<string, string>).QTDOG!;
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j = (await r.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { error: j.result.isError ?? false, body: j.result.content[0]!.text };
};
const show = (label: string, v: { error: boolean; body: string }) => console.log(`\n== ${label}${v.error ? ' (refused)' : ''}\n${v.body.slice(0, 900)}`);
show('get_wallet', await call('get_wallet', {}));
show('check_token QTDOG', await call('check_token', { token: dog }));
show('quote buy 0.01 QMS of QTDOG', await call('quote', { side: 'buy', token: dog, qms_amount: '0.01' }));
show('buy with a read-only key', await call('buy', { token: dog, qms_amount: '0.01' }));
show('list_orders', await call('list_orders', { limit: 2 }));
server.close();
process.exit(0);
