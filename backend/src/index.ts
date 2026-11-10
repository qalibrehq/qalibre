import { config } from './config.js';
import { openDb } from './db.js';
import { Bot } from './telegram.js';
import { createService } from './service.js';
import { startApi } from './api.js';
import { setupBot, startBot } from './bot.js';

const db = openDb(config.dbPath);
const bot = new Bot(config.botToken);
const svc = createService(db, async (tgId, html) => {
  await bot.sendMessage(tgId, html).catch((e) => console.error('notify failed', (e as Error).message));
});

await setupBot(bot).catch((e) => console.error('bot setup', (e as Error).message));
startBot(bot, db, svc);
startApi(db, svc);

setInterval(() => void svc.runBatch(), config.tickMs);
console.log(`Qalibre backend running. Settlement ${svc.deployment.settlement}. Instant orders clear in the next block; best-price orders wait up to ${config.bestWindowMs / 1000}s for a match.`);
