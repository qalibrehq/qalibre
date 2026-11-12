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
import { fillCard, positionCard, safetyCard, savingsCard } from './cards.js';
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
    await bot.sendMessage(
      tgId,
      [
        '<b>Invite friends</b>',
        '',
        `When someone joins with your link, you earn ${share}% of Qalibre's fee on their trades for ${REFERRAL_DAYS} days. It comes out of our fee, so your friends pay exactly the same.`,
        '',
        `<code>${link}</code>`,
        '',
        `Invited  ${r.invited}  ·  trading  ${r.trading}`,
        `Earned  ${fmtSig(Number(r.earned) / 1e18)} QMS  ·  paid  ${fmtSig(Number(r.paid) / 1e18)} QMS`,
        '',
        '<i>Rewards are paid in QMS to your Qalibre wallet each week.</i>',
      ].join('\n'),
      { reply_markup: { inline_keyboard: [[{ text: 'Share your link', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Trade on QMS with Qalibre: matched first, never worse than a direct swap, scam tokens blocked.')}` }]] } },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Safety cards (groups, and the "Share" on a token)
  // ---------------------------------------------------------------------------------------------

  function headline(s: Safety): { headline: string; reason: string } {
    if (s.verdict === 'blocked') {
      const r = s.reason ?? '';
      if (/not sell/.test(r)) return { headline: 'Honeypot', reason: `You can buy ${s.token.symbol}. You cannot sell it.` };
      if (/tax/.test(r)) {
        const detail = s.findings.find((f) => f.title === 'Hidden transfer tax')?.detail ?? 'Part of every buy and sale is taken.';
        return { headline: 'Hidden tax', reason: detail.replace(/^About/, 'It takes about') };
      }
      if (/no QWAP pool/.test(r)) return { headline: 'No pool', reason: 'There is nowhere to trade it against QMS.' };
      return { headline: 'Blocked', reason: r };
    }
    const top = s.findings.filter((f) => f.level === 'caution' || f.level === 'danger').slice(0, 2).map((f) => f.title);
    if (s.verdict === 'high') return { headline: 'High risk', reason: top.join('. ') + '.' };
    if (s.verdict === 'caution') return { headline: 'Some risk', reason: top.length ? top.join('. ') + '.' : 'Read the details before buying.' };
    return { headline: 'Low risk', reason: 'Simulated buy and sale went through, with no hidden tax.' };
  }

  async function safetyImage(s: Safety): Promise<Buffer> {
    const h = headline(s);
    return safetyCard({ symbol: s.token.symbol, address: s.token.address, logo: await tokenLogo(s.token.address), verdict: s.verdict, score: s.score, headline: h.headline, reason: h.reason, link: shortLink });
  }

  async function postSafety(chatId: number, token: Address, replyTo: number | undefined, auto: boolean) {
    const s = await checkToken(token);
    if (auto && s.verdict !== 'blocked' && s.verdict !== 'high') return; // speak only when it matters
    if (auto && db.alertSeen(chatId, s.token.address, ALERT_REPEAT_SEC)) return;
    const h = headline(s);
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
        await postSafety(chatId, getAddress(addr[0]) as Address, messageId, false).catch(() => bot.sendMessage(chatId, 'That address is not a token Qalibre can read.', reply));
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
    const png = positionCard({ symbol: p.token.symbol, pnlPct: p.pnlPct, held: fmtToken(p.balance, p.token.decimals), cost: fmtSig(Number(p.costQms) / 1e18), value: fmtSig(Number(p.exitQms) / 1e18), token: { symbol: p.token.symbol, address: p.token.address, logo: await tokenLogo(p.token.address) }, link: shortLink });
    await sendShare(tgId, png, `${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}% on ${p.token.symbol}, traded with Qalibre.`);
  }

  async function shareSavings(tgId: number) {
    const p = await svc.portfolio(tgId);
    if (!p.registered || p.trades === 0) return void (await bot.sendMessage(tgId, 'Make a trade first. Your savings card shows what Qalibre saved you compared with swapping directly.'));
    const first = db.filledOrders(tgId)[0];
    const since = new Date((first?.created_at ?? Date.now() / 1000) * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const png = savingsCard({ savedUsd: p.savedUsd >= 100 ? p.savedUsd.toFixed(0) : p.savedUsd.toFixed(2), trades: p.trades, since, link: shortLink });
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
    const s = await svc.publicStats();
    await bot.sendMessage(
      chatId,
      [
        '<b>Qalibre, so far</b>',
        '',
        `Saved versus swapping directly  <b>$${s.savedUsd.toFixed(2)}</b>`,
        `Trades  ${s.trades.toLocaleString('en-US')}  ·  traders  ${s.traders.toLocaleString('en-US')}  ·  groups protected  ${s.groups.toLocaleString('en-US')}`,
        '',
        'The settlement contract refuses any trade that pays less than a direct swap.',
      ].join('\n'),
      extra,
    );
  }

  return { applyInvite, inviteMessage, inviteLink, onGroupMessage, onMembership, shareFill, sharePosition, shareSavings, statsMessage, safetyImage };
}

export type Social = ReturnType<typeof createSocial>;
export type { OrderRow };
