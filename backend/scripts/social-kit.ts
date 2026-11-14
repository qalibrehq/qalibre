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

// Header: the mechanism, not a slogan. Orders stream in from the left and meet at the brass ring, set in a
// watch-dial bezel (Qalibre: calibre); one settled line leaves to the right. The name is already beside it on the
// profile, so the header carries no wordmark. Lower-left stays quiet: X puts the profile photo there.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const RX = 1010, RY = 250; // the ring
const lines: string[] = [];
const dots: string[] = [];
for (let i = 0; i < 46; i++) {
  const y0 = 18 + i * 10.4 + (rnd() - 0.5) * 8;
  const x0 = -20;
  const c1x = 300 + rnd() * 260, c2x = RX - 230 - rnd() * 120;
  const endY = RY + (rnd() - 0.5) * 10;
  const near = Math.abs(y0 - RY) / 250; // outer lines quieter
  const op = (0.05 + (1 - near) * 0.16).toFixed(3);
  const d = `M${x0} ${y0.toFixed(1)} C${c1x.toFixed(0)} ${y0.toFixed(1)} ${c2x.toFixed(0)} ${endY.toFixed(1)} ${RX - 46} ${endY.toFixed(1)}`;
  lines.push(`<path d="${d}" fill="none" stroke="${C.paper}" stroke-opacity="${op}" stroke-width="1.2"/>`);
  // A few orders in flight: small dots partway along their curve (cubic Bezier at t).
  if (rnd() < 0.42) {
    const t = 0.25 + rnd() * 0.6, u = 1 - t;
    const px = u ** 3 * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * (RX - 46);
    const py = u ** 3 * y0 + 3 * u * u * t * y0 + 3 * u * t * t * endY + t ** 3 * endY;
    const buy = rnd() < 0.5;
    dots.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(2.2 + rnd() * 1.6).toFixed(1)}" fill="${buy ? '#8FD4AE' : C.paper}" fill-opacity="${buy ? 0.75 : 0.55}"/>`);
  }
}
// Bezel: 60 ticks, every fifth longer, in brass.
const ticks: string[] = [];
for (let k = 0; k < 60; k++) {
  const a = (k / 60) * Math.PI * 2;
  const r1 = 118, r2 = k % 5 === 0 ? 134 : 126;
  ticks.push(`<line x1="${(RX + r1 * Math.cos(a)).toFixed(1)}" y1="${(RY + r1 * Math.sin(a)).toFixed(1)}" x2="${(RX + r2 * Math.cos(a)).toFixed(1)}" y2="${(RY + r2 * Math.sin(a)).toFixed(1)}" stroke="${C.brass}" stroke-opacity="${k % 5 === 0 ? 0.7 : 0.35}" stroke-width="${k % 5 === 0 ? 2 : 1.2}"/>`);
}
const header = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
  <defs>
    <radialGradient id="glow" cx="${RX}" cy="${RY}" r="520" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1B6B52"/><stop offset="0.55" stop-color="${C.green}"/><stop offset="1" stop-color="#0B3D2E"/>
    </radialGradient>
    <radialGradient id="halo" cx="${RX}" cy="${RY}" r="150" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.brass}" stop-opacity="0.22"/><stop offset="1" stop-color="${C.brass}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1500" height="500" fill="url(#glow)"/>
  ${lines.join('\n  ')}
  ${dots.join('\n  ')}
  <circle cx="${RX}" cy="${RY}" r="150" fill="url(#halo)"/>
  <circle cx="${RX}" cy="${RY}" r="104" fill="none" stroke="${C.brass}" stroke-opacity="0.18" stroke-width="1"/>
  ${ticks.join('\n  ')}
  <path d="M${RX + 46} ${RY} H1520" stroke="${C.paper}" stroke-opacity="0.85" stroke-width="2"/>
  <circle cx="${RX}" cy="${RY}" r="44" fill="${C.brass}"/>
  <circle cx="${RX}" cy="${RY}" r="15" fill="#155C46"/>
  <text x="1420" y="210" text-anchor="end" font-family="Inter" font-weight="500" font-size="22" letter-spacing="2.4" fill="${C.paper}" fill-opacity="0.7">ONE FAIR PRICE</text>
  <text x="96" y="92" font-family="Inter" font-weight="600" font-size="34" letter-spacing="-0.8" fill="${C.paper}">Every trade, protected.</text>
</svg>`;
writeFileSync(join(out, 'x-header-1500x500.png'), png(header, 1500));
console.log('written to', out);

// Telegram channel launch image (1280x720): the line on the left, the mechanism on the right.
{
  let sd = 11;
  const r2 = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const CX = 1010, CY = 360;
  const ls: string[] = [];
  const ds: string[] = [];
  for (let i = 0; i < 40; i++) {
    const y0 = 30 + i * 16.5 + (r2() - 0.5) * 10;
    const x0 = 640, c1x = 790 + r2() * 70, c2x = CX - 150 - r2() * 60, ey = CY + (r2() - 0.5) * 8;
    const near = Math.abs(y0 - CY) / 360;
    ls.push(`<path d="M${x0} ${y0.toFixed(1)} C${c1x.toFixed(0)} ${y0.toFixed(1)} ${c2x.toFixed(0)} ${ey.toFixed(1)} ${CX - 40} ${ey.toFixed(1)}" fill="none" stroke="${C.paper}" stroke-opacity="${(0.04 + (1 - near) * 0.17).toFixed(3)}" stroke-width="1.2"/>`);
    if (r2() < 0.4) {
      const t = 0.3 + r2() * 0.55, u = 1 - t;
      const px = u ** 3 * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * (CX - 40);
      const py = u ** 3 * y0 + 3 * u * u * t * y0 + 3 * u * t * t * ey + t ** 3 * ey;
      const buy = r2() < 0.5;
      ds.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(2.2 + r2() * 1.4).toFixed(1)}" fill="${buy ? '#8FD4AE' : C.paper}" fill-opacity="${buy ? 0.75 : 0.5}"/>`);
    }
  }
  const tk: string[] = [];
  for (let k = 0; k < 60; k++) {
    const a = (k / 60) * Math.PI * 2, r1 = 96, rr = k % 5 === 0 ? 110 : 103;
    tk.push(`<line x1="${(CX + r1 * Math.cos(a)).toFixed(1)}" y1="${(CY + r1 * Math.sin(a)).toFixed(1)}" x2="${(CX + rr * Math.cos(a)).toFixed(1)}" y2="${(CY + rr * Math.sin(a)).toFixed(1)}" stroke="${C.brass}" stroke-opacity="${k % 5 === 0 ? 0.7 : 0.35}" stroke-width="${k % 5 === 0 ? 2 : 1.2}"/>`);
  }
  const chip = (x: number, label: string) => {
    const w = Math.round(label.length * 10.6 + 44);
    return { w, svg: `<rect x="${x}" y="520" width="${w}" height="42" rx="21" fill="${C.paper}" fill-opacity="0.08" stroke="${C.paper}" stroke-opacity="0.18"/><text x="${x + w / 2}" y="547" text-anchor="middle" font-family="Inter" font-weight="500" font-size="19" fill="${C.paper}" fill-opacity="0.92">${label}</text>` };
  };
  let cx = 96;
  const chips = ['Safety check', 'Fast mode', 'AI agents'].map((l) => { const c = chip(cx, l); cx += c.w + 10; return c.svg; }).join('');
  const launch = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <radialGradient id="g" cx="${CX}" cy="${CY}" r="700" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1B6B52"/><stop offset="0.5" stop-color="${C.green}"/><stop offset="1" stop-color="#0A3528"/></radialGradient>
    <radialGradient id="h" cx="${CX}" cy="${CY}" r="130" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${C.brass}" stop-opacity="0.24"/><stop offset="1" stop-color="${C.brass}" stop-opacity="0"/></radialGradient>
    <linearGradient id="fade" x1="770" y1="0" x2="880" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient>
    <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="1280" height="720"><rect width="1280" height="720" fill="url(#fade)"/></mask>
  </defs>
  <rect width="1280" height="720" fill="url(#g)"/>
  <g mask="url(#m)">${ls.join('')}${ds.join('')}</g>
  <circle cx="${CX}" cy="${CY}" r="130" fill="url(#h)"/>
  ${tk.join('\n  ')}
  <path d="M${CX + 38} ${CY} H1290" stroke="${C.paper}" stroke-opacity="0.85" stroke-width="2"/>
  <circle cx="${CX}" cy="${CY}" r="38" fill="${C.brass}"/><circle cx="${CX}" cy="${CY}" r="13" fill="#155C46"/>
  ${wordmark(96, 96, 0.62, C.green)}
  <text x="96" y="300" font-family="Inter" font-weight="600" font-size="64" letter-spacing="-2.4" fill="${C.paper}">Live on QMS.</text>
  <text x="96" y="372" font-family="Inter" font-weight="600" font-size="64" letter-spacing="-2.4" fill="${C.paper}" fill-opacity="0.55">Every trade, protected.</text>
  <text x="98" y="440" font-family="Inter" font-weight="500" font-size="23" fill="${C.paper}" fill-opacity="0.66">Trading on QMS, inside Telegram. Testnet now.</text>
  ${chips}
  <text x="1184" y="660" text-anchor="end" font-family="Inter" font-weight="500" font-size="20" fill="${C.paper}" fill-opacity="0.6">qalibre.app</text>
</svg>`;
  writeFileSync(join(out, 'tg-launch-1280x720.png'), png(launch, 1280));
  console.log('telegram launch image written');
}
