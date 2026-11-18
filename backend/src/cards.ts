/**
 * Shareable image cards: trade fills, positions, savings and safety alerts.
 *
 * Built from the brand itself (brand/qalibre-app-icon.svg): a deep green field, paper type, and brass used only
 * for the ring of the q. Good news sits on green; warnings sit on ink. One statement per card, set large; the
 * monogram ghosted across the right edge gives presence without decoration. No labels in caps, no stat grids.
 * Rendered server-side from SVG to PNG with bundled fonts, so every card is identical on every device.
 * 1200x675 (16:9) shows uncropped in Telegram and on X.
 */
import { join } from 'node:path';
import { Resvg, renderAsync } from '@resvg/resvg-js';
import { ROOT } from './config.js';
import { emblem } from './logos.js';
import type { Safety } from './tokens.js';

const W = 1200;
const H = 675;
const L = 96; // left edge of the text column
const FONTS = ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'Inter-Bold'].map((f) => join(ROOT, 'backend', 'assets', 'fonts', `${f}.ttf`));

const C = {
  green: '#0F4D3A',
  ink: '#111214',
  paper: '#F6F4EF',
  brass: '#B08D57',
  alarm: '#E5745F', // the one warm signal used on ink, for the verdict word only
};

/** Severity markers: one coloured dot per level, readable on both the green and the ink field. */
export type FlagLevel = 'danger' | 'caution' | 'pass';
const FLAG_DOT: Record<FlagLevel, string> = { danger: '#E5745F', caution: '#E2B866', pass: '#8FD4AE' };
export interface Flag { level: FlagLevel; text: string }

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Font size that fits `text` in `width`. Inter SemiBold averages ~0.56em per figure/letter at tight tracking. */
function fit(text: string, width: number, max: number, min = 56): number {
  return Math.max(min, Math.min(max, Math.floor(width / Math.max(1, text.length * 0.56))));
}

/** The wordmark with the brass ring over the i, `h` px tall. */
function wordmark(tx: number, ty: number, h: number, ink: string, hole: string): string {
  const s = h / 82;
  return `<g transform="translate(${tx} ${ty}) scale(${s})">
    <g fill="none" stroke="${ink}" stroke-width="8"><circle cx="24" cy="40" r="16"/><path d="M40 24 V78"/><circle cx="73" cy="40" r="16"/><path d="M89 24 V60"/><path d="M106 4 V60"/><path d="M123 24 V60"/><path d="M140 4 V60"/><circle cx="156" cy="40" r="16"/><path d="M189 24 V60 M189 42 A16 16 0 0 1 205 26"/><path d="M215 40 H247 M247 40 A16 16 0 1 0 242.3 51.3"/></g>
    <circle cx="123" cy="10" r="5.6" fill="${C.brass}"/><circle cx="123" cy="10" r="1.9" fill="${hole}"/></g>`;
}

interface Card {
  field: 'green' | 'ink';
  /** Small line above the statement, in paper at reduced strength. */
  over: string;
  /** The one statement. */
  hero: string;
  /** Optional smaller unit set after the hero (a token symbol). */
  unit?: string;
  /** Colour of the hero: paper; brass for a caution verdict; the alarm tone only for a blocked token. */
  heroTone?: 'paper' | 'brass' | 'alarm';
  /** One sentence under the statement. */
  line: string;
  /** Colour of that sentence: paper by default; brass or alarm when it carries a safety verdict. */
  lineTone?: 'paper' | 'brass' | 'alarm' | 'gain';
  /** Optional quiet detail under the sentence (amounts, an address). */
  detail?: string;
  /** The token the card is about: shown as a header with its logo (or designed badge), symbol and context. */
  token?: TokenMark;
  /** Who shared it: their Telegram photo and first name, in the footer. Only on cards a person shares. */
  person?: Person;
  /** Up to three safety findings, as pills with a severity dot, under the detail line. */
  flags?: Flag[];
}

/** A row of pills: dot + short label. Stops before the big q so nothing collides. */
function flagRow(flags: Flag[], x0: number, y: number): string {
  let cx = x0;
  const out: string[] = [];
  for (const f of flags.slice(0, 3)) {
    const label = f.text.length > 30 ? f.text.slice(0, 29) + '…' : f.text;
    const w = Math.round(label.length * 10.3 + 62);
    if (cx + w > x0 + 700) break;
    out.push(`<g><rect x="${cx}" y="${y}" width="${w}" height="44" rx="22" fill="${C.paper}" fill-opacity="0.08" stroke="${C.paper}" stroke-opacity="0.16"/>
    <circle cx="${cx + 24}" cy="${y + 22}" r="7" fill="${FLAG_DOT[f.level]}"/>
    <text x="${cx + 40}" y="${y + 29}" font-family="Inter" font-weight="500" font-size="20" fill="${C.paper}" fill-opacity="0.92">${x(label)}</text></g>`);
    cx += w + 10;
  }
  return out.join('\n  ');
}

