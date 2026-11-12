/**
 * Token logos for cards.
 *
 * Today no QMS source publishes token logos (the explorer has none; QWAP has no token list). So: a real logo
 * when one exists (the explorer's icon_url, checked first so logos appear the day QMS starts publishing them),
 * otherwise a designed badge generated from the token itself. The badge is deterministic: the same token always
 * gets the same colour, chosen from deep tones that sit well on the green and ink cards.
 *
 * Remote images are untrusted: only PNG, JPEG and SVG are accepted, capped at 256 KB, fetched with a timeout,
 * and embedded as data URIs (the renderer never fetches anything itself, and runs no scripts).
 */
import { keccak256, toBytes, type Address } from 'viem';

const EXPLORER_API = 'https://testnet.qmsscan.io/api/v2';
const MAX_BYTES = 256 * 1024;
const cache = new Map<string, { at: number; uri: string | null }>();
const TTL_MS = 6 * 3600_000;

/**
 * Deep, desaturated tones that sit with the green and ink cards. No reds or pinks: on our cards red means
 * "blocked", and a token's emblem must never look like a verdict.
 */
const TONES = ['#2F5E7A', '#5C4A86', '#8A6A2E', '#2E6E5E', '#4A5596', '#5E6B2C', '#3F6470', '#6E5A3A', '#3D4E7A', '#4E6E3A'];

function hashBytes(address: string): number[] {
  const h = keccak256(toBytes(address.toLowerCase())).slice(2);
  return Array.from({ length: 32 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
}

/**
 * A geometric emblem unique to the token's address, for tokens with no published logo: a base tone with two
 * shapes in neighbouring tones, rotated by the hash. Same token, same emblem, everywhere.
 * Returns SVG content for a circle of radius r centred at (cx, cy), to be clipped by the caller.
 */
export function emblem(address: string, cx: number, cy: number, r: number): string {
  // Crisp at small sizes: a base tone, one clean half-disc in a second tone at the token's own angle,
  // and a small paper dot. Three flat shapes, no blending, no gradients.
  const b = hashBytes(address);
  const base = TONES[b[0]! % TONES.length]!;
  const half = TONES[(b[0]! + 3 + (b[1]! % 5)) % TONES.length]!;
  const angle = Math.round((b[2]! / 255) * 8) * 45; // eight clean directions
  const dotA = ((b[3]! / 255) * 2 * Math.PI);
  const dotR = r * 0.16;
  const dx = cx + Math.cos(dotA) * r * 0.42;
  const dy = cy + Math.sin(dotA) * r * 0.42;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${base}"/>
    <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 0 ${cx + r} ${cy} Z" fill="${half}" transform="rotate(${angle} ${cx} ${cy})"/>
    <circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="${dotR.toFixed(1)}" fill="#F6F4EF"/>`;
}

function sniff(buf: Uint8Array): 'image/png' | 'image/jpeg' | 'image/svg+xml' | null {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head = new TextDecoder().decode(buf.slice(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

async function fetchImage(url: string): Promise<string | null> {
  if (!/^https:\/\//.test(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'follow' });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > MAX_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) return null;
    const type = sniff(buf); // trust the bytes, not the header
    if (!type) return null;
    if (type === 'image/svg+xml' && /<script|href\s*=\s*["']?(?!#|data:)/i.test(new TextDecoder().decode(buf))) return null;
    return `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
  } catch {
    return null;
  }
}

/** A real logo for this token as a data URI, or null when none is published. Cached for 6 hours. */
export async function tokenLogo(address: Address): Promise<string | null> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.uri;
  let uri: string | null = null;
  try {
    const res = await fetch(`${EXPLORER_API}/tokens/${address}`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const t = (await res.json()) as { icon_url?: string | null };
      if (t.icon_url) uri = await fetchImage(t.icon_url);
    }
  } catch {
    /* explorer down: fall back to the badge */
  }
  cache.set(key, { at: Date.now(), uri });
  return uri;
}
