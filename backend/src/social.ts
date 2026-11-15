/**
 * The parts of Qalibre that people show and share: scam alerts in groups, shareable cards, invites, stats.
 *
 * Rules:
 *  - Groups are read-only. Qalibre never trades from a group and never asks for anything there.
 *  - Auto alerts speak only when there is something to warn about (blocked or high risk), at most once per
 *    token per group every 6 hours, and admins can turn them off. A quiet bot is a welcome bot.
 *  - Every shared card links back with the sharer's invite code, so sharing is also inviting.
 *  - Numbers on cards come from the same functions as the app (src/value.ts); a card never says more than
 *    the receipt does.
 */
import { randomBytes } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import type { Db, OrderRow } from './db.js';
import { Bot, esc } from './telegram.js';
import { REFERRAL_DAYS, REFERRAL_SHARE_BPS, type Service } from './service.js';
import { checkToken, tokenInfo, type Safety } from './tokens.js';
import { fillCard, inviteCard, positionCard, safetyCard, safetyHeadline, savingsCard, statsCard, type Person } from './cards.js';
import { improvement } from './value.js';
import { tokenLogo } from './logos.js';
import { fmtSig, fmtToken } from './chat.js';

const ALERT_REPEAT_SEC = 6 * 3600;

export function createSocial({ bot, db, svc, username }: { bot: Bot; db: Db; svc: Service; username: string }) {
  const shortLink = `t.me/${username}`;
  const perChat = new Map<number, number[]>();

  function chatRateOk(chatId: number, max: number, windowMs: number): boolean {
    const now = Date.now();
    const recent = (perChat.get(chatId) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    recent.push(now);
    perChat.set(chatId, recent);
    return true;
  }

  /** The sharer as shown on their own cards: first name and Telegram photo (if they have one). */
  async function personOf(tgId: number): Promise<Person> {
    return { name: db.getUser(tgId)?.first_name?.trim() || 'A Qalibre trader', photo: await bot.userPhoto(tgId) };
  }

  // ---------------------------------------------------------------------------------------------
  // Invites
  // ---------------------------------------------------------------------------------------------

  function inviteLink(tgId: number): string {
    db.upsertUser(tgId, db.getUser(tgId)?.first_name ?? null);
    const code = db.refCode(tgId, () => randomBytes(5).toString('base64url'));
    return `https://t.me/${username}?start=r_${code}`;
  }

  /** /start r_<code>: remember who invited this person (once, before they have a wallet). */
  function applyInvite(tgId: number, payload: string): boolean {
    const m = payload.match(/^r_([A-Za-z0-9_-]{4,16})$/);
    if (!m) return false;
    const inviter = db.userByRefCode(m[1]!);
    if (inviter && inviter.tg_id !== tgId) db.setReferrer(tgId, inviter.tg_id);
    return true;
  }

  async function inviteMessage(tgId: number) {
    const link = inviteLink(tgId);
    const r = db.referralStats(tgId);
    const share = REFERRAL_SHARE_BPS / 100;
    const png = inviteCard({ sharePct: share, days: REFERRAL_DAYS, person: await personOf(tgId), link: link.replace(/^https:\/\//, '') });
    const caption = [
      `<code>${link}</code>`,
      '',
      `Invited ${r.invited}, ${r.trading} trading`,
      `Earned ${fmtSig(Number(r.earned) / 1e18)} QMS, ${fmtSig(Number(r.paid) / 1e18)} QMS paid out`,
      '',
      `<i>You earn ${share}% of Qalibre's fee on their trades for ${REFERRAL_DAYS} days, paid weekly in QMS to your wallet. It comes out of our fee, so your friends pay the same.</i>`,
    ].join('\n');
    await bot.sendPhoto(tgId, png, caption, {
      reply_markup: { inline_keyboard: [[{ text: 'Share your link', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Trade on QMS with Qalibre: scam tokens blocked before you buy, never worse than a direct swap.')}` }]] },
    });
  }


  // ---------------------------------------------------------------------------------------------
  // Safety cards (groups, and the "Share" on a token)
  // ---------------------------------------------------------------------------------------------

  async function safetyImage(s: Safety): Promise<Buffer> {
    const h = safetyHeadline(s);
    return safetyCard({ symbol: s.token.symbol, address: s.token.address, logo: await tokenLogo(s.token.address), verdict: s.verdict, score: s.score, headline: h.headline, reason: h.reason, link: shortLink });
  }

  async function postSafety(chatId: number, token: Address, replyTo: number | undefined, auto: boolean) {
    const s = await checkToken(token);
    if (auto && s.verdict !== 'blocked' && s.verdict !== 'high') return; // speak only when it matters
    if (auto && db.alertSeen(chatId, s.token.address, ALERT_REPEAT_SEC)) return;
    const h = safetyHeadline(s);
    const caption = auto
      ? `<b>Careful: ${esc(s.token.symbol)} ${s.verdict === 'blocked' ? `is blocked (${esc(h.headline.toLowerCase())})` : `is high risk (${s.score}/100)`}.</b>\n${esc(h.reason)}\n<i>Checked by Qalibre with a simulated buy and sale. Nothing was spent.</i>`
      : `<b>${esc(s.token.symbol)}</b>  ${s.verdict === 'blocked' ? 'Blocked' : `${s.score}/100`}\n${esc(h.reason)}`;
    await bot.sendPhoto(chatId, await safetyImage(s), caption, {
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      reply_markup: { inline_keyboard: [[{ text: s.tradable ? `Trade ${s.token.symbol} in Qalibre` : 'Check any token', url: `https://t.me/${username}?start=t_${s.token.address.slice(2)}` }]] },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------------------------------

  async function isAdmin(chatId: number, userId: number): Promise<boolean> {
    try {
      const m = await bot.call<{ status: string }>('getChatMember', { chat_id: chatId, user_id: userId });
      return m.status === 'creator' || m.status === 'administrator';
    } catch {
      return false;
    }
  }

  async function onGroupMessage(chatId: number, text: string, messageId: number, fromId: number) {
    const [first = '', ...rest] = text.trim().split(/\s+/);
    const cmd = first.toLowerCase();
    const mine = !cmd.includes('@') || cmd.endsWith('@' + username.toLowerCase());
    const base = cmd.replace(/@\w+$/, '');
    const reply = { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } };

    if (base.startsWith('/') && mine) {
      if (base === '/alerts') {
        if (!(await isAdmin(chatId, fromId))) return void (await bot.sendMessage(chatId, 'Only group admins can change scam alerts.', reply));
        const on = rest[0]?.toLowerCase() !== 'off';
        db.setGroupAlerts(chatId, on);
        return void (await bot.sendMessage(chatId, on ? 'Scam alerts are on. Qalibre will warn when someone posts a honeypot or a high-risk token.' : 'Scam alerts are off. Anyone can still check a token with /token and its address.', reply));
      }
      if (base === '/stats') return statsMessage(chatId, reply);
      if (base === '/token' || base === '/check' || base === '/buy') {
        const addr = rest.join(' ').match(/0x[0-9a-fA-F]{40}/);
        if (!addr) return void (await bot.sendMessage(chatId, 'Use <code>/token 0x…</code> with a token address.', reply));
        if (!chatRateOk(chatId, 6, 60_000)) return;
        await postSafety(chatId, getAddress(addr[0]) as Address, messageId, false).catch(() => bot.sendMessage(chatId, 'That address doesn\'t look like a token on QMS. Check it and paste it again.', reply));
      }
      return;
    }
    // Auto alerts: any token address posted in the group (needs the bot's privacy mode off to see messages).
    if (!db.groupAlerts(chatId)) return;
    const addrs = [...new Set((text.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()))].slice(0, 2);
    for (const a of addrs) {
      if (!chatRateOk(chatId, 6, 60_000)) return;
      await postSafety(chatId, getAddress(a) as Address, messageId, true).catch(() => null); // not a token: stay quiet
    }
  }

  /** The bot was added to (or removed from) a group. */
  async function onMembership(u: { chat: { id: number; type: string; title?: string }; new_chat_member: { status: string } }) {
    if (u.chat.type !== 'group' && u.chat.type !== 'supergroup') return;
    if (u.new_chat_member.status !== 'member' && u.new_chat_member.status !== 'administrator') return;
    const fresh = !db.hasGroup(u.chat.id);
    db.upsertGroup(u.chat.id, u.chat.title ?? null);
    if (!fresh) return; // re-added or promoted: no second introduction
    await bot
      .sendMessage(
        u.chat.id,
        [
          '<b>Qalibre is here to keep this group safe.</b>',
          '',
          'When someone posts a token address, Qalibre runs a simulated buy and sale. If it is a honeypot, takes a hidden tax, or is high risk, it says so. Otherwise it stays quiet.',
          '',
          '/token 0x…  check any token',
          '/alerts off  turn alerts off (admins)',
          '',
          'Trading happens only in your private chat with Qalibre, never here.',
        ].join('\n'),
      )
      .catch(() => null);
  }

  // ---------------------------------------------------------------------------------------------
  // Shareable cards
  // ---------------------------------------------------------------------------------------------

  async function shareFill(tgId: number, orderId: string) {
    const o = db.getOrder(orderId);
    if (!o || o.tg_id !== tgId || o.status !== 'filled') return void (await bot.sendMessage(tgId, 'That trade is not available to share.'));
    const [buy, sell] = await Promise.all([tokenInfo(o.buy_token as Address), tokenInfo(o.sell_token as Address)]);
    const direct = BigInt(o.direct_quote ?? '0');
    const pct = direct > 0n ? Number((improvement(o) * 1_000_000n) / direct) / 10_000 : 0;
    // Selling a token back to QMS reads as "Sold"; everything else is a purchase of the token received.
    const sold = !sell.verified && buy.verified;
    const subject = sold ? sell : buy;
    const png = fillCard({
      side: sold ? 'Sold' : 'Bought',
      token: { symbol: subject.symbol, address: subject.address, logo: await tokenLogo(subject.address) },
      person: await personOf(tgId),
      got: fmtToken(BigInt(o.buy_amount!), buy.decimals),
      gotSymbol: buy.symbol,
      paid: fmtToken(BigInt(o.sell_amount), sell.decimals),
      paidSymbol: sell.symbol,
      vsDirectPct: pct,
      link: shortLink,
    });
    await sendShare(tgId, png, pct > 0.0005 ? `Got ${pct.toFixed(2)}% more than a direct swap with Qalibre.` : 'Traded on QMS with Qalibre: never worse than a direct swap.');
  }

  async function sharePosition(tgId: number, token: Address) {
    const p = (await svc.positions(tgId)).find((x) => x.token.address.toLowerCase() === token.toLowerCase());
    if (!p || p.pnlPct === null || p.costQms === null) return void (await bot.sendMessage(tgId, 'There is no position with a known cost to share for this token.'));
    const png = positionCard({ symbol: p.token.symbol, pnlPct: p.pnlPct, held: fmtToken(p.balance, p.token.decimals), cost: fmtSig(Number(p.costQms) / 1e18), value: fmtSig(Number(p.exitQms) / 1e18), token: { symbol: p.token.symbol, address: p.token.address, logo: await tokenLogo(p.token.address) }, person: await personOf(tgId), link: shortLink });
    await sendShare(tgId, png, `${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}% on ${p.token.symbol}, traded with Qalibre.`);
  }

  async function shareSavings(tgId: number) {
    const p = await svc.portfolio(tgId);
    if (!p.registered || p.trades === 0) return void (await bot.sendMessage(tgId, 'Make a trade first. Your savings card shows what Qalibre saved you compared with swapping directly.'));
    if (p.savedUsd < 0.01) {
      return void (await bot.sendMessage(tgId, [
        `<b>No savings yet, and no fees either.</b>`,
        '',
        `Your ${p.trades} ${p.trades === 1 ? 'trade' : 'trades'} settled at exactly the direct QWAP price, because no other trader took the other side in the same batch. Savings come when buyers and sellers meet; until then you pay QWAP's price and nothing to Qalibre.`,
      ].join('\n')));
    }
    const first = db.filledOrders(tgId)[0];
    const since = new Date((first?.created_at ?? Date.now() / 1000) * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const png = savingsCard({ savedUsd: p.savedUsd >= 100 ? p.savedUsd.toFixed(0) : p.savedUsd.toFixed(2), trades: p.trades, since, person: await personOf(tgId), link: shortLink });
    await sendShare(tgId, png, `Saved $${p.savedUsd.toFixed(2)} across ${p.trades} trades with Qalibre, compared with swapping directly.`);
  }

  /** Send a card to the user with a one-tap share that carries their invite link. */
  async function sendShare(tgId: number, png: Buffer, line: string) {
    const link = inviteLink(tgId);
    await bot.sendPhoto(tgId, png, `${esc(line)}\n\n<i>Forward this card, or share it with your invite link:</i>`, {
      reply_markup: { inline_keyboard: [[{ text: 'Share', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(line)}` }]] },
    });
  }

  async function statsMessage(chatId: number, extra: Record<string, unknown> = {}) {
    const st = await svc.publicStats();
    const png = statsCard({ checked: st.checked, blocked: st.blocked, trades: st.trades, traders: st.traders, savedUsd: st.savedUsd, link: shortLink });
    // Only real, non-zero numbers, in plain sentences. A zero is never advertised.
    const n = (v: number) => v.toLocaleString('en-US');
    const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;
    const lines = ['<b>Qalibre so far</b>'];
    if (st.checked > 0) lines.push(`${plural(st.checked, 'token', 'tokens')} checked for scams${st.blocked > 0 ? `, ${n(st.blocked)} blocked` : ''}`);
    if (st.trades > 0) lines.push(`${plural(st.trades, 'trade', 'trades')} settled, none below a direct swap`);
    if (st.savedUsd >= 0.01) lines.push(`$${st.savedUsd.toFixed(2)} saved compared with swapping directly`);
    if (st.groups > 0) lines.push(`Watching ${plural(st.groups, 'group chat', 'group chats')} for scams`);
    if (lines.length === 1) lines.push('Just getting started. Paste any token to run the first check.');
    const caption = lines.join('\n');
    await bot.sendPhoto(chatId, png, caption, extra);
  }


  /** Invite link and its numbers, for the app's Profile. */
  function inviteSummary(tgId: number) {
    const r = db.referralStats(tgId);
    return { link: inviteLink(tgId), invited: r.invited, trading: r.trading, earnedQms: r.earned.toString(), paidQms: r.paid.toString(), sharePct: REFERRAL_SHARE_BPS / 100, days: REFERRAL_DAYS };
  }

  return { inviteSummary, applyInvite, inviteMessage, inviteLink, onGroupMessage, onMembership, shareFill, sharePosition, shareSavings, statsMessage, safetyImage };
}

export type Social = ReturnType<typeof createSocial>;
export type { OrderRow };
