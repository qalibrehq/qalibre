import { useEffect, useState } from 'react';
import type { Me } from '../api';
import { haptic, openLink } from '../tg';
import { exportKey, loadVault, markBackedUp, WrongPin } from '../wallet';
import { Back, Wordmark } from '../ui/Brand';
import { Icon } from '../ui/Icons';
import { TabBar } from '../ui/TabBar';
import { Keypad } from '../ui/Keypad';
import { TestFundsButton } from '../ui/TestFunds';
import { PinSheet } from '../ui/PinSheet';
import { actions, runOwnerAction } from '../owner';
import { toUnits, TOKENS } from '../api';
import type { Address } from 'viem';
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

export function Control({ me, nav, toast, refresh, backupNow = false }: { me: Me; nav: Nav; toast: (m: string) => void; refresh: () => void; backupNow?: boolean }) {
  const [backup, setBackup] = useState<'closed' | 'pin' | 'shown'>('closed');
  const [permission, setPermission] = useState<'off' | 'on' | null>(null);
  const [pin, setPin] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const days = me.session ? Math.max(0, Math.round((me.session.validUntil * 1000 - Date.now()) / 86_400_000)) : 0;
  const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

  async function copyAddress() {
    if (!me.account) return;
    if (await copy(me.account)) {
      haptic.success();
      toast('Wallet address copied.');
    }
  }

  useEffect(() => {
    if (backupNow) void startBackup();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function startBackup() {
    if (!(await loadVault())) {
      toast('Open Qalibre from the Telegram account you created the wallet with.');
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

  if (permission && me.account) {
    const off = permission === 'off';
    // Turning back on restores the limits currently in the wallet (or the safe defaults), with a fresh trading key.
    const limits = (['QMS', 'USDC'] as const).map((s) => {
      const cur = me.limits?.find((l) => l.symbol === s);
      const t = TOKENS[s];
      const perTrade = cur && cur.perTrade > 0 ? cur.perTrade : s === 'QMS' ? 10 : 20;
      const perDay = cur && cur.perDay > 0 ? cur.perDay : s === 'QMS' ? 50 : 100;
      return { token: t.address as Address, perTrade: toUnits(String(perTrade), t.decimals), perDay: toUnits(String(perDay), t.decimals), label: `${perTrade} per trade, ${perDay} per day` };
    });
    return (
      <PinSheet
        title={off ? 'Turn off trading permission' : 'Turn trading permission on'}
        summary={
          off
            ? [{ label: 'Effect', value: 'Qalibre can no longer trade for you' }, { label: 'Your funds', value: 'Stay in your wallet' }]
            : [{ label: 'Valid for', value: '30 days' }, { label: 'QMS', value: limits[0]!.label }, { label: 'USDC', value: limits[1]!.label }]
        }
        onCancel={() => setPermission(null)}
        onUnlocked={async (owner) => {
          const callData = off ? actions.turnOff() : await actions.turnOn(limits.map(({ token, perTrade, perDay }) => ({ token, perTrade, perDay })));
          await runOwnerAction(owner, me.account!, callData);
          toast(off ? 'Trading permission is off. Qalibre can no longer trade for you.' : 'Trading permission is on, with a fresh trading key.');
          setPermission(null);
          refresh();
        }}
      />
    );
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
          <button className="btn btn-ink" onClick={() => { void markBackedUp(); haptic.success(); setKey(null); setBackup('closed'); toast('Backed up. Your wallet can always be recovered.'); }}>I’ve saved it</button>
        </div>
      </div>
    );
  }

  const active = Boolean(me.session?.active);
  const qmsLimit = me.limits?.find((l) => l.symbol === 'QMS');
  const Row = ({ icon, title, sub, right, onClick }: { icon: string; title: string; sub?: string; right?: React.ReactNode; onClick?: () => void }) => (
    <button className="item" onClick={onClick ? () => { haptic.select(); onClick(); } : undefined} style={onClick ? undefined : { cursor: 'default' }}>
      <span className="disc-sm"><Icon name={icon} size={20} /></span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 500 }}>{title}</span>
        {sub && <span className="sub" style={{ display: 'block' }}>{sub}</span>}
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
        {right}
        {onClick && <span className="chev" style={{ marginLeft: 0 }}><Icon name="chevron" size={18} /></span>}
      </span>
    </button>
  );

  return (
    <div className="screen fade-in" style={{ paddingBottom: 0 }}>
      <div className="bar">
        <span className="label" style={{ fontSize: 22, letterSpacing: '-0.02em' }}>Wallet</span>
      </div>

      <div style={{ marginTop: 18, borderRadius: 22, background: 'var(--green)', color: 'var(--on-green)', padding: '22px 22px 20px', display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Wordmark width={80} color="var(--on-green)" hole="var(--green)" />
          <span style={{ fontSize: 13, opacity: 0.75 }}>QMS testnet</span>
        </div>
        <div>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.72 }}>{me.firstName ? `${me.firstName}'s wallet` : 'Your wallet'}</p>
          <p className="num" style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>{short(me.account)}</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
          <button onClick={copyAddress} style={{ height: 42, borderRadius: 12, border: 0, background: 'var(--on-green)', color: '#0F4D3A', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Copy</button>
          <button onClick={() => nav('send')} style={{ height: 42, borderRadius: 12, border: '1px solid rgba(246,244,239,0.35)', background: 'transparent', color: 'var(--on-green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Send</button>
          <button onClick={() => me.account && openLink(`https://testnet.qmsscan.io/address/${me.account}`)} style={{ height: 42, borderRadius: 12, border: '1px solid rgba(246,244,239,0.35)', background: 'transparent', color: 'var(--on-green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Explorer</button>
        </div>
      </div>

      <p className="section">Trading from chat</p>
      <div className="surface">
        <Row
          icon="shield"
          title="Trading permission"
          sub={active ? `On for ${days} more days` : 'Off. Qalibre cannot trade for you'}
          right={<span className={active ? 'pill-on' : 'pill-off'} style={{ fontSize: 14 }}>{active ? 'On' : 'Off'}</span>}
          onClick={() => setPermission(active ? 'off' : 'on')}
        />
        <Row icon="limits" title="Limits" sub={qmsLimit ? `${qmsLimit.perTrade} QMS a trade, ${qmsLimit.perDay} a day` : 'Set how much Qalibre may trade'} onClick={() => nav('limits')} />
      </div>

      <p className="section">Security</p>
      <div className="surface">
        <Row icon="key" title="Back up your key" sub="Lets you use this wallet anywhere, even without Qalibre" onClick={startBackup} />
        <Row icon="shield" title="Owner key" sub={`${short(me.owner)} · locked with your PIN`} />
      </div>

      <p className="section">Test funds</p>
      <div className="surface">
        <TestFundsButton onDone={() => setTimeout(refresh, 1500)} toast={toast} />
        <Row icon="receive" title="QMS faucet" sub="More test QMS from the QMS team" onClick={() => openLink('https://faucet.testnet.qms.finance')} />
      </div>

      <p className="muted" style={{ margin: '16px 4px 0', fontSize: 13, lineHeight: 1.5 }}>Changes here are signed with your PIN and cost you nothing. Qalibre can never withdraw your money.</p>

      <TabBar current="control" nav={nav} />
    </div>
  );
}
