/**
 * Shareable image cards: trade fills, positions, savings and safety alerts.
 *
 * One design system, the same as the app ("Paper & Ink"): warm paper, ink type, one accent at a time,
 * a hairline grid, the wordmark with its jewel dot. Rendered server-side from SVG to PNG with bundled fonts,
 * so every card looks identical on every device. 1200x675 (16:9) is what Telegram and X both show uncropped.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { ROOT } from './config.js';

const W = 1200;
const H = 675;
const M = 80; // outer margin
const FONTS = ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'Inter-Bold', 'JetBrainsMono-Regular', 'JetBrainsMono-Medium'].map((f) => join(ROOT, 'backend', 'assets', 'fonts', `${f}.ttf`));

const C = {
  paper: '#F6F4EF',
  paper2: '#ECE8DF',
  ink: '#111214',
  graphite: '#5B5E66',
  rule: '#DCD8CD',
  green: '#0F4D3A',
  jewel: '#B08D57',
  danger: '#A33A2B',
  caution: '#8A4B0F',
};

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Font size that fits `text` in `width` (Inter's average advance is ~0.56em for figures and caps). */
function fit(text: string, width: number, max: number, min = 40, advance = 0.58): number {
  return Math.max(min, Math.min(max, Math.floor(width / Math.max(1, text.length * advance))));
}

/** The wordmark, drawn from the same geometry as brand/qalibre-wordmark-ink.svg, scaled to `h` px tall. */
function wordmark(tx: number, ty: number, h: number, ink = C.ink, paper = C.paper): string {
  const s = h / 82;
  return `<g transform="translate(${tx} ${ty}) scale(${s})">
    <g fill="none" stroke="${ink}" stroke-width="8"><circle cx="24" cy="40" r="16"/><path d="M40 24 V78"/><circle cx="73" cy="40" r="16"/><path d="M89 24 V60"/><path d="M106 4 V60"/><path d="M123 24 V60"/><path d="M140 4 V60"/><circle cx="156" cy="40" r="16"/><path d="M189 24 V60 M189 42 A16 16 0 0 1 205 26"/><path d="M215 40 H247 M247 40 A16 16 0 1 0 242.3 51.3"/></g>
    <circle cx="123" cy="10" r="5.6" fill="${C.jewel}"/><circle cx="123" cy="10" r="1.9" fill="${paper}"/></g>`;
}

export interface Stat {
  label: string;
  value: string;
  tone?: 'green' | 'danger' | 'caution' | 'ink';
}

interface Layout {
  eyebrow: string; // small mono label, top right
  kicker: string; // small line above the hero
  hero: string; // the one big thing
  heroUnit?: string; // optional unit after the hero, shown smaller (e.g. a token symbol)
  heroTone?: 'green' | 'danger' | 'caution' | 'ink';
  sub: string; // one line under the hero
  mono?: string; // optional address line
  stats: Stat[]; // up to 3
  footer: string; // left footer line
  accent?: 'green' | 'danger' | 'caution' | 'jewel';
}

const tone = (t?: string) => (t === 'green' ? C.green : t === 'danger' ? C.danger : t === 'caution' ? C.caution : C.ink);

function svg(l: Layout, link: string): string {
  const accent = l.accent === 'danger' ? C.danger : l.accent === 'caution' ? C.caution : l.accent === 'green' ? C.green : C.jewel;
  // Hero: the figure leads; an optional unit (after a space, e.g. a token symbol) steps back at half size.
  const split: [string, string] = [l.hero, l.heroUnit ?? ''];
  const heroSize = fit(split[0] + (split[1] ? ' ' + split[1].replace(/./g, 'x').slice(0, Math.ceil(split[1].length / 2)) : ''), W - 2 * M, 140);
  // Fixed vertical rhythm: every card shares the same baselines.
  const kickerY = 178;
  const heroY = kickerY + 26 + Math.round(heroSize * 0.76); // cap height of Inter is ~0.73em
  const subY = heroY + 70;
  const statsRule = 470;
  const statsY = 512;
  const colW = (W - 2 * M) / 3;
  const stats = l.stats.slice(0, 3).map((s, i) => {
    const sx = M + i * colW + (i > 0 ? 32 : 0);
    return `${i > 0 ? `<line x1="${M + i * colW}" y1="${statsY - 22}" x2="${M + i * colW}" y2="${statsY + 40}" stroke="${C.rule}" stroke-width="1.5"/>` : ''}
      <text x="${sx}" y="${statsY}" font-family="JetBrains Mono" font-size="14" letter-spacing="1.8" fill="${C.graphite}">${x(s.label.toUpperCase())}</text>
      <text x="${sx}" y="${statsY + 38}" font-family="Inter" font-weight="600" font-size="${fit(s.value, colW - 48, 30, 20, 0.6)}" letter-spacing="-0.4" fill="${tone(s.tone)}">${x(s.value)}</text>`;
  });
  const unit = split[1] ? `<tspan dx="${Math.round(heroSize * 0.18)}" font-weight="500" font-size="${Math.round(heroSize * 0.42)}" letter-spacing="0" fill="${C.graphite}">${x(split[1])}</tspan>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${C.paper}"/>
  <rect width="${W}" height="8" fill="${accent}"/>
  ${wordmark(M, 62, 32)}
  <text x="${W - M}" y="86" text-anchor="end" font-family="JetBrains Mono" font-size="14" letter-spacing="2" fill="${C.graphite}">${x(l.eyebrow.toUpperCase())}</text>
  <text x="${M}" y="${kickerY}" font-family="Inter" font-weight="500" font-size="24" fill="${C.graphite}">${x(l.kicker)}</text>
  <text x="${M - Math.round(heroSize * 0.04)}" y="${heroY}" font-family="Inter" font-weight="600" font-size="${heroSize}" letter-spacing="${(-heroSize * 0.04).toFixed(1)}" fill="${tone(l.heroTone)}">${x(split[0])}${unit}</text>
  <text x="${M}" y="${subY}" font-family="Inter" font-weight="500" font-size="28" fill="${C.ink}">${x(l.sub)}</text>
  ${l.mono ? `<text x="${M}" y="${subY + 40}" font-family="JetBrains Mono" font-size="17" fill="${C.graphite}">${x(l.mono)}</text>` : ''}
  <line x1="${M}" y1="${statsRule}" x2="${W - M}" y2="${statsRule}" stroke="${C.ink}" stroke-width="1.5"/>
  ${stats.join('')}
  <text x="${M}" y="${H - 52}" font-family="Inter" font-weight="400" font-size="18" fill="${C.graphite}">${x(l.footer)}</text>
  <text x="${W - M}" y="${H - 52}" text-anchor="end" font-family="JetBrains Mono" font-weight="500" font-size="17" fill="${C.ink}">${x(link)}</text>
</svg>`;
}

