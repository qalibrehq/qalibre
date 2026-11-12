/** Render every card type with realistic data for design review.  npx tsx scripts/cards-preview.ts <outdir> */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillCard, positionCard, safetyCard, savingsCard } from '../src/cards.js';
const out = process.argv[2] ?? '.';
const link = 't.me/QalibreBot';
writeFileSync(join(out, 'fill.png'), fillCard({ side: 'Bought', got: '61,540.99', gotSymbol: 'QTDOG', paid: '0.01', paidSymbol: 'QMS', vsDirectPct: 0.42, feePaid: '0.0004 QTDOG', block: '332,331', link }));
writeFileSync(join(out, 'position.png'), positionCard({ symbol: 'QTDOG', pnlPct: 42.1, held: '61,540.99', cost: '0.01', value: '0.0142', profit: '+0.0042 QMS', link }));
writeFileSync(join(out, 'savings.png'), savingsCard({ savedUsd: '1.24', trades: 18, since: 'Nov 2026', link }));
writeFileSync(join(out, 'honeypot.png'), safetyCard({ symbol: 'QTHONEY', address: '0xB0291614E687462a6E554a5F37d1bFcC2C5C9BDE', verdict: 'blocked', score: 10, headline: 'Honeypot', reason: 'You could buy it, but you could not sell it.', checks: [{ label: 'Simulated buy', value: 'Went through' }, { label: 'Simulated sale', value: 'Blocked', tone: 'danger' }, { label: 'Pool', value: '$3' }], link }));
console.log('ok');
