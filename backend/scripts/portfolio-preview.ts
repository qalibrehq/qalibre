/** Render the portfolio card for review.  npx tsx scripts/portfolio-preview.ts <outdir> */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { portfolioCard } from '../src/cards.js';
import { tokenLogo } from '../src/logos.js';
const out = process.argv[2]!;
const QMS = '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34';
const USDC = (await import('../src/config.js')).TOKENS.USDC;
const tk = (symbol: string, address: string, logo: string | null = null) => ({ symbol, address, logo });
const rows = [
  { token: tk('QMS', QMS, await tokenLogo(QMS)), amount: '12.48 QMS', valueUsd: 4.12, changePct: null },
  { token: tk('USDC', USDC, await tokenLogo(USDC)), amount: '2.35 USDC', valueUsd: 2.35, changePct: null },
  { token: tk('QTPLAIN', '0xbBB43127661FaD739FD793f3aAc5b35EeCbA3800'), amount: '2,095 QTPLAIN', valueUsd: 1.84, changePct: 12.4 },
  { token: tk('QTDOG', '0xb3b3d5a8e9a4b7c0b1d9b0f2a3c4d5e6f7083763'), amount: '1.2M QTDOG', valueUsd: 0.62, changePct: -28.8 },
  { token: tk('MOONCAT', '0xc4c4d5a8e9a4b7c0b1d9b0f2a3c4d5e6f7083111'), amount: '48,210 MOONCAT', valueUsd: 0.31, changePct: 3.1 },
];
writeFileSync(join(out, 'portfolio-many.png'), await portfolioCard({ totalUsd: 9.24, changeUsd: 0.21, rows, more: 3, person: { name: 'Kingsley', photo: null }, link: 't.me/QalibreBot' }));
writeFileSync(join(out, 'portfolio-two.png'), await portfolioCard({ totalUsd: 6.47, changeUsd: null, rows: rows.slice(0, 2), more: 0, link: 't.me/QalibreBot' }));
console.log('ok');
