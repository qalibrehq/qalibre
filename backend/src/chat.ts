/**
 * Chat trading: paste a token address (or /buy), get a card with the safety check, trade with one tap.
 *
 * The rules, in short:
 *  - Button data is an opaque card id plus a fixed operation code. Amounts and addresses never travel
 *    in button data; they are looked up or recomputed on the server at the moment of the press.
 *  - Trades happen only in the private chat. Groups and inline results show read-only cards that link here.
 *  - A press is acknowledged at once; the trade runs after. One order in flight per user.
 *  - High-risk tokens and high price impact need an explicit second tap. Honeypots and taxed tokens have no
 *    Buy buttons at all. Selling (getting out) is never blocked by our score.
 */
import { randomBytes } from 'node:crypto';
import { getAddress, parseUnits, type Address } from 'viem';
import { config, TOKENS } from './config.js';
import type { Db } from './db.js';
import { Bot, esc } from './telegram.js';
import { HighImpact, NeedsApproval, UserError, trimUnits, type Service } from './service.js';
import { cardFlags, safetyCard, safetyHeadline, tokenCard } from './cards.js';
import { tokenLogo } from './logos.js';
import { checkToken, poolOf, resolveToken, type Safety, type TokenInfo } from './tokens.js';

/** Buy sizes in QMS. A card shows the three largest that fit the wallet, the limit and the pool. */
export const LADDER = ['0.01', '0.05', '0.1', '0.25', '0.5', '1', '2', '5', '10'] as const;
const SELL_PCTS = [25, 50, 100] as const;
const WQMS = TOKENS.WQMS.toLowerCase();

type Keyboard = { text: string; callback_data?: string; url?: string; web_app?: { url: string } }[][];

export interface ChatDeps {
  bot: Bot;
  db: Db;
  svc: Service;
  username: string;
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

/** A number with `sig` significant digits, never in exponent form (0.000000163, 12,345.6). */
export function fmtSig(n: number, sig = 4): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: abs >= 1000 ? 0 : 2 });
  const decimals = Math.min(18, sig - 1 - Math.floor(Math.log10(abs)));
  return n.toFixed(decimals).replace(/\.?0+$/, '');
}

export function fmtToken(v: bigint, decimals: number): string {
  const n = Number(v) / 10 ** decimals;
  return n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 4 }) : fmtSig(n);
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const verdictLabel: Record<Safety['verdict'], string> = { ok: 'Low risk', caution: 'Some risk', high: 'High risk', blocked: 'Blocked' };
// Findings read as plain language grouped under headings a first-time user understands, most serious first.
// No emoji and no codes: Telegram text cannot be coloured, so the heading carries the meaning.
const GROUPS: { heading: string; levels: string[] }[] = [
  { heading: 'Warning', levels: ['danger'] },
  { heading: 'Worth knowing', levels: ['caution', 'unknown'] },
  { heading: 'Looks fine', levels: ['pass'] },
];
const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

/** One finding as a sentence: "Small pool: about $14 is available to trade…". Titles only when space is short. */
function findingLine(f: { title: string; detail: string }, detail: boolean): string {
  return detail && f.detail ? `${esc(f.title)}: ${esc(lowerFirst(f.detail))}` : esc(f.title);
}

/** The findings block: a heading per group, problems with their explanation, passes on one quiet line. */
function findingsBlock(findings: Safety['findings'], detail = true, maxProblems = 5): string[] {
  const out: string[] = [];
  for (const g of GROUPS) {
    const items = findings.filter((f) => g.levels.includes(f.level));
    if (!items.length) continue;
    out.push(`<b>${g.heading}</b>`);
    if (g.heading === 'Looks fine') out.push(items.slice(0, 4).map((f) => esc(f.title)).join('  ·  '));
    else for (const f of items.slice(0, maxProblems)) out.push(findingLine(f, detail));
    out.push('');
  }
  if (out.at(-1) === '') out.pop();
  return out;
}

