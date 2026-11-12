import { config } from './config.js';
import { openDb } from './db.js';
import { Bot } from './telegram.js';
import { createService } from './service.js';
import { startApi } from './api.js';
import { setupBot, startBot } from './bot.js';
import { createOwnerOps } from './ownerops.js';
import { createChat, type Chat } from './chat.js';

const db = openDb(config.dbPath);
const bot = new Bot(config.botToken);
let chat: Chat | null = null;
const svc = createService(db, async (tgId, html, ctx) => {
  // A chat trade updates its own status message in place; everything else is a new message.
  if (ctx && chat && (await chat.onOrderUpdate(tgId, html, ctx.order.id, ctx.kind))) return;
  await bot.sendMessage(tgId, html).catch((e) => console.error('notify failed', (e as Error).message));
});

const me = await bot.call<{ username: string }>('getMe');
chat = createChat({ bot, db, svc, username: me.username });
await setupBot(bot).catch((e) => console.error('bot setup', (e as Error).message));
startBot(bot, db, svc, chat);
startApi(db, svc, createOwnerOps(db));

setInterval(() => void svc.runBatch(), config.tickMs);
console.log(`Qalibre backend running. Settlement ${svc.deployment.settlement}. Instant orders clear in the next block; best-price orders wait up to ${config.bestWindowMs / 1000}s for a match.`);
