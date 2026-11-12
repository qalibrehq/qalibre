/** Shared cards with a sharer in the footer (stand-in photo + initial fallback).  npx tsx scripts/person-preview.ts <outdir> */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config.js';
import { fillCard, inviteCard, positionCard, type TokenMark } from '../src/cards.js';
const out = process.argv[2]!;
const photo = `data:image/png;base64,${readFileSync(join(ROOT, 'brand', 'qalibre-telegram-avatar-640.png')).toString('base64')}`;
const dog: TokenMark = { symbol: 'QTDOG', address: '0xb3b3426CDc928377e8221f9DB75CF3Fdd26a3763', logo: null };
writeFileSync(join(out, 'fill.png'), fillCard({ side: 'Bought', got: '61,540.99', gotSymbol: 'QTDOG', paid: '0.01', paidSymbol: 'QMS', vsDirectPct: 0.42, token: dog, person: { name: 'Ada', photo }, link: 't.me/QalibreBot' }));
writeFileSync(join(out, 'position.png'), positionCard({ symbol: 'QTDOG', pnlPct: 42.1, held: '61,540.99', cost: '0.01', value: '0.0142', token: dog, person: { name: 'Ada', photo: null }, link: 't.me/QalibreBot' }));
writeFileSync(join(out, 'invite.png'), inviteCard({ sharePct: 20, days: 90, person: { name: 'Ada', photo }, link: 't.me/QalibreBot?start=r_Hk3pQ' }));
console.log('ok');