function render(l: Layout, link: string): Buffer {
  const r = new Resvg(svg(l, link), {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    fitTo: { mode: 'width', value: W },
  });
  return Buffer.from(r.render().asPng());
}

// ---------------------------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------------------------

export function fillCard(p: { side: 'Bought' | 'Sold'; got: string; gotSymbol: string; paid: string; paidSymbol: string; vsDirectPct: number; feePaid: string; block: string; link: string }): Buffer {
  const better = p.vsDirectPct > 0.0005;
  return render(
    {
      eyebrow: 'Trade · QMS',
      kicker: p.side,
      hero: `+${p.got}`,
      heroUnit: p.gotSymbol,
      sub: `for ${p.paid} ${p.paidSymbol}`,
      stats: [
        { label: 'vs direct swap', value: better ? `+${p.vsDirectPct.toFixed(2)}% better` : 'Same price', tone: better ? 'green' : 'ink' },
        { label: 'Qalibre fee', value: p.feePaid },
        { label: 'Settled', value: `Block ${p.block}` },
      ],
      footer: 'Matched first. Never worse than a direct swap.',
      accent: better ? 'green' : 'jewel',
    },
    p.link,
  );
}

export function positionCard(p: { symbol: string; pnlPct: number; held: string; cost: string; value: string; profit: string; link: string }): Buffer {
  const up = p.pnlPct >= 0;
  return render(
    {
      eyebrow: 'Position · QMS',
      kicker: `${p.symbol} since first buy`,
      hero: `${up ? '+' : ''}${p.pnlPct.toFixed(1)}%`,
      heroTone: up ? 'green' : 'danger',
      sub: `${p.held} ${p.symbol} held`,
      stats: [
        { label: 'Cost', value: `${p.cost} QMS` },
        { label: 'Value if sold now', value: `${p.value} QMS` },
        { label: up ? 'Profit' : 'Loss', value: p.profit, tone: up ? 'green' : 'danger' },
      ],
      footer: 'Value is what selling all of it returns from the pool now.',
      accent: up ? 'green' : 'danger',
    },
    p.link,
  );
}

export function savingsCard(p: { savedUsd: string; trades: number; since: string; link: string }): Buffer {
  return render(
    {
      eyebrow: 'Savings · QMS',
      kicker: 'Saved with Qalibre',
      hero: `$${p.savedUsd}`,
      heroTone: 'green',
      sub: 'compared with swapping directly',
      stats: [
        { label: 'Trades', value: String(p.trades) },
        { label: 'Worse than direct', value: 'Never', tone: 'green' },
        { label: 'Since', value: p.since },
      ],
      footer: 'Buyers matched with sellers first, at one fair price.',
      accent: 'green',
    },
    p.link,
  );
}

export function safetyCard(p: { symbol: string; address: string; verdict: 'blocked' | 'high' | 'caution' | 'ok'; score: number; headline: string; reason: string; checks: Stat[]; link: string }): Buffer {
  const danger = p.verdict === 'blocked' || p.verdict === 'high';
  return render(
    {
      eyebrow: 'Safety check · QMS',
      kicker: `${p.symbol}  ·  ${p.verdict === 'blocked' ? 'Blocked' : `Score ${p.score}/100`}`,
      hero: p.headline,
      heroTone: p.verdict === 'blocked' ? 'danger' : p.verdict === 'high' ? 'caution' : p.verdict === 'caution' ? 'caution' : 'green',
      sub: p.reason,
      mono: p.address,
      stats: p.checks,
      footer: 'Simulated on live QMS state. Nothing was spent.',
      accent: p.verdict === 'blocked' ? 'danger' : danger ? 'caution' : 'green',
    },
    p.link,
  );
}

/** For design review only: the raw SVG of a layout. */
export const _svgForReview = svg;