function appUrl(params: Record<string, string>): string | null {
  if (!config.miniAppUrl) return null;
  const u = new URL(config.miniAppUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

/**
 * The card's words. With an image (`caption`), price and pool are in the picture, so they are left out here.
 * Telegram captions are capped at 1024 characters: the least important lines go first if a caption runs long.
 */
export function cardText(s: Safety, extra: string[] = [], caption = false): string {
  const t = s.token;
  // Under an image the symbol, name, price and verdict are already in the picture: the caption starts with
  // the copyable address and carries only what the picture does not.
  const lines = caption ? [`<code>${t.address}</code>`, ''] : [`<b>${esc(t.symbol)}</b>  ${esc(t.name)}`, `<code>${t.address}</code>`, ''];
  if (!caption && s.priceQms > 0) {
    lines.push(`Price   ${fmtSig(s.priceQms)} QMS  ($${fmtSig(s.priceUsd)})`);
    if (s.liquidityUsd > 0) lines.push(`Pool    $${fmtSig(s.liquidityUsd, 3)}`);
    lines.push('');
  }
  if (!caption) lines.push(s.verdict === 'blocked' ? `<b>Blocked.</b> ${esc(s.reason ?? '')}` : `<b>Safety ${s.score}/100</b>  ${verdictLabel[s.verdict]}`, '');
  const note = `<i>Checked ${ago(s.checkedAt)}. A safety check reduces risk; it cannot guarantee a token is safe.</i>`;
  const build = (detail: boolean, max: number, longNote: boolean) =>
    [...lines, ...findingsBlock(s.findings, detail, max), ...(extra.length ? ['', ...extra] : []), '', longNote ? note : `<i>Checked ${ago(s.checkedAt)}.</i>`].join('\n');
  if (!caption) return build(true, 5, true);
  // Captions are capped at 1024 characters: keep the explanations if they fit, then titles only, then fewer.
  for (const [detail, max, longNote] of [[true, 5, true], [true, 3, true], [false, 5, true], [false, 3, false]] as const) {
    const t = build(detail, max, longNote);
    if (t.length <= 1000) return t;
  }
  return build(false, 3, false).slice(0, 990) + '…';
}

/** The card image: blocked tokens lead with the warning; everything else with the token and its price. */
async function cardImage(s: Safety, link: string): Promise<Buffer> {
  const logo = await tokenLogo(s.token.address);
  if (s.verdict === 'blocked') {
    const h = safetyHeadline(s);
    return safetyCard({ symbol: s.token.symbol, address: s.token.address, logo, verdict: s.verdict, score: s.score, headline: h.headline, reason: h.reason, link });
  }
  return tokenCard({ token: { symbol: s.token.symbol, address: s.token.address, logo }, name: s.token.name, priceQms: s.priceQms, priceUsd: s.priceUsd, liquidityUsd: s.liquidityUsd, verdict: s.verdict, score: s.score, link, flags: cardFlags(s) });
}

/** Parse an amount typed by a person: "0.5", "1,000", ".25". Returns null if it is not a clean number. */
export function parseTyped(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(/,/g, '').replace(/^\./, '0.');
  if (!/^\d{1,18}(\.\d{1,36})?$/.test(t)) return null;
  try {
    const v = parseUnits(t, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** The buy sizes that fit: in the wallet, within the per-trade limit, and not refused by the pool-impact cap. */
export function buySizes(spendable: bigint, perTrade: bigint, qmsReserve: bigint): number[] {
  const fits: number[] = [];
  LADDER.forEach((v, i) => {
    const wei = parseUnits(v, 18);
    // Impact of a constant-product buy is about amount / (reserve + amount); keep under 30% with margin.
    const impactBps = qmsReserve > 0n ? Number((wei * 10_000n) / (qmsReserve + wei)) : 10_000;
    if (wei <= spendable && wei <= perTrade && impactBps < 2_800) fits.push(i);
  });
  return fits.slice(-3);
}

/**
 * Live elapsed timers on pending trades. The final update calls stop(), which waits for any edit in flight, so a
 * timer can never overwrite the result. Ticks every 2 seconds (well inside Telegram's edit limits), up to 3 minutes.
 */
export function createTickers(edit: (tgId: number, msgId: number, html: string) => Promise<unknown>, isPending: (orderId: string) => boolean, everyMs = 2_000) {
  const live = new Map<string, { stopped: boolean; editing: Promise<unknown>; timer: ReturnType<typeof setInterval> }>();
  async function stop(orderId: string) {
    const t = live.get(orderId);
    if (!t) return;
    t.stopped = true;
    clearInterval(t.timer);
    live.delete(orderId);
    await t.editing;
  }
  function start(tgId: number, orderId: string, msgId: number, body: (secs: number) => string) {
    const started = Date.now();
    const t = { stopped: false, editing: Promise.resolve() as Promise<unknown>, timer: undefined as unknown as ReturnType<typeof setInterval> };
    t.timer = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      if (t.stopped || secs > 180 || !isPending(orderId)) return void stop(orderId);
      t.editing = edit(tgId, msgId, body(secs)).catch(() => undefined);
    }, everyMs);
    live.set(orderId, t);
  }
  return { start, stop, size: () => live.size };
}

export function createChat({ bot, db, svc, username }: ChatDeps) {
  /** Waiting for a typed amount after "Custom", per user. */
  const awaiting = new Map<number, { token: Address; side: 'buy' | 'sell'; until: number }>();
  /** A trade that needs a second tap (high risk or high impact), per user. Only the latest counts. */
  const confirming = new Map<number, { token: Address; side: 'buy' | 'sell'; amount: bigint; acceptImpact: boolean; until: number }>();
  const inFlight = new Set<number>();
  const lastPress = new Map<string, number>();
  const lookups = new Map<number, number[]>();

  function rateOk(tgId: number, max = 8, windowMs = 30_000): boolean {
    const now = Date.now();
    const recent = (lookups.get(tgId) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    lookups.set(tgId, recent);
    return recent.length <= max;
  }

  function newCard(tgId: number, token: Address): string {
    const id = randomBytes(6).toString('base64url'); // 8 chars; with "c:" and ":op" well under 64 bytes
    db.putCard(id, tgId, token);
    return id;
  }

  /** Build the private-chat card for a user: text and the buttons they can use right now. */
  async function renderCard(tgId: number, token: Address, fresh = false): Promise<{ text: string; keyboard: Keyboard; image: Buffer; card: string }> {
    // Safety and wallet state are independent reads: fetch them together.
    const [s, ctx] = await Promise.all([checkToken(token, { fresh }), svc.tradeContext(tgId, getAddress(token) as Address).catch(() => null)]);
    const card = newCard(tgId, s.token.address);
    const cb = (op: string) => `c:${card}:${op}`;
    const kb: Keyboard = [];
    const extra: string[] = [];

    if (!ctx) {
      const url = appUrl({});
      if (url) kb.push([{ text: 'Create your wallet to trade', web_app: { url } }]);
      kb.push([{ text: 'Refresh', callback_data: cb('r') }]);
      return { text: cardText(s, [], true), keyboard: kb, image: await cardImage(s, `t.me/${username}`), card };
    }
    if (ctx.balance > 0n) {
      const pool = await poolOf(s.token).catch(() => null);
      const worth = pool ? Number(ctx.balance) / 10 ** s.token.decimals * pool.priceQms : 0;
      extra.push(`You hold <b>${fmtToken(ctx.balance, s.token.decimals)} ${esc(s.token.symbol)}</b>${worth > 0 ? `  (about ${fmtSig(worth)} QMS)` : ''}`);
    }
    if (!ctx.active) {
      extra.push('Trading is turned off for your wallet. Turn it on in your Wallet to trade here.');
      const url = appUrl({ screen: 'control' });
      if (url) kb.push([{ text: 'Open Wallet', web_app: { url } }]);
    } else if (s.tradable && !s.token.verified) {
      if (!ctx.buyAllowed || !ctx.canSell) {
        // One signed approval on the phone covers buying and selling this token.
        extra.push(`To trade ${esc(s.token.symbol)} from chat, approve it once with your PIN. Trading new tokens often? Fast mode skips approvals for every token that passes the check.`);
        const url = appUrl({ approve: s.token.address });
        const fast = appUrl({ screen: 'fast' });
        const row = [url && { text: `Approve ${s.token.symbol}`, web_app: { url } }, fast && { text: 'Fast mode', web_app: { url: fast } }].filter(Boolean);
        if (row.length) kb.push(row as Keyboard[number]);
      } else {
        const pool = await poolOf(s.token).catch(() => null);
        const sizes = pool ? buySizes(ctx.qmsSpendable, ctx.qmsPerTrade, pool.qmsReserve) : [];
        if (sizes.length) kb.push(sizes.map((i) => ({ text: `Buy ${LADDER[i]} QMS`, callback_data: cb(`b${i}`) })));
        else extra.push('Your QMS balance is too low to buy. Get test QMS in your Wallet.');
        kb.push([{ text: 'Buy custom amount', callback_data: cb('bx') }]);
      }
    }
    // Sell buttons whenever the user holds the token and may sell it, even if the token is now blocked.
    if (ctx.active && ctx.balance > 0n && !s.token.verified && ctx.canSell) {
      kb.push(SELL_PCTS.map((p) => ({ text: p === 100 ? 'Sell all' : `Sell ${p}%`, callback_data: cb(`s${p}`) })));
    }
    kb.push([{ text: 'Refresh', callback_data: cb('r') }, { text: 'Share', url: `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${username}?start=t_${s.token.address.slice(2)}`)}` }]);
    return { text: cardText(s, extra, true), keyboard: kb, image: await cardImage(s, `t.me/${username}`), card };
  }

  /** A card for groups and inline results: read-only, links to the private chat to trade. */
  async function publicCard(token: Address): Promise<{ text: string; keyboard: Keyboard }> {
    const s = await checkToken(token);
    return {
      text: cardText(s),
      keyboard: [[{ text: s.tradable ? `Trade ${s.token.symbol} in Qalibre` : 'Open in Qalibre', url: `https://t.me/${username}?start=t_${s.token.address.slice(2)}` }]],
    };
  }

  async function sendCard(tgId: number, token: Address, replyTo?: number) {
    // Telegram shows "sending photo…" while the check runs (about a second); no placeholder message to clean up.
    void bot.call('sendChatAction', { chat_id: tgId, action: 'upload_photo' }).catch(() => null);
    try {
      const c = await renderCard(tgId, token);
      const m = await bot.sendPhoto(tgId, c.image, c.text, {
        reply_markup: { inline_keyboard: c.keyboard },
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      });
      db.setCardMessage(c.card, m.message_id);
    } catch (e) {
      await bot.sendMessage(tgId, esc(e instanceof UserError ? e.message : 'Couldn\'t check that token just now. Try again in a moment.'));
      if (!(e instanceof UserError)) console.error('card', (e as Error).message);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Trading
  // ---------------------------------------------------------------------------------------------

  /**
   * Place a trade from chat and track it in one status message.
   * Buys sell QMS for the token; sells sell the token for QMS. Both use Instant mode: chat traders want speed.
   */
  async function trade(tgId: number, token: TokenInfo, side: 'buy' | 'sell', amount: bigint, opts: { acceptImpact?: boolean; acceptRisk?: boolean } = {}) {
    if (inFlight.has(tgId)) {
      await bot.sendMessage(tgId, 'Still placing your last order. One moment.');
      return;
    }
    inFlight.add(tgId);
    try {
      if (side === 'buy' && !opts.acceptRisk) {
        const s = await checkToken(token.address);
        if (s.verdict === 'high') {
          confirming.set(tgId, { token: token.address, side, amount, acceptImpact: Boolean(opts.acceptImpact), until: Date.now() + 120_000 });
          await bot.sendMessage(tgId, `<b>Careful: ${esc(token.symbol)} scores ${s.score}/100.</b>\n\n${findingsBlock(s.findings.filter((f) => f.level === 'caution' || f.level === 'danger'), true, 3).join('\n')}\n\nStill want to buy it with ${trimUnits(amount, 18)} QMS?`, {
            reply_markup: { inline_keyboard: [[{ text: 'Buy anyway', callback_data: 'y' }, { text: 'Cancel', callback_data: 'n' }]] },
          });
          return;
        }
      }
      const [sellToken, buyToken] = side === 'buy' ? [TOKENS.WQMS, token.address] : [token.address, TOKENS.WQMS];
      const label = side === 'buy' ? `Buying ${esc(token.symbol)} with ${trimUnits(amount, 18)} QMS` : `Selling ${fmtToken(amount, token.decimals)} ${esc(token.symbol)}`;
      let r;
      try {
        r = await svc.placeOrder(tgId, sellToken, buyToken, amount, 'instant', { acceptImpact: opts.acceptImpact });
      } catch (e) {
        if (e instanceof HighImpact) {
          confirming.set(tgId, { token: token.address, side, amount, acceptImpact: true, until: Date.now() + 120_000 });
          await bot.sendMessage(tgId, `<b>This trade moves the price about ${(e.impactBps / 100).toFixed(1)}%.</b>\nThe pool is small, so a trade this size pushes the price against you. You\'re still guaranteed at least what a direct swap would pay.`, {
            reply_markup: { inline_keyboard: [[{ text: side === 'buy' ? 'Buy anyway' : 'Sell anyway', callback_data: 'y' }, { text: 'Cancel', callback_data: 'n' }]] },
          });
          return;
        }
        if (e instanceof NeedsApproval) {
          const url = appUrl({ approve: token.address });
          await bot.sendMessage(tgId, `Approve ${esc(token.symbol)} once with your PIN, then trade it here.`, url ? { reply_markup: { inline_keyboard: [[{ text: `Approve ${token.symbol}`, web_app: { url } }]] } } : {});
          return;
        }
        throw e;
      }
      const buyInfo = side === 'buy' ? token : { symbol: 'QMS', decimals: 18 };
      const floor = `You'll get at least ${fmtToken(r.minOut, buyInfo.decimals)} ${esc(buyInfo.symbol)}, never less than a direct swap.`;
      // A live elapsed timer, not a countdown: QMS block times vary, so a countdown would sometimes lie.
      const body = (secs: number) => [`<b>${label}</b>`, `Sent. Confirming in the next QMS block (${secs}s)`, floor].join('\n');
      const status = (await bot.sendMessage(tgId, body(0))) as { message_id: number };
      db.setStatusMessage(r.id, status.message_id);
      startTicker(tgId, r.id, status.message_id, body);
    } catch (e) {
      await bot.sendMessage(tgId, esc(e instanceof UserError ? e.message : 'Something went wrong on our side placing that order. Nothing was traded, so you can safely try again.'));
      if (!(e instanceof UserError)) console.error('chat trade', (e as Error).message);
    } finally {
      inFlight.delete(tgId);
    }
  }

  async function sellPct(tgId: number, token: TokenInfo, pct: number) {
    // From the on-chain balance at the moment of the press, never a stale card.
    const ctx = await svc.tradeContext(tgId, token.address);
    if (!ctx || ctx.balance === 0n) {
      await bot.sendMessage(tgId, `You don't hold any ${esc(token.symbol)}.`);
      return;
    }
    const amount = pct === 100 ? ctx.balance : (ctx.balance * BigInt(pct)) / 100n;
    await trade(tgId, token, 'sell', amount);
  }

  // ---------------------------------------------------------------------------------------------
  // Order updates: edit the status message in place
  // ---------------------------------------------------------------------------------------------

  const tickers = createTickers((tgId, msgId, html) => bot.editMessage(tgId, msgId, html), (id) => db.getOrder(id)?.status === 'pending');
  const startTicker = tickers.start;
  const stopTicker = tickers.stop;

  /** Returns true when the update was shown by editing a chat status message. */
  async function onOrderUpdate(tgId: number, html: string, orderId: string, kind: string): Promise<boolean> {
    await stopTicker(orderId);
    const o = db.getOrder(orderId);
    if (!o?.status_msg_id) return false;
    const kb: Keyboard = [];
    const tokenAddr = (o.buy_token.toLowerCase() === WQMS ? o.sell_token : o.buy_token) as Address;
    const isChatToken = tokenAddr.toLowerCase() !== WQMS && tokenAddr.toLowerCase() !== TOKENS.USDC.toLowerCase();
    if (isChatToken && kind === 'filled') {
      const card = newCard(tgId, tokenAddr);
      const bought = o.sell_token.toLowerCase() === WQMS; // a buy: offer the exits
      if (bought) kb.push(SELL_PCTS.map((p) => ({ text: p === 100 ? 'Sell all' : `Sell ${p}%`, callback_data: `c:${card}:s${p}` })));
      kb.push([{ text: 'Share', callback_data: `f:${o.id}` }, { text: 'Token card', callback_data: `c:${card}:r` }]);
    } else if (kind === 'filled') {
      kb.push([{ text: 'Share', callback_data: `f:${o.id}` }]);
    }
    try {
      await bot.editMessage(tgId, o.status_msg_id, html, kb.length ? { reply_markup: { inline_keyboard: kb } } : {});
      return true;
    } catch {
      return false; // fall back to a new message
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Commands and messages
  // ---------------------------------------------------------------------------------------------

  async function portfolioMessage(tgId: number) {
    const p = await svc.portfolio(tgId);
    if (!p.registered) {
      const url = appUrl({});
      await bot.sendMessage(tgId, "You don't have a Qalibre wallet yet. It takes about thirty seconds to create one.", url ? { reply_markup: { inline_keyboard: [[{ text: 'Create your wallet', web_app: { url } }]] } } : {});
      return;
    }
    const pos = await svc.positions(tgId);
    const usd = p.price.usdcPerQms;
    const lines = [`<b>Portfolio</b>  $${p.totalUsd.toFixed(2)}`, '']; // totalUsd already includes token positions
    const qms = p.holdings[0]!.amount + p.unwrappedQms;
    lines.push(`<b>QMS</b>  ${fmtSig(qms)}  ·  $${(qms * usd).toFixed(2)}`);
    lines.push(`<b>USDC</b>  ${p.holdings[1]!.amount.toFixed(2)}  ·  $${p.holdings[1]!.valueUsd.toFixed(2)}`);
    const kb: Keyboard = [];
    for (const x of pos) {
      const exit = Number(x.exitQms) / 1e18;
      const pnl = x.pnlPct === null ? 'cost unknown' : `${x.pnlPct >= 0 ? '+' : ''}${x.pnlPct.toFixed(1)}%`;
      lines.push(`<b>${esc(x.token.symbol)}</b>  ${fmtToken(x.balance, x.token.decimals)}  ·  ${fmtSig(exit)} QMS  ·  ${pnl}`);
      const card = newCard(tgId, x.token.address);
      kb.push([
        { text: x.token.symbol, callback_data: `c:${card}:r` },
        ...(x.pnlPct !== null ? [{ text: 'Share', callback_data: `sp:${card}` }] : []),
        { text: 'Sell all', callback_data: `c:${card}:s100` },
      ]);
    }
    if (pos.length) lines.push('', '<i>Token values are what selling all of it would return from the pool right now. Profit counts only tokens bought through Qalibre.</i>');
    else lines.push('', 'Paste a token address to see its card and trade it here.');
    if (p.trades > 0) kb.push([{ text: 'Share my savings', callback_data: 'sv' }]);
    const url = appUrl({});
    if (url) kb.push([{ text: 'Open Qalibre', web_app: { url } }]);
    await bot.sendMessage(tgId, lines.join('\n'), { reply_markup: { inline_keyboard: kb } });
  }

  async function limitsMessage(tgId: number) {
    const p = await svc.portfolio(tgId);
    if (!p.registered) return portfolioMessage(tgId);
    const lines = ['<b>Trading limits</b>', '', p.session.active ? 'Trading is on.' : 'Trading is off.'];
    for (const l of p.limits) lines.push(`${l.symbol}  up to ${fmtSig(l.perTrade)} per trade, ${fmtSig(l.perDay)} a day  (${fmtSig(l.spentToday)} used today)`);
    lines.push('', 'Qalibre can trade only inside these limits, and never withdraw. Only you can change them, with your PIN.');
    const url = appUrl({ screen: 'limits' });
    await bot.sendMessage(tgId, lines.join('\n'), url ? { reply_markup: { inline_keyboard: [[{ text: 'Change limits', web_app: { url } }]] } } : {});
  }

  async function revokeMessage(tgId: number) {
    const url = appUrl({ screen: 'control' });
    await bot.sendMessage(
      tgId,
      ['<b>Turn trading off</b>', '', 'This removes Qalibre\'s trading permission from your wallet at once. Pending orders cannot settle. Your funds stay where they are, and you can withdraw at any time.', '', 'It is signed with your own key, so it opens in the app.'].join('\n'),
      url ? { reply_markup: { inline_keyboard: [[{ text: 'Turn trading off', web_app: { url } }]] } } : {},
    );
  }

  async function lookup(tgId: number, query: string, replyTo?: number) {
    if (!rateOk(tgId)) {
      await bot.sendMessage(tgId, 'That\'s a lot of lookups at once. Give it a few seconds.');
      return;
    }
    const r = await resolveToken(query);
    if (!r.token) {
      await bot.sendMessage(tgId, esc(r.error ?? 'Token not found.'));
      return;
    }
    if (r.token.verified && r.token.address.toLowerCase() === WQMS) {
      await bot.sendMessage(tgId, 'That\'s QMS itself, the coin you trade with. Paste the token you want to buy with it.');
      return;
    }
    await sendCard(tgId, r.token.address, replyTo);
  }

  /** Handle a private-chat text message. Returns false if it is not a chat-trading message. */
  async function onPrivateText(tgId: number, text: string, messageId: number): Promise<boolean> {
    const [first = '', ...rest] = text.trim().split(/\s+/);
    const cmd = first.toLowerCase().replace(/@\w+$/, '');
    const arg = rest.join(' ');

    if (cmd === '/portfolio' || cmd === '/positions') return portfolioMessage(tgId).then(() => true);
    if (cmd === '/limits') return limitsMessage(tgId).then(() => true);
    if (cmd === '/revoke') return revokeMessage(tgId).then(() => true);
    if (cmd === '/buy' || cmd === '/sell') {
      const m = arg.match(/(0x[0-9a-fA-F]{40}|\$?[A-Za-z0-9]{1,12})(?:\s+([\d.,]+%?))?/);
      if (!m) {
        await bot.sendMessage(tgId, cmd === '/buy' ? 'Paste a token address after /buy, for example:\n<code>/buy 0x… 0.1</code>\nor just paste the address on its own.' : 'Use <code>/sell 0x… 50%</code>, or open /portfolio and tap Sell.');
        return true;
      }
      if (!m[2]) return lookup(tgId, m[1]!, messageId).then(() => true);
      const r = await resolveToken(m[1]!);
      if (!r.token) {
        await bot.sendMessage(tgId, esc(r.error ?? 'Token not found.'));
        return true;
      }
      if (cmd === '/sell' && m[2].endsWith('%')) {
        const pct = Number(m[2].slice(0, -1));
        if (!(pct > 0 && pct <= 100)) {
          await bot.sendMessage(tgId, 'Use a percentage between 1 and 100.');
          return true;
        }
        await sellPct(tgId, r.token, Math.round(pct));
        return true;
      }
      const amount = parseTyped(m[2], cmd === '/buy' ? 18 : r.token.decimals);
      if (amount === null) {
        await bot.sendMessage(tgId, 'I couldn\'t read that amount. Try something like 0.2.');
        return true;
      }
      await trade(tgId, r.token, cmd === '/buy' ? 'buy' : 'sell', amount);
      return true;
    }
    if (cmd.startsWith('/')) return false;

    // A typed amount after "Custom".
    const wait = awaiting.get(tgId);
    if (wait && Date.now() < wait.until) {
      const info = await resolveToken(wait.token);
      const amount = info.token ? parseTyped(text, wait.side === 'buy' ? 18 : info.token.decimals) : null;
      if (amount !== null && info.token) {
        awaiting.delete(tgId);
        await trade(tgId, info.token, wait.side, amount);
        return true;
      }
    }
    // A pasted address anywhere in the message, or a $TICKER.
    const addr = text.match(/0x[0-9a-fA-F]{40}/);
    if (addr) return lookup(tgId, addr[0], messageId).then(() => true);
    const ticker = text.trim().match(/^\$([A-Za-z0-9]{1,12})$/);
    if (ticker) return lookup(tgId, ticker[1]!, messageId).then(() => true);
    return false;
  }

  /** Deep link from a group or inline card: /start t_<address without 0x>. */
  async function onStartPayload(tgId: number, payload: string): Promise<boolean> {
    const m = payload.match(/^t_([0-9a-fA-F]{40})$/);
    if (!m) return false;
    await lookup(tgId, '0x' + m[1]);
    return true;
  }

  async function onInlineQuery(q: { id: string; from: { id: number }; query: string }) {
    const addr = q.query.match(/0x[0-9a-fA-F]{40}/);
    const results: unknown[] = [];
    if (addr && rateOk(q.from.id)) {
      try {
        const token = getAddress(addr[0]) as Address;
        const s = await checkToken(token);
        const c = await publicCard(token);
        results.push({
          type: 'article',
          id: token.toLowerCase().slice(2, 34),
          title: `${s.token.symbol}  ${s.verdict === 'blocked' ? 'Blocked' : `Safety ${s.score}/100`}`,
          description: s.verdict === 'blocked' ? s.reason : `${verdictLabel[s.verdict]}. Price ${fmtSig(s.priceQms)} QMS`,
          input_message_content: { message_text: c.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
          reply_markup: { inline_keyboard: c.keyboard },
        });
      } catch {
        /* not a token: no result */
      }
    }
    await bot
      .call('answerInlineQuery', {
        inline_query_id: q.id,
        results,
        cache_time: 60,
        is_personal: false,
        button: { text: 'Paste a token address to check it', start_parameter: 'inline' },
      })
      .catch((e) => console.error('inline', (e as Error).message));
  }

  async function onCallback(q: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type: string } } }) {
    const tgId = q.from.id;
    const data = q.data ?? '';
    if (q.message?.chat.type !== 'private') return bot.answer(q.id, 'Trades happen only in your private chat with Qalibre.', true);
    // Repeated presses of the same button within 5 seconds are ignored.
    const key = `${tgId}:${data}`;
    const last = lastPress.get(key) ?? 0;
    if (Date.now() - last < 5_000) return bot.answer(q.id, 'Already on it.');
    lastPress.set(key, Date.now());
    if (lastPress.size > 5_000) for (const [k, t] of lastPress) if (Date.now() - t > 60_000) lastPress.delete(k);

    if (data === 'y' || data === 'n') {
      const c = confirming.get(tgId);
      confirming.delete(tgId);
      if (data === 'n' || !c || Date.now() > c.until) {
        await bot.answer(q.id, data === 'n' ? 'Cancelled.' : 'That confirmation expired. Tap the button again.');
        if (q.message) await bot.editMessage(tgId, q.message.message_id, data === 'n' ? 'Cancelled. Nothing was traded.' : 'Expired. Nothing was traded.');
        return;
      }
      await bot.answer(q.id, 'Placing your order');
      if (q.message) await bot.call('editMessageReplyMarkup', { chat_id: tgId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => null);
      const info = await resolveToken(c.token);
      if (info.token) await trade(tgId, info.token, c.side, c.amount, { acceptImpact: c.acceptImpact, acceptRisk: true });
      return;
    }

    const m = data.match(/^c:([A-Za-z0-9_-]{8}):(b\d|bx|s25|s50|s100|r)$/);
    const card = m ? db.getCard(m[1]!) : undefined;
    if (!m || !card || card.tg_id !== tgId) return bot.answer(q.id, 'This card is out of date. Paste the token address again for a fresh one.', true);
    const op = m[2]!;
    const token = card.token as Address;

    if (op === 'r') {
      await bot.answer(q.id, 'Re-checking');
      if (!q.message) return;
      try {
        const c = await renderCard(tgId, token, true);
        // Refresh the card in place. A text message (an order status, or a card from before images) cannot
        // become a photo, so then the fresh card is sent as a new message.
        const msgId = await bot
          .editPhoto(tgId, q.message.message_id, c.image, c.text, { inline_keyboard: c.keyboard })
          .then(() => q.message!.message_id)
          .catch(async () => (await bot.sendPhoto(tgId, c.image, c.text, { reply_markup: { inline_keyboard: c.keyboard } })).message_id);
        db.setCardMessage(c.card, msgId);
      } catch (e) {
        await bot.sendMessage(tgId, esc(e instanceof UserError ? e.message : 'Couldn\'t refresh this token just now. Try again in a moment.'));
      }
      return;
    }
    const info = await resolveToken(token);
    if (!info.token) return bot.answer(q.id, 'That token can no longer be read.', true);

    if (op === 'bx') {
      const side = 'buy' as const;
      awaiting.set(tgId, { token, side, until: Date.now() + 120_000 });
      await bot.answer(q.id);
      await bot.sendMessage(tgId, `How much QMS would you like to spend on ${esc(info.token.symbol)}? Type an amount, like <code>0.2</code>.`, { reply_markup: { force_reply: true, input_field_placeholder: 'Amount in QMS' } });
      return;
    }
    if (op.startsWith('b')) {
      const i = Number(op.slice(1));
      const v = LADDER[i];
      if (v === undefined) return bot.answer(q.id);
      await bot.answer(q.id, `Buying with ${v} QMS`);
      await trade(tgId, info.token, 'buy', parseUnits(v, 18));
      return;
    }
    const pct = Number(op.slice(1));
    await bot.answer(q.id, pct === 100 ? 'Selling all' : `Selling ${pct}%`);
    await sellPct(tgId, info.token, pct);
  }

  /**
   * A token was approved in the app: redraw its latest card in the chat so Buy buttons appear by themselves,
   * and say so in one line. If the card can no longer be edited, send a fresh one.
   */
  async function afterApproval(tgId: number, tokens: Address[]) {
    for (const token of tokens) {
      const c = await renderCard(tgId, token, false);
      const last = db.lastCardMessage(tgId, token);
      let msgId: number | undefined;
      if (last) msgId = await bot.editPhoto(tgId, last, c.image, c.text, { inline_keyboard: c.keyboard }).then(() => last).catch(() => undefined);
      if (!msgId) msgId = (await bot.sendPhoto(tgId, c.image, c.text, { reply_markup: { inline_keyboard: c.keyboard } })).message_id;
      db.setCardMessage(c.card, msgId);
      const info = await resolveToken(token);
      await bot.sendMessage(tgId, `<b>${esc(info.token?.symbol ?? 'Token')} is approved.</b> The card above now has Buy buttons.`, { reply_parameters: { message_id: msgId, allow_sending_without_reply: true } });
    }
  }

  return { afterApproval, onPrivateText, onStartPayload, onInlineQuery, onCallback, onOrderUpdate, renderCard, publicCard };
}

export type Chat = ReturnType<typeof createChat>;
