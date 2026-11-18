/** Render the four receipt card cases for review.  npx tsx scripts/receipt-preview.ts <outdir> */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { receiptCard } from '../src/cards.js';
import { tokenLogo } from '../src/logos.js';
const out = process.argv[2]!;
const tx = '0x8f3a91c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e2c1d';
const dog = { symbol: 'QTDOG', address: '0xb3b3d5a8e9a4b7c0b1d9b0f2a3c4d5e6f7083763' as const, logo: null };
const qms = { symbol: 'QMS', address: '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34' as const, logo: await tokenLogo('0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34') };
const base = { tx, link: 't.me/QalibreBot' };
writeFileSync(join(out, 'receipt-buy.png'), await receiptCard({ ...base, side: 'Bought', got: '1,204,331', gotSymbol: 'QTDOG', paid: '0.1', paidSymbol: 'QMS', token: dog, vsDirectPct: 0, settledSecs: 9, pnlPct: null }));
writeFileSync(join(out, 'receipt-sell-gain.png'), await receiptCard({ ...base, side: 'Sold', got: '0.1834', gotSymbol: 'QMS', paid: '1,204,331', paidSymbol: 'QTDOG', token: dog, vsDirectPct: 0.42, settledSecs: 12, pnlPct: 83.4 }));
writeFileSync(join(out, 'receipt-sell-loss.png'), await receiptCard({ ...base, side: 'Sold', got: '0.0712', gotSymbol: 'QMS', paid: '1,204,331', paidSymbol: 'QTDOG', token: dog, vsDirectPct: 0, settledSecs: 14, pnlPct: -28.8 }));
writeFileSync(join(out, 'receipt-qms.png'), await receiptCard({ ...base, side: 'Bought', got: '0.5', gotSymbol: 'QMS', paid: '0.17', paidSymbol: 'USDC', token: qms, vsDirectPct: 0, settledSecs: 11, pnlPct: null }));
console.log('ok');
