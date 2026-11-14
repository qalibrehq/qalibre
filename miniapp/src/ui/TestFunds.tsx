import { useState } from 'react';
import { api } from '../api';
import { haptic } from '../tg';
import { Icon } from './Icons';

/** One tap: tradeable test QMS and USDC, once a day. Testnet only. */
export function TestFundsButton({ onDone, toast, variant = 'row' }: { onDone: () => void; toast: (m: string) => void; variant?: 'row' | 'button' | 'card' }) {
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
  if (variant === 'card') {
    // The whole card is the button, like the backup reminder: one clear target, nothing squeezed.
    return (
      <button className="nudge funds" onClick={go} disabled={busy}>
        <span className="nudge-icon funds-icon"><Icon name="drop" size={20} /></span>
        <span style={{ minWidth: 0 }}>
          <b>{busy ? 'Sending your test funds…' : 'Get free test funds'}</b>
          <span>Test QMS and USDC for your first trade. Once a day, no card, no cost.</span>
        </span>
        <span className="chev"><Icon name="chevron" size={18} /></span>
      </button>
    );
  }
  if (variant === 'button') {
    return (
      <button className="btn btn-line" onClick={go} disabled={busy}>
        {busy ? 'Sending test funds…' : 'Get test funds'}
      </button>
    );
  }
  return (
    <button className="item" onClick={go} disabled={busy}>
      <span className="disc-sm" aria-hidden="true"><Icon name="drop" size={20} /></span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 500 }}>{busy ? 'Sending test funds…' : 'Get test funds'}</span>
        <span className="sub" style={{ display: 'block' }}>Free test QMS and USDC, once a day</span>
      </span>
      <span className="chev"><Icon name="chevron" size={18} /></span>
    </button>
  );
}
