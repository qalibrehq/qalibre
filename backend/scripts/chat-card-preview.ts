/** Build the exact chat token card (image + caption + buttons) the bot sends, for a testnet wallet. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROOT } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { createChat } from '../src/chat.js';
import { QalibreAccountFactoryAbi } from '../../solver/src/abi/QalibreAccountFactory.js';
import { loadDeployment, publicClient } from '../../solver/src/chain.js';

const out = process.argv[2]!;
const tt = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', '19480-testtokens.json'), 'utf8')) as Record<string, Address>;
const keys = JSON.parse(readFileSync(join(ROOT, 'solver', '.demo', 'keys.json'), 'utf8')) as Record<string, Hex>;
const dep = loadDeployment();
const account = await publicClient().readContract({ address: dep.accountFactory, abi: QalibreAccountFactoryAbi, functionName: 'getAddress', args: [privateKeyToAccount(keys.alice!).address, 0n] });
const db = openDb(':memory:');
db.upsertUser(1, 'Alice');
db.setAccount(1, account, dep.settlement, dep.accountFactory);
const sent: { image?: Buffer; caption?: string; markup?: unknown }[] = [];
const bot = {
  call: async () => ({}),
  sendPhoto: async (_c: number, png: Buffer, caption: string, extra: { reply_markup?: unknown }) => (sent.push({ image: png, caption, markup: extra.reply_markup }), { message_id: 1 }),
  sendMessage: async (_c: number, text: string) => (sent.push({ caption: text }), { message_id: 2 }),
};
const chat = createChat({ bot: bot as never, db, svc: createService(db, async () => {}), username: 'QalibreBot' });
for (const k of ['QTDOG', 'QTHONEY']) {
  sent.length = 0;
  await chat.onPrivateText(1, tt[k]!, 10);
  const m = sent[0]!;
  if (m.image) writeFileSync(join(out, `chat-${k}.png`), m.image);
  console.log(`\n===== ${k}  (caption ${m.caption?.length} chars)\n${m.caption}\n--- buttons: ${JSON.stringify((m.markup as { inline_keyboard: { text: string }[][] })?.inline_keyboard?.map((r) => r.map((b) => b.text)))}`);
}
process.exit(0);
