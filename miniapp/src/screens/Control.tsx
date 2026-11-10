import { useState } from 'react';
import type { Me } from '../api';
import { haptic, openLink } from '../tg';
import { exportKey, loadVault, WrongPin } from '../wallet';
import { Back, Wordmark } from '../ui/Brand';
import { Keypad } from '../ui/Keypad';
import type { Nav } from '../App';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(t);
    return ok;
  }
}

export function Control({ me, nav, toast }: { me: Me; nav: Nav; toast: (m: string) => void }) {
  const [backup, setBackup] = useState<'closed' | 'pin' | 'shown'>('closed');
  const [pin, setPin] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const days = me.session ? Math.max(0, Math.round((me.session.validUntil * 1000 - Date.now()) / 86_400_000)) : 0;
  const short = (a?: string | null) => (a ? `${a.slice(0, 6)} · · · ${a.slice(-4)}` : '');

  async function copyAddress() {
    if (!me.account) return;
    if (await copy(me.account)) {
      haptic.success();
      toast('Wallet address copied.');
    }
  }

  async function startBackup() {
    if (!(await loadVault())) {
      toast('Your wallet key is on the device where you created the wallet.');
      return;
    }
    setPin('');
    setPinError(null);
    setBackup('pin');
  }

  function onPinKey(k: string) {
    if (k === '.') return;
    if (k === 'del') return setPin((p) => p.slice(0, -1));
    const next = (pin + k).slice(0, 6);
    setPin(next);
    if (next.length === 6) {
      exportKey(next)
        .then((pk) => {
          setKey(pk);
          setBackup('shown');
        })
        .catch((e) => {
          haptic.warn();
          setPin('');
          setPinError(e instanceof WrongPin || /operation/i.test(String(e)) ? 'That PIN is not right.' : (e as Error).message);
        });
    }
  }

  if (backup === 'pin') {
    return (
      <div className="screen fade-in">
        <div className="bar">
          <button className="icon-btn" aria-label="Back" onClick={() => setBackup('closed')}><Back /></button>
          <span className="label">Back up key</span>
          <div style={{ width: 30 }} />
        </div>
        <h2 style={{ margin: '40px 0 0', fontSize: 26, fontWeight: 600, letterSpacing: '-0.03em' }}>Enter your PIN</h2>
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.55 }}>Your wallet key will be shown on this screen only. Make sure no one can see it.</p>
        <div style={{ marginTop: 36, display: 'flex', justifyContent: 'center', gap: 16 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} style={{ width: 12, height: 12, borderRadius: 6, background: i < pin.length ? 'var(--ink)' : 'transparent', border: '1px solid var(--ink)' }} />
          ))}
        </div>
        <p style={{ minHeight: 22, margin: '18px 0 0', textAlign: 'center', fontSize: 14, color: 'var(--danger)' }}>{pinError ?? ''}</p>
        <div className="spacer"><Keypad decimal={false} onKey={onPinKey} /></div>
      </div>
    );
  }

  if (backup === 'shown' && key) {
    return (
      <div className="screen fade-in">
        <div className="bar">
          <span className="label">Your wallet key</span>
        </div>
        <h2 style={{ margin: '32px 0 0', fontSize: 26, fontWeight: 600, letterSpacing: '-0.03em' }}>Keep this somewhere safe.</h2>
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.55 }}>
          With this key you can control your wallet from any device, even without Qalibre. Anyone who has it can take your funds. Qalibre will never ask for it.
        </p>
        <div className="mono" style={{ marginTop: 24, padding: 16, borderRadius: 12, border: '1px solid var(--rule-strong)', background: 'var(--white)', fontSize: 14, lineHeight: 1.7, wordBreak: 'break-all', userSelect: 'all' }}>{key}</div>
        <button className="btn btn-line" style={{ marginTop: 12 }} onClick={async () => { if (await copy(key)) { haptic.success(); toast('Key copied. Store it in a password manager, then clear your clipboard.'); } }}>Copy key</button>
        <div className="spacer" style={{ paddingTop: 20 }}>
          <button className="btn btn-ink" onClick={() => { setKey(null); setBackup('closed'); }}>I've saved it</button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen fade-in">
      <div className="bar">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('home')}><Back /></button>
        <span className="label">Wallet</span>
        <div style={{ width: 30 }} />
      </div>

      <div style={{ marginTop: 20, borderRadius: 14, background: 'var(--green)', color: 'var(--paper)', padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 30, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 12px 24px -16px rgba(15,77,58,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Wordmark width={84} color="var(--paper)" hole="var(--green)" />
          <span className="mono" style={{ fontSize: 10, letterSpacing: '0.1em', opacity: 0.72 }}>POST-QUANTUM READY</span>
        </div>
        <div>
          <p style={{ margin: 0, fontSize: 12, opacity: 0.72 }}>{me.firstName ? `${me.firstName}'s wallet` : 'Your wallet'} · QMS testnet</p>
          <p className="mono" style={{ margin: '6px 0 0', fontSize: 13, letterSpacing: '0.02em', wordBreak: 'break-all', lineHeight: 1.5 }}>{me.account}</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
          <button onClick={copyAddress} style={{ height: 40, borderRadius: 10, border: 0, background: 'var(--paper)', color: 'var(--green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Copy address</button>
          <button onClick={() => me.account && openLink(`https://testnet.qmsscan.io/address/${me.account}`)} style={{ height: 40, borderRadius: 10, border: '1px solid rgba(246,244,239,0.4)', background: 'transparent', color: 'var(--paper)', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>View on Explorer</button>
        </div>
      </div>

      <div className="rows strong" style={{ marginTop: 24 }}>
        <div className="row"><span>Receive</span><span style={{ color: 'var(--ink)', textAlign: 'right' }}>Send QMS-testnet WQMS or USDC to the address above</span></div>
        <button className="row" onClick={() => openLink('https://faucet.testnet.qms.finance')} style={{ border: 0, borderBottom: '1px solid var(--rule)', background: 'transparent', width: '100%', cursor: 'pointer' }}><span>Free test QMS</span><span className="green" style={{ fontWeight: 500 }}>Open faucet</span></button>
        <button className="row" onClick={startBackup} style={{ border: 0, borderBottom: '1px solid var(--rule)', background: 'transparent', width: '100%', cursor: 'pointer' }}><span>Wallet key</span><span className="green" style={{ fontWeight: 500 }}>Back up</span></button>
      </div>

      <h2 style={{ margin: '30px 0 0', fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>You're in charge.</h2>
      <p className="muted" style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.55 }}>Qalibre can only trade within these limits. It can never withdraw your money.</p>
      <div className="rows strong" style={{ marginTop: 14 }}>
        <div className="row"><span>Trading permission</span><span style={{ color: me.session?.active ? 'var(--green)' : 'var(--danger)', fontWeight: 600 }}>{me.session?.active ? `On · ${days} days left` : 'Off'}</span></div>
        <div className="row"><span>Per trade</span><span className="num" style={{ color: 'var(--ink)' }}>50 QMS or 100 USDC</span></div>
        <div className="row"><span>Per day</span><span className="num" style={{ color: 'var(--ink)' }}>200 QMS or 400 USDC</span></div>
        <div className="row"><span>Wallet owner</span><span className="mono" style={{ fontSize: 13, color: 'var(--ink)' }}>{short(me.owner)}</span></div>
      </div>
      <p className="muted" style={{ margin: '14px 0 0', fontSize: 12, lineHeight: 1.55 }}>
        Editing limits, withdrawing and turning the permission off arrive in the next update, signed with your PIN-protected key. The permission also expires on its own.
      </p>
    </div>
  );
}