/** The person sharing a card. `photo` is a data URI of their Telegram photo, or null for their initial. */
export interface Person {
  name: string;
  photo: string | null;
}

/** The sharer in the footer: photo (or initial on paper), first name, and a quiet "on Qalibre". */
function personMark(p: Person, x0: number, cy: number, bg: string): string {
  const r = 31;
  const cx = x0 + r;
  const ring = `<circle cx="${cx}" cy="${cy}" r="${r - 0.75}" fill="none" stroke="${C.paper}" stroke-opacity="0.3" stroke-width="1.5"/>`;
  const name = p.name.length > 18 ? p.name.slice(0, 17) + '…' : p.name;
  const face = p.photo
    ? `<clipPath id="pf"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath><image href="${p.photo}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" preserveAspectRatio="xMidYMid slice" clip-path="url(#pf)"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.paper}"/><text x="${cx}" y="${cy + 8}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="26" fill="${bg}">${x(name.slice(0, 1).toUpperCase())}</text>`;
  return `${face}${ring}
  <text x="${x0 + 2 * r + 16}" y="${cy - 3}" font-family="Inter" font-weight="600" font-size="24" fill="${C.paper}">${x(name)}</text>
  <text x="${x0 + 2 * r + 16}" y="${cy + 22}" font-family="Inter" font-weight="500" font-size="17" fill="${C.paper}" fill-opacity="0.6">on Qalibre</text>`;
}

/** A token's identity on a card. `logo` is a data URI of a real logo, or null for the designed badge. */
export interface TokenMark {
  symbol: string;
  address: string;
  logo: string | null;
}

/** The token's logo cut to a circle, or its generated emblem. Hairline ring either way. */
function tokenBadge(t: TokenMark, cx: number, cy: number, r: number): string {
  const ring = `<circle cx="${cx}" cy="${cy}" r="${r - 0.75}" fill="none" stroke="${C.paper}" stroke-opacity="0.22" stroke-width="1.5"/>`;
  if (t.logo) {
    const id = `tk${t.address.slice(2, 10)}`;
    return `<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.paper}"/>
      <image href="${t.logo}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>${ring}`;
  }
  // No published logo: the token's own emblem, clipped to the circle.
  const id = `em${t.address.slice(2, 10)}`;
  return `<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
    <g clip-path="url(#${id})">${emblem(t.address, cx, cy, r)}</g>${ring}`;
}

/**
 * Escape text and typeset subscript digits (from fmtPrice) as real small numerals: 45% size, lowered a little,
 * then back to the baseline. The font's own subscript glyphs are too heavy at display sizes.
 */
function typeset(text: string, size: number): string {
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  const parts = text.split(/([₀-₉]+)/).filter(Boolean);
  if (parts.length === 1 && !SUB.includes(parts[0]![0]!)) return x(text);
  const drop = Math.round(size * 0.1);
  return parts
    .map((part) =>
      SUB.includes(part[0]!)
        ? `<tspan font-size="${Math.round(size * (size < 40 ? 0.62 : 0.45))}" dy="${drop}" dx="${Math.round(size * 0.02)}">${[...part].map((ch) => SUB.indexOf(ch)).join('')}</tspan><tspan dy="${-drop}" dx="${Math.round(size * 0.03)}"></tspan>`
        : `<tspan>${x(part)}</tspan>`,
    )
    .join('');
}

