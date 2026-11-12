/**
 * The opening moment: the wordmark draws itself, stroke by stroke, then the brass ring drops onto the i and
 * settles. Pure CSS on the real wordmark geometry (brand/qalibre-wordmark-ink.svg), so it is crisp at any size.
 */
const STROKES = [
  { d: 'M24 24 a16 16 0 1 0 0.01 0', len: 1 },
  { d: 'M40 24 V78' },
  { d: 'M73 24 a16 16 0 1 0 0.01 0' },
  { d: 'M89 24 V60' },
  { d: 'M106 4 V60' },
  { d: 'M123 24 V60' },
  { d: 'M140 4 V60' },
  { d: 'M156 24 a16 16 0 1 0 0.01 0' },
  { d: 'M189 24 V60 M189 42 A16 16 0 0 1 205 26' },
  { d: 'M215 40 H247 M247 40 A16 16 0 1 0 242.3 51.3' },
];

export function Splash({ width = 168 }: { width?: number }) {
  return (
    <div className="splash" role="img" aria-label="Qalibre">
      <svg width={width} height={(width * 82) / 257} viewBox="0 -6 257 88" aria-hidden="true">
        <g fill="none" stroke="var(--ink)" strokeWidth="8" strokeLinecap="butt">
          {STROKES.map((s, i) => (
            <path key={i} d={s.d} pathLength={1} className="splash-stroke" style={{ animationDelay: `${i * 55}ms` }} />
          ))}
        </g>
        <g className="splash-ring">
          <circle cx="123" cy="10" r="5.6" fill="var(--jewel)" />
          <circle cx="123" cy="10" r="1.9" fill="var(--paper)" />
        </g>
      </svg>
    </div>
  );
}

/** Soft placeholder blocks while data loads, in the shape of the list that will appear. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="surface" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="item" style={{ cursor: 'default' }}>
          <span className="shimmer" style={{ width: 40, height: 40, borderRadius: 20 }} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="shimmer" style={{ width: '46%', height: 12, borderRadius: 6 }} />
            <span className="shimmer" style={{ width: '28%', height: 10, borderRadius: 5 }} />
          </span>
          <span className="shimmer" style={{ width: 56, height: 12, borderRadius: 6 }} />
        </div>
      ))}
    </div>
  );
}
