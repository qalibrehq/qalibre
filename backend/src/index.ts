import { config, TOKENS } from './config.js';
import { openDb } from './db.js';
import { Bot } from './telegram.js';
import { createService } from './service.js';
import { startApi } from './api.js';
import { setupBot, startBot } from './bot.js';
import { createOwnerOps } from './ownerops.js';
import { createChat, type Chat } from './chat.js';
import { createSocial } from './social.js';
import { createWatcher } from './watch.js';
import { checkToken, poolOf, tokenInfo } from './tokens.js';
import { publicClient } from '../../solver/src/chain.js';
import { erc20Abi, type Address } from 'viem';
import { onTokenChecked } from './tokens.js';
import { createAgentHandler } from './agent.js';
import { createOAuth } from './oauth.js';
import { esc } from './telegram.js';

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
// OAuth for the agent connector: AI apps connect by approval in Telegram, no key to copy.
const oauth = createOAuth(db, { issuer: config.miniAppUrl ? new URL(config.miniAppUrl).origin : 'https://app.qalibre.app', botUsername: me.username });
startBot(bot, db, svc, chat, social, oauth);
// Agent connector (MCP): every order an agent places is announced to its owner with a one-tap revoke.
const agent = createAgentHandler({
  db,
  svc,
  oauth,
  announce: async (key, what) => {
    await bot.sendMessage(key.tg_id, `<b>Your agent ${esc(key.label)}</b> ${esc(what)}.
You'll get a message when it settles, at no worse than a direct swap. Not you? Revoke it now.`, {
      reply_markup: { inline_keyboard: [[{ text: `Revoke ${key.label}`, callback_data: `ag:rv:${key.id}` }, { text: 'All agents', callback_data: 'ag:list' }]] },
    });
  },
});
startApi(db, svc, createOwnerOps(db, { onApproved: (tgId, tokens) => chat?.afterApproval(tgId, tokens) }), { invite: (id) => social.inviteSummary(id), botUsername: me.username, agent, oauth: oauth.handle });

setInterval(() => void svc.runBatch(), config.tickMs);

// We keep watching after you buy: tokens bought through Qalibre in the last 30 days, read cheaply every five
// minutes, with holders alerted (and offered Sell all) if the pool is drained, supply jumps or selling is blocked.
const chain = publicClient();
const core = new Set([TOKENS.WQMS.toLowerCase(), TOKENS.USDC.toLowerCase()]);
createWatcher({
  tokens: () => db.watchedTokens(Math.floor(Date.now() / 1000) - 30 * 86_400, TOKENS.WQMS).filter((t) => !core.has(t.toLowerCase())),
  read: async (t) => {
    const info = await tokenInfo(t as Address);
    const [pool, supply] = await Promise.all([poolOf(info), chain.readContract({ address: info.address, abi: erc20Abi, functionName: 'totalSupply' })]);
    return { qmsReserve: pool.qmsReserve, supply };
  },
  sellBlocked: async (t) => {
    const s = await checkToken(t as Address, { fresh: true });
    return { blocked: s.verdict === 'blocked', reason: s.reason };
  },
  holders: async (t) =>
    Promise.all(
      db.tokenBuyers(t, TOKENS.WQMS).map(async (h) => ({ tgId: h.tg_id, balance: await chain.readContract({ address: t as Address, abi: erc20Abi, functionName: 'balanceOf', args: [h.account as Address] }) })),
    ),
  alert: async (tgId, token, kind, detail) => chat?.watchAlert(tgId, token, kind, detail),
}).start();

// Free hosts put a service to sleep after ~15 minutes without inbound requests. Render tells us our public
// address, so we visit ourselves through the internet every 10 minutes; the bot and batch engine stay awake.
const publicUrl = process.env.RENDER_EXTERNAL_URL;
if (publicUrl) {
  setInterval(() => void fetch(`${publicUrl}/api/health`).catch(() => undefined), 10 * 60_000);
}
console.log(`Qalibre backend running. Settlement ${svc.deployment.settlement}. Instant orders clear in the next block; best-price orders wait up to ${config.bestWindowMs / 1000}s for a match.`);