function svg(c: Card, link: string): string {
  const bg = c.field === 'green' ? C.green : C.ink;
  const heroSize = fit(c.hero + (c.unit ? '   ' + c.unit.slice(0, Math.ceil(c.unit.length * 0.45)) : ''), 670, 172);
  // The text block is centred on the card's optical middle (slightly above true centre, footer below).
  const cap = Math.round(heroSize * 0.73);
  // With a token, the header is its badge (64px) beside the symbol and the context; otherwise one quiet line.
  const headH = c.token ? 64 : 26;
  const block = headH + 44 + cap + 72 + (c.detail ? 46 : 0) + (c.flags?.length ? 70 : 0);
  const top = Math.round(300 - block / 2) + (c.token ? 0 : 0);
  const overY = top + (c.token ? 0 : 26);
  const heroY = top + headH + 44 + cap;
  const lineY = heroY + 72;
  const unit = c.unit ? `<tspan dx="${Math.round(heroSize * 0.16)}" font-weight="500" font-size="${Math.round(heroSize * 0.38)}" letter-spacing="0" fill-opacity="0.62">${x(c.unit)}</tspan>` : '';
  // The full q, large on the right: paper strokes held back, the brass ring at full strength as the one accent.
  const qh = 560;
  const qs = qh / 64;
  const qx = 806;
  const qy = 6;
  const bigQ = `<g transform="translate(${qx} ${qy}) scale(${qs})">
    <g fill="none" stroke="${C.paper}" stroke-width="8" opacity="0.07"><circle cx="20" cy="22" r="16"/><path d="M36 6 V54"/></g>
    <circle cx="36" cy="58" r="5.6" fill="${C.brass}"/><circle cx="36" cy="58" r="1.9" fill="${bg}"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  ${bigQ}
  ${c.token
    ? `${tokenBadge(c.token, L + 32, top + 32, 32)}
  <text x="${L + 84}" y="${top + 28}" font-family="Inter" font-weight="600" font-size="28" letter-spacing="-0.4" fill="${C.paper}">${x(c.token.symbol)}</text>
  <text x="${L + 84}" y="${top + 58}" font-family="Inter" font-weight="500" font-size="20" fill="${C.paper}" fill-opacity="0.6">${x(c.over)}</text>`
    : `<text x="${L}" y="${overY}" font-family="Inter" font-weight="500" font-size="26" fill="${C.paper}" fill-opacity="0.62">${x(c.over)}</text>`}
  <text x="${L - Math.round(heroSize * 0.05)}" y="${heroY}" font-family="Inter" font-weight="600" font-size="${heroSize}" letter-spacing="${(-heroSize * 0.045).toFixed(1)}" fill="${c.heroTone === 'alarm' ? C.alarm : c.heroTone === 'brass' ? C.brass : C.paper}">${typeset(c.hero, heroSize)}${unit}</text>
  <text x="${L}" y="${lineY}" font-family="Inter" font-weight="500" font-size="32" letter-spacing="-0.3" fill="${c.lineTone === 'alarm' ? C.alarm : c.lineTone === 'brass' ? C.brass : c.lineTone === 'gain' ? FLAG_DOT.pass : C.paper}" fill-opacity="${c.lineTone && c.lineTone !== 'paper' ? 1 : 0.92}">${x(c.line)}</text>
  ${c.detail ? `<text x="${L}" y="${lineY + 46}" font-family="Inter" font-weight="400" font-size="22" fill="${C.paper}" fill-opacity="0.5">${typeset(c.detail, 22)}</text>` : ''}
  ${c.flags?.length ? flagRow(c.flags, L, lineY + (c.detail ? 46 : 0) + 30) : ''}
  ${c.person ? personMark(c.person, L, H - 88, bg) : wordmark(L, H - 96, 30, C.paper, bg)}
  <text x="${W - L}" y="${H - 70}" text-anchor="end" font-family="Inter" font-weight="500" font-size="20" fill="${C.paper}" fill-opacity="0.6">${x(link)}</text>
</svg>`;
}

/** Draw on a background thread, so cards sent on every trade never hold up the trading engine. */
async function renderOff(doc: string): Promise<Buffer> {
  const img = await renderAsync(doc, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: W } });
  return Buffer.from(img.asPng());
}

function render(c: Card, link: string): Buffer {
  const r = new Resvg(svg(c, link), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: W } });
  return Buffer.from(r.render().asPng());
}

// ---------------------------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------------------------

/**
 * The receipt for every completed trade, sent in the chat the moment it settles. What you got is the hero; the
 * proof sits beneath it as pills: the price floor held, and how long it took. Sells also show the profit or loss
 * on the tokens sold, in green or the warm alarm tone, on the green or ink field.
 */
