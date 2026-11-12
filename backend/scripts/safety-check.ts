/** Run the safety check on the three labelled test tokens and the registry tokens. npx tsx scripts/safety-check.ts */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from 'viem';
import { checkToken } from '../src/tokens.js';
import { ROOT, TOKENS } from '../src/config.js';

const tt = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', '19480-testtokens.json'), 'utf8')) as Record<string, Address>;
for (const [label, addr] of [['QMS', TOKENS.WQMS], ['QTDOG (clean, mintable)', tt.QTDOG!], ['QTHONEY (honeypot)', tt.QTHONEY!], ['QTTAX (10% tax)', tt.QTTAX!]] as const) {
  const t0 = Date.now();
  const s = await checkToken(addr as Address, { fresh: true });
  console.log(`\n${label}: ${s.verdict.toUpperCase()}  score ${s.score}/100  tradable=${s.tradable}  (${Date.now() - t0} ms)`);
  if (s.reason) console.log(`  reason: ${s.reason}`);
  for (const f of s.findings) console.log(`  ${f.level.toUpperCase().padEnd(8)} ${f.title}: ${f.detail}`);
}
