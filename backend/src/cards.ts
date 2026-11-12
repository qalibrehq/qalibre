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
import { Resvg } from '@resvg/resvg-js';
import { ROOT } from './config.js';
import { emblem } from './logos.js';

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
  /** Optional quiet detail under the sentence (amounts, an address). */
  detail?: string;
  /** The token the card is about: shown as a header with its logo (or designed badge), symbol and context. */
  token?: TokenMark;
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

function svg(c: Card, link: string): string {
  const bg = c.field === 'green' ? C.green : C.ink;
  const heroSize = fit(c.hero + (c.unit ? '   ' + c.unit.slice(0, Math.ceil(c.unit.length * 0.45)) : ''), 670, 172);
  // The text block is centred on the card's optical middle (slightly above true centre, footer below).
  const cap = Math.round(heroSize * 0.73);
  // With a token, the header is its badge (64px) beside the symbol and the context; otherwise one quiet line.
  const headH = c.token ? 64 : 26;
  const block = headH + 44 + cap + 72 + (c.detail ? 46 : 0);
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
  <text x="${L - Math.round(heroSize * 0.05)}" y="${heroY}" font-family="Inter" font-weight="600" font-size="${heroSize}" letter-spacing="${(-heroSize * 0.045).toFixed(1)}" fill="${c.heroTone === 'alarm' ? C.alarm : c.heroTone === 'brass' ? C.brass : C.paper}">${x(c.hero)}${unit}</text>
  <text x="${L}" y="${lineY}" font-family="Inter" font-weight="500" font-size="32" letter-spacing="-0.3" fill="${C.paper}" fill-opacity="0.92">${x(c.line)}</text>
  ${c.detail ? `<text x="${L}" y="${lineY + 46}" font-family="Inter" font-weight="400" font-size="22" fill="${C.paper}" fill-opacity="0.5">${x(c.detail)}</text>` : ''}
  ${wordmark(L, H - 96, 30, C.paper, bg)}
  <text x="${W - L}" y="${H - 70}" text-anchor="end" font-family="Inter" font-weight="500" font-size="20" fill="${C.paper}" fill-opacity="0.6">${x(link)}</text>
</svg>`;
}

function render(c: Card, link: string): Buffer {
  const r = new Resvg(svg(c, link), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: W } });
  return Buffer.from(r.render().asPng());
}

// ---------------------------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------------------------

/**
 * A trade. When Qalibre beat the direct swap, the improvement is the story; otherwise the amount received is,
 * with the honest note that it was the direct price.
 */
export function fillCard(p: { side: 'Bought' | 'Sold'; got: string; gotSymbol: string; paid: string; paidSymbol: string; vsDirectPct: number; token: TokenMark; link: string }): Buffer {
  const better = p.vsDirectPct > 0.0005;
  const over = `${p.side} on QMS`;
  return render(
    better
      ? { field: 'green', token: p.token, over, hero: `+${p.vsDirectPct.toFixed(2)}%`, line: 'better than a direct swap on QWAP', detail: `${p.got} ${p.gotSymbol} for ${p.paid} ${p.paidSymbol}` }
      : { field: 'green', token: p.token, over, hero: `+${p.got}`, line: `${p.gotSymbol} for ${p.paid} ${p.paidSymbol}`, detail: 'At the direct price. Never worse than a direct swap.' },
    p.link,
  );
}

export function positionCard(p: { symbol: string; pnlPct: number; held: string; cost: string; value: string; token: TokenMark; link: string }): Buffer {
  const up = p.pnlPct >= 0;
  return render(
    { field: up ? 'green' : 'ink', token: p.token, over: 'Position on QMS', hero: `${up ? '+' : '−'}${Math.abs(p.pnlPct).toFixed(1)}%`, line: `${p.cost} QMS in, ${p.value} QMS if sold now`, detail: `${p.held} ${p.symbol} held` },
    p.link,
  );
}

export function savingsCard(p: { savedUsd: string; trades: number; since: string; link: string }): Buffer {
  return render(
    { field: 'green', over: 'Saved with Qalibre', hero: `$${p.savedUsd}`, line: 'compared with swapping directly', detail: `${p.trades} ${p.trades === 1 ? 'trade' : 'trades'} since ${p.since}` },
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
      detail: `${short}  ·  checked with a simulated buy and sale`,
    },
    p.link,
  );
}