export function receiptCard(p: {
  side: 'Bought' | 'Sold';
  got: string;
  gotSymbol: string;
  paid: string;
  paidSymbol: string;
  token: TokenMark;
  vsDirectPct: number;
  settledSecs: number | null;
  pnlPct: number | null;
  tx: string;
  person?: Person;
  link: string;
}): Promise<Buffer> {
  const loss = p.pnlPct !== null && p.pnlPct < 0;
  const flags: Flag[] = [
    { level: 'pass', text: p.vsDirectPct > 0.0005 ? `Beat direct swap by ${p.vsDirectPct.toFixed(2)}%` : 'At the direct swap price' },
  ];
  if (p.settledSecs !== null && p.settledSecs > 0) flags.push({ level: 'pass', text: `Settled in ${p.settledSecs}s` });
  const pnl = p.pnlPct === null ? null : `${p.pnlPct >= 0 ? '+' : '−'}${Math.abs(p.pnlPct).toFixed(1)}% on this position`;
  return renderOff(
    svg(
    {
      field: loss ? 'ink' : 'green',
      token: p.token,
      over: `${p.side} on QMS`,
      hero: `+${p.got}`,
      unit: p.gotSymbol,
      line: pnl ?? `for ${p.paid} ${p.paidSymbol}`,
      lineTone: pnl ? (loss ? 'alarm' : 'gain') : 'paper',
      person: p.person,
      detail: pnl ? `for ${p.paid} ${p.paidSymbol}, tx ${p.tx.slice(0, 6)}…${p.tx.slice(-4)}` : `tx ${p.tx.slice(0, 6)}…${p.tx.slice(-4)}`,
      flags,
    },
    p.link,
  ));
}

/**
 * A trade. When Qalibre beat the direct swap, the improvement is the story; otherwise the amount received is,
 * with the honest note that it was the direct price.
 */
export function fillCard(p: { side: 'Bought' | 'Sold'; got: string; gotSymbol: string; paid: string; paidSymbol: string; vsDirectPct: number; token: TokenMark; person?: Person; link: string }): Buffer {
  const better = p.vsDirectPct > 0.0005;
  const over = `${p.side} on QMS`;
  return render(
    better
      ? { field: 'green', token: p.token, person: p.person, over, hero: `+${p.vsDirectPct.toFixed(2)}%`, line: 'better than a direct swap on QWAP', detail: `${p.got} ${p.gotSymbol} for ${p.paid} ${p.paidSymbol}` }
      : { field: 'green', token: p.token, person: p.person, over, hero: `+${p.got}`, line: `${p.gotSymbol} for ${p.paid} ${p.paidSymbol}`, detail: 'At the direct price. Never worse than a direct swap.' },
    p.link,
  );
}

export function positionCard(p: { symbol: string; pnlPct: number; held: string; cost: string; value: string; token: TokenMark; person?: Person; link: string }): Buffer {
  const up = p.pnlPct >= 0;
  return render(
    { field: up ? 'green' : 'ink', token: p.token, person: p.person, over: 'Position on QMS', hero: `${up ? '+' : '−'}${Math.abs(p.pnlPct).toFixed(1)}%`, line: `${p.cost} QMS in, ${p.value} QMS if sold now`, detail: `${p.held} ${p.symbol} held` },
    p.link,
  );
}

export function savingsCard(p: { savedUsd: string; trades: number; since: string; person?: Person; link: string }): Buffer {
  return render(
    { field: 'green', person: p.person, over: 'Saved with Qalibre', hero: `$${p.savedUsd}`, line: 'compared with swapping directly', detail: `${p.trades} ${p.trades === 1 ? 'trade' : 'trades'} since ${p.since}` },
    p.link,
  );
}

export interface SafetyFacts {
  symbol: string;
  address: string;
  verdict: 'blocked' | 'high' | 'caution' | 'ok';
  score: number;
  headline: string;
  reason: string;
}

/** Warnings on ink with the verdict in the one warm tone; a clean result on green. */
export function safetyCard(p: SafetyFacts & { logo: string | null; link: string }): Buffer {
  const warn = p.verdict === 'blocked' || p.verdict === 'high';
  const short = `${p.address.slice(0, 6)}…${p.address.slice(-4)}`;
  return render(
    {
      field: warn ? 'ink' : 'green',
      token: { symbol: p.symbol, address: p.address, logo: p.logo },
      over: p.verdict === 'blocked' ? 'Blocked by Qalibre' : `Safety ${p.score}/100`,
      hero: `${p.headline}.`,
      heroTone: p.verdict === 'blocked' ? 'alarm' : p.verdict === 'high' ? 'brass' : 'paper',
      line: p.reason,
      detail: `${short}, checked with a simulated buy and sale`,
    },
    p.link,
  );
}

