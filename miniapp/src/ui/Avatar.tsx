import { useState } from 'react';
import { photoUrl } from '../tg';

/** The user's Telegram photo; their initial on our green when there is no photo or it fails to load. */
export function Avatar({ name, size }: { name?: string | null; size: number }) {
  const [failed, setFailed] = useState(false);
  const src = photoUrl();
  const initial = (name ?? 'Q').slice(0, 1).toUpperCase();
  if (src && !failed) {
    return <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: size / 2, objectFit: 'cover', display: 'block', background: 'var(--paper-2)' }} />;
  }
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: size / 2, background: 'var(--green)', color: 'var(--paper)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.round(size * 0.4), fontWeight: 600 }}>
      {initial}
    </span>
  );
}
