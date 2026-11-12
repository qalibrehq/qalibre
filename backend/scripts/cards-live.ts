/** Render safety cards from live checks of the labelled test tokens.  npx tsx scripts/cards-live.ts <outdir> */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from 'viem';
import { ROOT } from '../src/config.js';
import { checkToken } from '../src/tokens.js';
import { createSocial } from '../src/social.js';
const tt = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', '19480-testtokens.json'), 'utf8')) as Record<string, Address>;
const social = createSocial({ bot: null as never, db: null as never, svc: null as never, username: 'QalibreBot' });
for (const k of ['QTDOG', 'QTHONEY', 'QTTAX']) writeFileSync(join(process.argv[2]!, `live-${k}.png`), await social.safetyImage(await checkToken(tt[k]!)));
console.log('ok');
process.exit(0);
