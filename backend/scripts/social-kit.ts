/**
 * Renders the X (Twitter) profile images from the brand: a 400x400 avatar and a 1500x500 header.
 *   npx tsx scripts/social-kit.ts            (writes into brand/social/)
 * The header keeps its lower-left clear: X places the profile photo there on every device.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { ROOT } from '../src/config.js';

const C = { green: '#0F4D3A', ink: '#111214', paper: '#F6F4EF', brass: '#B08D57' };
const FONTS = ['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf'].map((f) => join(ROOT, 'backend', 'assets', 'fonts', f));
const out = join(ROOT, 'brand', 'social');
mkdirSync(out, { recursive: true });

const png = (svg: string, width: number) => Buffer.from(new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: width } }).render().asPng());

// The wordmark paths (viewBox 0 0 257 82), drawn in paper with the brass ring over the i.
const wordmark = (x: number, y: number, s: number, bg: string) => `<g transform="translate(${x} ${y}) scale(${s})">
  <g fill="none" stroke="${C.paper}" stroke-width="8"><circle cx="24" cy="40" r="16"/><path d="M40 24 V78"/><circle cx="73" cy="40" r="16"/><path d="M89 24 V60"/><path d="M106 4 V60"/><path d="M123 24 V60"/><path d="M140 4 V60"/><circle cx="156" cy="40" r="16"/><path d="M189 24 V60 M189 42 A16 16 0 0 1 205 26"/><path d="M215 40 H247 M247 40 A16 16 0 1 0 242.3 51.3"/></g>
  <circle cx="123" cy="10" r="5.6" fill="${C.brass}"/><circle cx="123" cy="10" r="1.9" fill="${bg}"/></g>`;

// The q monogram (from the app icon): bowl + stem, brass ring at the foot.
const q = (cx: number, cy: number, h: number, bg: string, strokeOpacity = 1) => {
  const s = h / 64;
  return `<g transform="translate(${cx - 28 * s} ${cy - 32 * s}) scale(${s})">
    <g fill="none" stroke="${C.paper}" stroke-width="8" stroke-opacity="${strokeOpacity}"><circle cx="20" cy="22" r="16"/><path d="M36 6 V54"/></g>
    <circle cx="36" cy="58" r="5.6" fill="${C.brass}"/><circle cx="36" cy="58" r="1.9" fill="${bg}"/></g>`;
};

// Avatar: the q, centred for X's circular crop.
const avatar = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <rect width="400" height="400" fill="${C.green}"/>
  ${q(206, 196, 210, C.green)}
</svg>`;
writeFileSync(join(out, 'x-avatar-400.png'), png(avatar, 400));

// Header: green field, the big q held back on the right (as on the share cards), the line in the middle.
const header = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
  <rect width="1500" height="500" fill="${C.green}"/>
  ${q(1345, 236, 600, C.green, 0.08)}
  ${wordmark(560, 150, 1.05, C.green)}
  <text x="560" y="318" font-family="Inter" font-weight="600" font-size="58" letter-spacing="-2.2" fill="${C.paper}">Every trade, protected.</text>
  <text x="562" y="370" font-family="Inter" font-weight="500" font-size="24" fill="${C.paper}" fill-opacity="0.62">Trading on QMS, inside Telegram. Checked, fair, yours.</text>
</svg>`;
writeFileSync(join(out, 'x-header-1500x500.png'), png(header, 1500));
console.log('written to', out);
