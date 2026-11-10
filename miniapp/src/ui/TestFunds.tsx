import { useState } from 'react';
import { api } from '../api';
import { haptic } from '../tg';

/** One tap: tradeable test QMS and USDC, once a day. Testnet only. */
export function TestFundsButton({ onDone, toast, variant = 'row' }: { onDone: () => void; toast: (m: string) => void; variant?: 'row' | 'button' }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    if (busy) return;
    haptic.tap();
    setBusy(true);
    try {
      await api.testFunds();
      haptic.success();
      toast('Test funds added: QMS and USDC, ready to trade.');
      onDone();
    } catch (e) {
      haptic.warn();
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (variant === 'button') {
    return (
      <button className="btn btn-line" onClick={go} disabled={busy}>
        {busy ? 'Sending test funds…' : 'Get test funds'}
      </button>
    );
  }
  return (
    <button onClick={go} disabled={busy} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 0', border: 0, borderBottom: '1px solid var(--rule)', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
      <span>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 500 }}>Add funds</span>
        <span className="muted" style={{ display: 'block', fontSize: 13, marginTop: 2 }}>Free test QMS and USDC, once a day</span>
      </span>
      <span className="green" style={{ fontSize: 14, fontWeight: 600 }}>{busy ? 'Sending…' : 'Get test funds'}</span>
    </button>
  );
}
