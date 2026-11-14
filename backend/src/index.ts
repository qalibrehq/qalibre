import { config } from './config.js';
import { openDb } from './db.js';
import { Bot } from './telegram.js';
import { createService } from './service.js';
import { startApi } from './api.js';
import { setupBot, startBot } from './bot.js';
import { createOwnerOps } from './ownerops.js';
import { createChat, type Chat } from './chat.js';
import { createSocial } from './social.js';
import { onTokenChecked } from './tokens.js';

const db = openDb(config.dbPath);
onTokenChecked((s) => db.recordCheck(s.token.address, s.verdict));
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
const social = createSocial({ bot, db, svc, username: me.username });
startBot(bot, db, svc, chat, social);
startApi(db, svc, createOwnerOps(db, { onApproved: (tgId, tokens) => chat?.afterApproval(tgId, tokens) }), { invite: (id) => social.inviteSummary(id), botUsername: me.username });

setInterval(() => void svc.runBatch(), config.tickMs);

// Free hosts put a service to sleep after ~15 minutes without inbound requests. Render tells us our public
// address, so we visit ourselves through the internet every 10 minutes; the bot and batch engine stay awake.
const publicUrl = process.env.RENDER_EXTERNAL_URL;
if (publicUrl) {
  setInterval(() => void fetch(`${publicUrl}/api/health`).catch(() => undefined), 10 * 60_000);
}
console.log(`Qalibre backend running. Settlement ${svc.deployment.settlement}. Instant orders clear in the next block; best-price orders wait up to ${config.bestWindowMs / 1000}s for a match.`);
