/** Safety check and an agent-sized quote for the plain test token.  npx tsx scripts/check-plain.ts */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUnits, type Address } from 'viem';
import { ROOT, TOKENS } from '../src/config.js';
import { checkToken } from '../src/tokens.js';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
delete process.env.TURSO_DATABASE_URL;
const tt = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', '19480-testtokens.json'), 'utf8')) as Record<string, Address>;
const s = await checkToken(tt.QTPLAIN!, { fresh: true });
console.log(`${s.token.symbol}: ${s.verdict} ${s.score}/100, tradable ${s.tradable}, pool $${s.liquidityUsd.toFixed(2)}`);
for (const f of s.findings) console.log(`  ${f.level.padEnd(7)} ${f.title}`);
const svc = createService(openDb(':memory:'), async () => undefined);
for (const amt of ['0.1', '0.2']) {
  const q = await svc.quote(TOKENS.WQMS as Address, tt.QTPLAIN!, parseUnits(amt, 18));
  console.log(`buy ${amt} QMS: impact ${(q.impactBps / 100).toFixed(2)}%  ${q.impactBps <= 500 ? '(agent allowed)' : '(agent refused)'}`);
}
process.exit(0);
