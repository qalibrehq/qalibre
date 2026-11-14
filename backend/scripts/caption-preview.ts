/** Print the chat caption for test tokens as the user sees it.  npx tsx scripts/caption-preview.ts */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from 'viem';
import { ROOT } from '../src/config.js';
import { checkToken } from '../src/tokens.js';
import { cardText } from '../src/chat.js';
const tt = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', '19480-testtokens.json'), 'utf8')) as Record<string, Address>;
for (const sym of ['QTPLAIN', 'QTDOG']) {
  const s = await checkToken(tt[sym]!);
  const text = cardText(s, [], true).replace(/<\/?(b|i|code)>/g, '').replace(/&amp;/g, '&');
  console.log(`\n==== ${sym} (${text.length} chars)\n${text}`);
}
process.exit(0);
