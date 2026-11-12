import { useState } from 'react';
import { isAddress, type Address } from 'viem';
import { fromUnits, toUnits, TOKENS, type Me, type Sym } from '../api';
import { actions, runOwnerAction } from '../owner';
import { haptic, openLink } from '../tg';
import { Back } from '../ui/Brand';
import { PinSheet } from '../ui/PinSheet';
import type { Nav } from '../App';

export function Send({ me, nav, toast, refresh }: { me: Me; nav: Nav; toast: (m: string) => void; refresh: () => void }) {
  const [sym, setSym] = useState<Sym>('USDC');
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [step, setStep] = useState<'form' | 'confirm' | 'done'>('form');
  const [tx, setTx] = useState<string | null>(null);
  const token = TOKENS[sym];
  const balance = me.holdings?.find((h) => h.symbol === sym)?.amount ?? 0;
  const units = amount ? toUnits(amount, token.decimals) : 0n;
  const balanceUnits = toUnits(balance.toFixed(token.decimals === 6 ? 6 : 8), token.decimals);
  const toOk = isAddress(to.trim());
  const self = to.trim().toLowerCase() === me.account?.toLowerCase();
  const amountOk = units > 0n && units <= balanceUnits;

  async function paste() {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      setTo(t);
      haptic.select();
    } catch {
      toast('Paste the address into the field.');
    }
  }

  if (step === 'confirm' && me.account) {
    return (
      <PinSheet
        title={`Send ${fromUnits(units, token.decimals, 6)} ${sym}`}
        summary={[
          { label: 'To', value: `${to.trim().slice(0, 8)}…${to.trim().slice(-6)}` },
          { label: 'Amount', value: `${fromUnits(units, token.decimals, 6)} ${sym}` },
          { label: 'Network', value: 'QMS testnet' },
        ]}
        onCancel={() => setStep('form')}
        onUnlocked={async (owner) => {
          const hash = await runOwnerAction(owner, me.account!, actions.send(token.address as Address, to.trim() as Address, units));
          setTx(hash);
          setStep('done');
          refresh();
        }}
      />
    );
  }

  if (step === 'done') {
    return (
      <div className="screen fade-in">
        <div style={{ marginTop: 'auto', marginBottom: 'auto', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="21" fill="var(--green)" /><path d="M14 22.5 L19.5 28 L30 17" fill="none" stroke="var(--paper)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <p style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.03em' }}>Sent</p>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{fromUnits(units, token.decimals, 6)} {sym} to {to.trim().slice(0, 8)}…{to.trim().slice(-6)}</p>
        </div>
        {tx && <button className="btn btn-line" style={{ marginBottom: 10 }} onClick={() => openLink(`https://testnet.qmsscan.io/tx/${tx}`)}>View on QMS Explorer</button>}
        <button className="btn btn-ink" onClick={() => nav('control')}>Done</button>
      </div>
    );
  }

  return (
    <div className="screen fade-in">
      <div className="bar">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('control')}><Back /></button>
        <span className="label">Send</span>
        <div style={{ width: 30 }} />
      </div>

      <div role="group" aria-label="Token" style={{ marginTop: 24, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', padding: 3, borderRadius: 10, background: 'var(--paper-2)' }}>
        {(['USDC', 'QMS'] as const).map((s) => (
          <button key={s} aria-pressed={sym === s} onClick={() => { haptic.select(); setSym(s); setAmount(''); }} style={{ height: 36, border: 0, borderRadius: 8, background: sym === s ? 'var(--white)' : 'transparent', fontSize: 14, fontWeight: sym === s ? 600 : 500, color: sym === s ? 'var(--ink)' : 'var(--graphite)', cursor: 'pointer' }}>{s}</button>
        ))}
      </div>

      <label style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--graphite)' }}>
        Amount
        <div style={{ display: 'flex', gap: 8 }}>
          <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} style={{ flex: 1, minWidth: 0, height: 54, borderRadius: 12, border: '1px solid var(--rule-strong)', background: 'var(--white)', padding: '0 14px', fontSize: 22, fontWeight: 600, fontFamily: 'var(--font)', color: 'var(--ink)' }} />
          <button onClick={() => setAmount(String(balance))} style={{ height: 54, padding: '0 16px', borderRadius: 12, border: '1px solid var(--rule-strong)', background: 'var(--white)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Max</button>
        </div>
        <span className="num">Available {balance.toLocaleString('en-US', { maximumFractionDigits: sym === 'USDC' ? 2 : 4 })} {sym}</span>
      </label>

      <label style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--graphite)' }}>
        To address
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" className="mono" style={{ flex: 1, minWidth: 0, height: 54, borderRadius: 12, border: `1px solid ${to && !toOk ? 'var(--danger)' : 'var(--rule-strong)'}`, background: 'var(--white)', padding: '0 14px', fontSize: 14, color: 'var(--ink)' }} />
          <button onClick={paste} style={{ height: 54, padding: '0 16px', borderRadius: 12, border: '1px solid var(--rule-strong)', background: 'var(--white)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Paste</button>
        </div>
        {to && !toOk && <span style={{ color: 'var(--danger)' }}>That is not a valid address.</span>}
        {self && <span style={{ color: 'var(--caution)' }}>That is your own Qalibre wallet.</span>}
      </label>

      <p className="muted" style={{ margin: '18px 0 0', fontSize: 13, lineHeight: 1.55 }}>Only send to an address on the QMS network. Transfers cannot be reversed.</p>

      <div className="spacer" style={{ paddingTop: 24 }}>
        <button className="btn btn-ink" disabled={!toOk || !amountOk || self} onClick={() => setStep('confirm')}>Review and sign</button>
      </div>
    </div>
  );
}
