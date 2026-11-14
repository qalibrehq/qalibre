/** Render token cards with severity flags for review.  npx tsx scripts/flags-preview.ts <outdir> */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenCard } from '../src/cards.js';
const out = process.argv[2]!;
const base = { token: { symbol: 'QTDOG', address: '0xb3b3d5a8e9a4b7c0b1d9b0f2a3c4d5e6f7083763', logo: null }, name: 'Testnet Dog', priceQms: 1.635e-7, priceUsd: 5.5e-7, liquidityUsd: 412, link: 't.me/QalibreBot' };
writeFileSync(join(out, 'flags-high.png'), tokenCard({ ...base, verdict: 'high', score: 38, flags: [{ level: 'danger', text: 'Wallets can be blacklisted' }, { level: 'caution', text: 'Creator can mint more' }, { level: 'caution', text: 'Small pool' }] }));
writeFileSync(join(out, 'flags-caution.png'), tokenCard({ ...base, verdict: 'caution', score: 64, flags: [{ level: 'caution', text: 'Small pool' }, { level: 'caution', text: 'Creator can mint more' }] }));
writeFileSync(join(out, 'flags-ok.png'), tokenCard({ ...base, verdict: 'ok', score: 88, liquidityUsd: 48210, flags: [{ level: 'pass', text: 'You can sell it' }, { level: 'pass', text: 'No hidden tax' }, { level: 'pass', text: 'Fixed supply' }] }));
console.log('ok');
