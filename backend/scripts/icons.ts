/**
 * Renders favicons from the brand's vector app icon: a real multi-size favicon.ico (PNG frames) plus PNG sizes,
 * into the Mini App's public folder and the website.   npx tsx scripts/icons.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { ROOT } from '../src/config.js';

const svg = readFileSync(join(ROOT, 'brand', 'qalibre-app-icon.svg'), 'utf8');
const png = (size: number, square = false) => Buffer.from(new Resvg(square ? svg.replace(' rx="230"', '') : svg, { fitTo: { mode: 'width', value: size } }).render().asPng());

/** ICO container holding PNG images (supported by every current browser and OS). */
function ico(sizes: number[]): Buffer {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(sizes[i]! >= 256 ? 0 : sizes[i]!, e);
    header.writeUInt8(sizes[i]! >= 256 ? 0 : sizes[i]!, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(img.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([header, ...images]);
}

for (const dir of [join(ROOT, 'miniapp', 'public'), join(ROOT, 'site')]) {
  writeFileSync(join(dir, 'favicon.ico'), ico([16, 32, 48]));
}
const pub = join(ROOT, 'miniapp', 'public');
writeFileSync(join(pub, 'favicon-32.png'), png(32));
// iOS rounds the corners itself, so its icon is full-bleed square (transparent corners would show black).
writeFileSync(join(pub, 'apple-touch-icon.png'), png(180, true));
writeFileSync(join(pub, 'icon-192.png'), png(192));
writeFileSync(join(ROOT, 'site', 'assets', 'apple-touch-icon.png'), png(180, true));
console.log('icons written');
