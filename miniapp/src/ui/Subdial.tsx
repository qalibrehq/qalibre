/** Watch subdial for the batch countdown: 20 ticks, a green hand, a jewel at the centre. */
export function Subdial({ progress, label }: { progress: number; label: string }) {
  const ticks = Array.from({ length: 20 }, (_, i) => i);
  const deg = Math.max(0, Math.min(1, progress)) * 360;
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" role="img" aria-label={label}>
      <circle cx="28" cy="28" r="26" fill="var(--white)" stroke="var(--rule-strong)" strokeWidth="1" />
      {ticks.map((i) => (
        <line key={i} x1="28" y1={i % 2 === 0 ? 10 : 8} x2="28" y2="5" stroke={i % 2 === 0 ? 'var(--ink)' : 'var(--muted)'} strokeWidth={i % 2 === 0 ? 1.4 : 0.8} transform={`rotate(${i * 18} 28 28)`} />
      ))}
      <g style={{ transformOrigin: '28px 28px', transform: `rotate(${deg}deg)`, transition: 'transform 0.5s cubic-bezier(.4,1.6,.5,1)' }}>
        <line x1="28" y1="31" x2="28" y2="8" stroke="var(--green)" strokeWidth="1.6" strokeLinecap="round" />
      </g>
      <circle cx="28" cy="28" r="3" fill="var(--jewel)" />
      <circle cx="28" cy="28" r="1" fill="var(--white)" />
    </svg>
  );
}