/**
 * A price the way trading apps write tiny numbers: 0.0₆1635 means six zeros after the point, then 1635.
 * Four significant digits; ordinary numbers stay ordinary.
 */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const zeros = Math.floor(-Math.log10(n)); // 0.000123 -> 3 leading zeros after the point
  if (zeros < 4) return n.toFixed(zeros + 4).replace(/0+$/, '');
  const digits = Math.round(n * 10 ** (zeros + 4)).toString().replace(/0+$/, '');
  const sub = String(zeros).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]).join('');
  return `0.0${sub}${digits}`;
}

/** The chat token card: the token, its price and pool, and its safety verdict in colour. */
export function tokenCard(p: { token: TokenMark; name: string; priceQms: number; priceUsd: number; liquidityUsd: number; verdict: 'high' | 'caution' | 'ok'; score: number; link: string; flags?: Flag[] }): Buffer {
  const label = p.verdict === 'high' ? 'High risk' : p.verdict === 'caution' ? 'Some risk' : 'Low risk';
  const short = `${p.token.address.slice(0, 6)}…${p.token.address.slice(-4)}`;
  return render(
    {
      field: p.verdict === 'high' ? 'ink' : 'green',
      token: p.token,
      over: p.name,
      hero: fmtPrice(p.priceQms),
      unit: 'QMS',
      line: `Safety ${p.score}/100. ${label}.`,
      lineTone: p.verdict === 'high' ? 'brass' : 'paper',
      detail: `$${fmtPrice(p.priceUsd)} each, pool $${p.liquidityUsd >= 100 ? Math.round(p.liquidityUsd).toLocaleString('en-US') : p.liquidityUsd.toFixed(2)}, ${short}`,
      flags: p.flags,
    },
    p.link,
  );
}

/** What a card shows from a safety check: problems first, most serious first; a clean token shows what passed. */
export function cardFlags(s: Safety): Flag[] {
  const problems = [...s.findings.filter((f) => f.level === 'danger'), ...s.findings.filter((f) => f.level === 'caution')];
  if (problems.length) return problems.slice(0, 3).map((f) => ({ level: f.level as FlagLevel, text: f.title }));
  return s.findings.filter((f) => f.level === 'pass').slice(0, 3).map((f) => ({ level: 'pass', text: f.title }));
}

