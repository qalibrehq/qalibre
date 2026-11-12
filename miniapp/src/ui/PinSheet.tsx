import { useState } from 'react';
import type { PrivateKeyAccount } from 'viem/accounts';
import { unlockOwner, WrongPin } from '../wallet';
import { haptic } from '../tg';
import { Back } from './Brand';
import { Keypad } from './Keypad';

/**
 * Full-screen PIN entry that unlocks the wallet key on this device, then runs `onUnlocked`.
 * Shows what is about to be signed, in plain words, before the PIN is entered.
 */
export function PinSheet({
  title,
  summary,
  onUnlocked,
  onCancel,
}: {
  title: string;
  summary: { label: string; value: string }[];
  onUnlocked: (owner: PrivateKeyAccount) => Promise<void>;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onKey(k: string) {
    if (busy || k === '.') return;
    if (k === 'del') return setPin((p) => p.slice(0, -1));
    const next = (pin + k).slice(0, 6);
    setPin(next);
    setError(null);
    if (next.length < 6) return;
    setBusy(true);
    unlockOwner(next)
      .then(async (owner) => {
        await onUnlocked(owner);
        haptic.success();
      })
      .catch((e) => {
        haptic.warn();
        setPin('');
        setError(e instanceof WrongPin ? 'That PIN is not right.' : (e as Error).message);
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className="screen fade-in">
      <div className="bar">
        <button className="icon-btn" aria-label="Cancel" onClick={onCancel} disabled={busy}><Back /></button>
        <span className="label">Confirm</span>
        <div style={{ width: 30 }} />
      </div>
      <h2 style={{ margin: '28px 0 0', fontSize: 26, fontWeight: 600, letterSpacing: '-0.03em' }}>{title}</h2>
      <div className="rows strong" style={{ marginTop: 16 }}>
        {summary.map((s) => (
          <div key={s.label} className="row"><span>{s.label}</span><span className="num" style={{ color: 'var(--ink)', textAlign: 'right', wordBreak: 'break-all' }}>{s.value}</span></div>
        ))}
        <div className="row"><span>Network fee</span><span style={{ color: 'var(--ink)' }}>Covered by Qalibre</span></div>
      </div>
      <p className="muted" style={{ margin: '18px 0 0', fontSize: 13, textAlign: 'center' }}>{busy ? 'Signing on this device and confirming on QMS…' : 'Enter your PIN to sign on this device.'}</p>
      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center', gap: 16 }} aria-live="polite">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} style={{ width: 12, height: 12, borderRadius: 6, background: i < pin.length ? 'var(--ink)' : 'transparent', border: '1px solid var(--ink)' }} />
        ))}
      </div>
      <p style={{ minHeight: 22, margin: '14px 0 0', textAlign: 'center', fontSize: 14, color: 'var(--danger)' }}>{error ?? ''}</p>
      <div className="spacer" style={{ opacity: busy ? 0.4 : 1 }}><Keypad decimal={false} onKey={onKey} /></div>
    </div>
  );
}
