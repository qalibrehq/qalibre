/** Renders the stats card for review with the given numbers.  npx tsx scripts/stats-preview.ts <out.png> */
import { writeFileSync } from 'node:fs';
import { statsCard } from '../src/cards.js';
writeFileSync(process.argv[2]!, statsCard({ checked: 3, blocked: 1, trades: 8, traders: 1, savedUsd: 0, link: 't.me/QalibreBot' }));
