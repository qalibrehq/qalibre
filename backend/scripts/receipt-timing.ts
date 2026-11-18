/** How long drawing a receipt card takes, cold and warm.  npx tsx scripts/receipt-timing.ts */
import { receiptCard } from '../src/cards.js';
const p = { side: 'Bought' as const, got: '1,204,331', gotSymbol: 'QTDOG', paid: '0.1', paidSymbol: 'QMS', token: { symbol: 'QTDOG', address: '0xb3b3d5a8e9a4b7c0b1d9b0f2a3c4d5e6f7083763', logo: null }, vsDirectPct: 0, settledSecs: 9, pnlPct: null, tx: '0x' + 'ab'.repeat(32), person: { name: 'Kingsley', photo: null }, link: 't.me/QalibreBot' };
for (let i = 0; i < 4; i++) {
  const t = performance.now();
  const b = await receiptCard(p);
  console.log(`off-thread ${i === 0 ? "cold" : "warm"}: ${Math.round(performance.now() - t)}ms, ${Math.round(b.length / 1024)} KB`);
}
