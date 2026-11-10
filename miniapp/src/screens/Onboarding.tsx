import { useState } from 'react';
import { api } from '../api';
import { createOwner, loadVault, unlockOwner, WrongPin } from '../wallet';
import { haptic } from '../tg';
import { Convergence, Wordmark } from '../ui/Brand';
import { Keypad } from '../ui/Keypad';

type Step = 'welcome' | 'pin' | 'confirm' | 'unlock' | 'creating';

export function Onboarding({ onDone, resume }: { onDone: () => void; resume: boolean }) {
  const [step, setStep] = useState<Step>(resume ? 'unlock' : 'welcome');
  const [pin, setPin] = useState('');
  const [first, setFirst] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  async function finish(account: Awaited<ReturnType<typeof createOwner>>) {
    setStep('creating');
    setError(null);
    try {
      setProgress(1);
      const prep = await api.prepare(account.address);
      setProgress(2);
      const signature = await account.signMessage({ message: { raw: prep.setupHash } });
      await api.complete(signature);
      setProgress(3);
      haptic.success();
      setTimeout(onDone, 900);
    } catch (e) {
      haptic.warn();
      setError((e as Error).message);
    }
  }

  function onPinKey(k: string) {
    setError(null);
    if (k === 'del') return setPin((p) => p.slice(0, -1));
    if (k === '.') return;
    const next = (pin + k).slice(0, 6);
    setPin(next);
    if (next.length < 6) return;
    if (step === 'pin') {
      setFirst(next);
      setPin('');
      setStep('confirm');
    } else if (step === 'confirm') {
      if (next !== first) {
        haptic.warn();
        setError('The PINs did not match. Choose your PIN again.');
        setPin('');
        setFirst('');
        setStep('pin');
        return;
      }
      void createOwner(next).then(finish);
    } else if (step === 'unlock') {
      void unlockOwner(next)
        .then(finish)
        .catch((e) => {
          haptic.warn();
          setPin('');
          setError(e instanceof WrongPin ? 'That PIN is not right. Try again.' : (e as Error).message);
        });
    }
  }

  if (step === 'welcome') {
    return (
      <div className="screen fade-in">
        <div className="bar">
          <Wordmark width={96} />
          <span style={{ fontSize: 12 }} className="muted">QMS testnet</span>
        </div>
        <div style={{ marginTop: 36, borderTop: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)', padding: '12px 0' }}>
          <Convergence height={176} />
        </div>
        <h1 style={{ margin: '32px 0 0', fontSize: 44, lineHeight: 1.02, fontWeight: 600, letterSpacing: '-0.04em' }}>
          Trade together.
          <br />
          <span className="green">Pay less.</span>
        </h1>
        <p className="muted" style={{ margin: '16px 0 0', fontSize: 16, lineHeight: 1.55 }}>
          Qalibre matches buyers with sellers before it goes to the exchange, so you never get less than swapping directly. No saving, no fee.
        </p>
        <div style={{ marginTop: 26, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', borderTop: '1px solid var(--rule)' }}>
          {[
            ['$0 fee', 'unless you save'],
            ['Your keys', 'only you withdraw'],
            ['No gas', 'network fees paid'],
          ].map(([a, b], i) => (
            <div key={a} style={{ padding: '14px 12px 0', paddingLeft: i === 0 ? 0 : 12, borderLeft: i === 0 ? 0 : '1px solid var(--rule)' }}>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{a}</p>
              <p className="muted" style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.4 }}>{b}</p>
            </div>
          ))}
        </div>
        <div className="spacer" style={{ paddingTop: 24 }}>
          <button className="btn btn-green" onClick={() => setStep('pin')}>Create my wallet</button>
          <p className="muted" style={{ margin: '12px 0 0', textAlign: 'center', fontSize: 13 }}>Takes about thirty seconds.</p>
        </div>
      </div>
    );
  }

  if (step === 'creating') {
    const lines = ['Created your key on this device', 'Approved your trading limits', 'Opened your wallet on QMS'];
    return (
      <div className="screen fade-in">
        <div className="bar"><Wordmark width={88} /></div>
        <div style={{ marginTop: 56 }}>
          <Convergence height={150} />
        </div>
        <h2 style={{ margin: '36px 0 0', fontSize: 28, fontWeight: 600, letterSpacing: '-0.03em' }}>{progress >= 3 ? 'Your wallet is ready.' : 'Setting up your wallet'}</h2>
        <div className="rows" style={{ marginTop: 22 }}>
          {lines.map((l, i) => (
            <div key={l} className="row" style={{ opacity: progress >= i ? 1 : 0.35, transition: 'opacity 0.3s' }}>
              <span style={{ color: 'var(--ink)' }}>{l}</span>
              <span className="label" style={{ color: progress > i ? 'var(--green)' : 'var(--graphite)' }}>{progress > i ? 'Done' : progress === i ? 'Working' : ''}</span>
            </div>
          ))}
        </div>
        <p className="muted" style={{ margin: '18px 0 0', fontSize: 13, lineHeight: 1.5 }}>
          Default limits: 50 QMS or 100 USDC per trade. Change them any time in Control.
        </p>
        {error && (
          <div className="spacer">
            <p style={{ color: 'var(--danger)', fontSize: 14, lineHeight: 1.5 }}>{error}</p>
            <button className="btn btn-ink" onClick={() => { setPin(''); setStep('unlock'); }}>Try again</button>
          </div>
        )}
      </div>
    );
  }

  const title = step === 'pin' ? 'Choose a PIN' : step === 'confirm' ? 'Enter it once more' : 'Enter your PIN';
  const sub =
    step === 'unlock'
      ? 'Unlock your wallet key to finish setting up.'
      : 'Six digits. It locks the wallet key that only lives on this device. Qalibre never sees it, and cannot reset it.';
  return (
    <div className="screen fade-in">
      <div className="bar"><Wordmark width={88} /></div>
      <h2 style={{ margin: '48px 0 0', fontSize: 28, fontWeight: 600, letterSpacing: '-0.03em' }}>{title}</h2>
      <p className="muted" style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.55 }}>{sub}</p>
      <div style={{ marginTop: 40, display: 'flex', justifyContent: 'center', gap: 16 }} aria-live="polite" aria-label={`${pin.length} of 6 digits`}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} style={{ width: 12, height: 12, borderRadius: 6, background: i < pin.length ? 'var(--ink)' : 'transparent', border: '1px solid var(--ink)', transition: 'background 0.12s' }} />
        ))}
      </div>
      <p style={{ minHeight: 22, margin: '18px 0 0', textAlign: 'center', fontSize: 14, color: 'var(--danger)' }}>{error ?? ''}</p>
      <div className="spacer">
        <Keypad decimal={false} onKey={onPinKey} />
      </div>
    </div>
  );
}

export async function hasVault() {
  return Boolean(await loadVault());
}
