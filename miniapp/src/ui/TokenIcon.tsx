import { keccak256, toBytes } from 'viem';

/**
 * A token's icon: the same identity the chat cards use (backend/src/logos.ts). QMS and USDC have quiet marks;
 * every other token gets its emblem, generated from its address, so the same token looks the same everywhere.
 */
const TONES = ['#2F5E7A', '#5C4A86', '#8A6A2E', '#2E6E5E', '#4A5596', '#5E6B2C', '#3F6470', '#6E5A3A', '#3D4E7A', '#4E6E3A'];
const QMS = '0x9aa510295ac664a3d5a3182a3efe959de2b12c34';
const USDC = '0xdff68e53a0a8275212927c12017f5ab5f1842a04';

function bytes(address: string): number[] {
  const h = keccak256(toBytes(address.toLowerCase())).slice(2);
  return Array.from({ length: 8 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
}

export function TokenIcon({ address, size = 40 }: { address: string; size?: number }) {
  const a = address.toLowerCase();
  const r = size / 2;
  if (a === QMS || a === USDC) {
    const qms = a === QMS;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={r} cy={r} r={r} fill={qms ? '#111214' : '#2E5C8A'} />
        <circle cx={r} cy={r} r={r - 0.5} fill="none" stroke="var(--rule-strong)" strokeWidth="1" />
        <text x={r} y={r + size * 0.17} textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontWeight="600" fontSize={size * 0.46} fill="#F6F4EF">{qms ? 'Q' : '$'}</text>
      </svg>
    );
  }
  const b = bytes(a);
  const base = TONES[b[0]! % TONES.length];
  const half = TONES[(b[0]! + 3 + (b[1]! % 5)) % TONES.length];
  const angle = Math.round((b[2]! / 255) * 8) * 45;
  const t = (b[3]! / 255) * 2 * Math.PI;
  const id = `ti${a.slice(2, 10)}${size}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <clipPath id={id}><circle cx={r} cy={r} r={r} /></clipPath>
      <g clipPath={`url(#${id})`}>
        <circle cx={r} cy={r} r={r} fill={base} />
        <path d={`M 0 ${r} A ${r} ${r} 0 0 0 ${size} ${r} Z`} fill={half} transform={`rotate(${angle} ${r} ${r})`} />
        <circle cx={r + Math.cos(t) * r * 0.42} cy={r + Math.sin(t) * r * 0.42} r={r * 0.16} fill="#F6F4EF" />
      </g>
    </svg>
  );
}
