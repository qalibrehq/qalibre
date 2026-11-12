/** Render the chat token card from a live check.  npx tsx scripts/token-card-preview.ts <outdir> */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from 'viem';
import { ROOT } from '../src/config.js';
import { checkToken } from '../src/tokens.js';
import { fmtPrice, tokenCard } from '../src/cards.js';
const tt = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', '19480-testtokens.json'), 'utf8')) as Record<string, Address>;
const s = await checkToken(tt.QTDOG!);
for (const v of [1.635e-7, 0.000123, 0.0042, 3.14159, 12345.6]) console.log(v, '->', fmtPrice(v));
const base = { token: { symbol: s.token.symbol, address: s.token.address, logo: null }, name: s.token.name, priceQms: s.priceQms, priceUsd: s.priceUsd, liquidityUsd: s.liquidityUsd, score: s.score, link: 't.me/QalibreBot' };
writeFileSync(join(process.argv[2]!, 'token-QTDOG.png'), tokenCard({ ...base, verdict: s.verdict as 'high' }));
writeFileSync(join(process.argv[2]!, 'token-sample-ok.png'), tokenCard({ ...base, verdict: 'ok', score: 86 }));
console.log('ok');
process.exit(0);