/** The verdict of a safety check in card words: a short headline and one sentence. */
export function safetyHeadline(s: Safety): { headline: string; reason: string } {
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

/** The invite card: what a friend's invite earns, with the inviter's own link in the corner. */
export function inviteCard(p: { sharePct: number; days: number; person?: Person; link: string }): Buffer {
  return render(
    { field: 'green', person: p.person, over: p.person ? `${p.person.name} invites you to Qalibre` : 'Invite friends to Qalibre', hero: `${p.sharePct}%`, line: 'of Qalibre’s fee on your friends’ trades', detail: `For ${p.days} days. Your friends pay exactly the same.` },
    p.link,
  );
}

/**
 * Public numbers. Scams blocked leads: it is true from the first day. Savings appear only once there are some,
 * so the card never shows a zero as if it were an achievement.
 */
export function statsCard(p: { checked: number; blocked: number; trades: number; traders: number; savedUsd: number; link: string }): Buffer {
  const saved = p.savedUsd >= 0.01 ? `$${p.savedUsd >= 100 ? Math.round(p.savedUsd).toLocaleString('en-US') : p.savedUsd.toFixed(2)} saved versus swapping directly` : 'Every trade at or above the direct swap price';
  return render(
    {
      field: 'green',
      over: 'Qalibre on QMS, so far',
      hero: p.blocked.toLocaleString('en-US'),
      unit: p.blocked === 1 ? 'scam blocked' : 'scams blocked',
      line: `${p.checked.toLocaleString('en-US')} ${p.checked === 1 ? 'token' : 'tokens'} checked, ${p.trades.toLocaleString('en-US')} ${p.trades === 1 ? 'trade' : 'trades'} settled`,
      detail: saved,
    },
    p.link,
  );
}

/** One row of the portfolio table. Value in USD; change is profit on tokens bought through Qalibre, or null. */
export interface PortfolioRow {
  token: TokenMark;
  amount: string;
  valueUsd: number;
  changePct: number | null;
}

const money = (v: number) => (v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`);

/**
 * The wallet at a glance: the total as the hero, then a quiet table, one row per holding, aligned in two
 * columns (what you hold on the left, what it is worth on the right). Six rows at most; the rest fold into a
 * single line. The card grows in height with the rows so nothing is ever squeezed.
 */
export function portfolioCard(p: { totalUsd: number; changeUsd: number | null; rows: PortfolioRow[]; more: number; person?: Person; link: string }): Promise<Buffer> {
  const rows = p.rows.slice(0, 6);
  const rowH = 92;
  const tableTop = 330;
  const moreH = p.more > 0 ? 56 : 0;
  const h = Math.max(H, tableTop + rows.length * rowH + moreH + 150);
  const R = W - L;
  const bg = C.green;
  const [whole, cents] = p.totalUsd.toFixed(2).split('.');
  const wholeFmt = Number(whole).toLocaleString('en-US');
  const change =
    p.changeUsd === null || Math.abs(p.changeUsd) < 0.005
      ? ''
      : `<text x="${L}" y="252" font-family="Inter" font-weight="500" font-size="26" fill="${p.changeUsd >= 0 ? FLAG_DOT.pass : C.alarm}">${p.changeUsd >= 0 ? '+' : '\u2212'}${money(Math.abs(p.changeUsd))} on tokens bought with Qalibre</text>`;
  const body = rows
    .map((r, i) => {
      const y = tableTop + i * rowH;
      const cy = y + rowH / 2;
      const sym = r.token.symbol.length > 14 ? r.token.symbol.slice(0, 13) + '…' : r.token.symbol;
      const pct =
        r.changePct === null
          ? ''
          : `<text x="${R}" y="${cy + 26}" text-anchor="end" font-family="Inter" font-weight="500" font-size="20" fill="${r.changePct >= 0 ? FLAG_DOT.pass : C.alarm}">${r.changePct >= 0 ? '+' : '\u2212'}${Math.abs(r.changePct).toFixed(1)}%</text>`;
      return `${i > 0 ? `<rect x="${L}" y="${y}" width="${R - L}" height="1" fill="${C.paper}" fill-opacity="0.1"/>` : ''}
  ${tokenBadge(r.token, L + 28, cy, 28)}
  <text x="${L + 76}" y="${cy - 4}" font-family="Inter" font-weight="600" font-size="26" letter-spacing="-0.3" fill="${C.paper}">${x(sym)}</text>
  <text x="${L + 76}" y="${cy + 26}" font-family="Inter" font-weight="400" font-size="20" fill="${C.paper}" fill-opacity="0.55">${x(r.amount)}</text>
  <text x="${R}" y="${r.changePct === null ? cy + 9 : cy - 4}" text-anchor="end" font-family="Inter" font-weight="600" font-size="26" letter-spacing="-0.3" fill="${C.paper}">${money(r.valueUsd)}</text>
  ${pct}`;
    })
    .join('\n  ');
  const more = p.more > 0 ? `<text x="${L}" y="${tableTop + rows.length * rowH + 40}" font-family="Inter" font-weight="500" font-size="20" fill="${C.paper}" fill-opacity="0.55">and ${p.more} more ${p.more === 1 ? 'holding' : 'holdings'} in the app</text>` : '';
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">
  <rect width="${W}" height="${h}" fill="${bg}"/>
  ${p.person ? wordmark(R - 92, 84, 30, C.paper, bg) : `<g transform="translate(${W - 150} 72) scale(1.6)"><circle cx="36" cy="22" r="22" fill="none" stroke="${C.brass}" stroke-width="12"/></g>`}
  <text x="${L}" y="110" font-family="Inter" font-weight="500" font-size="26" fill="${C.paper}" fill-opacity="0.62">Portfolio</text>
  <text x="${L - 5}" y="206" font-family="Inter" font-weight="600" font-size="104" letter-spacing="-4.5" fill="${C.paper}">$${wholeFmt}<tspan fill-opacity="0.5">.${cents}</tspan></text>
  ${change}
  <rect x="${L}" y="${tableTop - 22}" width="${R - L}" height="1" fill="${C.paper}" fill-opacity="0.18"/>
  ${body}
  ${more}
  ${p.person ? personMark(p.person, L, h - 88, bg) : wordmark(L, h - 96, 30, C.paper, bg)}
  <text x="${R}" y="${h - 70}" text-anchor="end" font-family="Inter" font-weight="500" font-size="20" fill="${C.paper}" fill-opacity="0.6">${x(p.link)}</text>
</svg>`;
  return renderOff(doc);
}
