/** Render every card type with realistic data for design review.  npx tsx scripts/cards-preview.ts <outdir> */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillCard, positionCard, safetyCard, savingsCard } from '../src/cards.js';
const out = process.argv[2] ?? '.';
const link = 't.me/QalibreBot';
writeFileSync(join(out, 'fill.png'), fillCard({ side: 'Bought', got: '61,540.99', gotSymbol: 'QTDOG', paid: '0.01', paidSymbol: 'QMS', vsDirectPct: 0.42, feePaid: '', block: '', link }));
writeFileSync(join(out, 'fill-direct.png'), fillCard({ side: 'Bought', got: '61,540.99', gotSymbol: 'QTDOG', paid: '0.01', paidSymbol: 'QMS', vsDirectPct: 0, feePaid: '', block: '', link }));
writeFileSync(join(out, 'position.png'), positionCard({ symbol: 'QTDOG', pnlPct: 42.1, held: '61,540.99', cost: '0.01', value: '0.0142', profit: '', link }));
writeFileSync(join(out, 'position-loss.png'), positionCard({ symbol: 'QTDOG', pnlPct: -12.4, held: '61,540.99', cost: '0.01', value: '0.0088', profit: '', link }));
writeFileSync(join(out, 'savings.png'), savingsCard({ savedUsd: '1.24', trades: 18, since: 'Nov 2026', link }));
console.log('ok');
