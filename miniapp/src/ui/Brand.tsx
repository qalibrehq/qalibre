/** The qalibre wordmark and monogram, drawn on the identity grid (see brand/). */
export function Wordmark({ width = 92, color = 'var(--ink)', hole = 'var(--paper)' }: { width?: number; color?: string; hole?: string }) {
  return (
    <svg width={width} height={(width * 82) / 257} viewBox="0 0 257 82" role="img" aria-label="Qalibre">
      <g fill="none" stroke={color} strokeWidth="8">
        <circle cx="24" cy="40" r="16" />
        <path d="M40 24 V78" />
        <circle cx="73" cy="40" r="16" />
        <path d="M89 24 V60" />
        <path d="M106 4 V60" />
        <path d="M123 24 V60" />
        <path d="M140 4 V60" />
        <circle cx="156" cy="40" r="16" />
        <path d="M189 24 V60 M189 42 A16 16 0 0 1 205 26" />
        <path d="M215 40 H247 M247 40 A16 16 0 1 0 242.3 51.3" />
      </g>
      <circle cx="123" cy="10" r="5.6" fill="var(--jewel)" />
      <circle cx="123" cy="10" r="1.9" fill={hole} />
    </svg>
  );
}

export function Jewel({ size = 14, hole = 'var(--paper)' }: { size?: number; hole?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="7" fill="var(--jewel)" />
      <circle cx="7" cy="7" r="2.4" fill={hole} />
    </svg>
  );
}

export const Back = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path d="M11 3.5 L5.5 9 L11 14.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Close = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/** Fine-line engraving: many orders converge on one jewel, one green line leaves. */
export function Convergence({ height = 196, animate = true }: { height?: number; animate?: boolean }) {
  const ys = [18, 52, 84, 112, 144, 178];
  const pulls = [140, 146, 154, 154, 146, 140];
  return (
    <svg width="100%" height={height} viewBox="0 0 334 196" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {ys.map((y, i) => (
        <path key={y} className={animate ? 'draw' : undefined} style={{ animationDelay: `${i * 0.07}s` }} d={`M0 ${y} C 110 ${y}, ${pulls[i]} 98, 214 98`} fill="none" stroke="var(--ink)" strokeWidth="1" />
      ))}
      <path className={animate ? 'draw' : undefined} style={{ animationDelay: '0.9s' }} d="M214 98 H334" fill="none" stroke="var(--green)" strokeWidth="2.4" />
      <g className={animate ? 'jewel-in' : undefined} style={{ animationDelay: '1.3s' }}>
        <circle cx="214" cy="98" r="7" fill="var(--jewel)" />
        <circle cx="214" cy="98" r="2.4" fill="var(--paper)" />
      </g>
    </svg>
  );
}
