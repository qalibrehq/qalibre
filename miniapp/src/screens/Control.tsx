import type { Me } from '../api';
import { openLink } from '../tg';
import { Back, Wordmark } from '../ui/Brand';
import type { Nav } from '../App';

export function Control({ me, nav }: { me: Me; nav: Nav }) {
  const days = me.session ? Math.max(0, Math.round((me.session.validUntil * 1000 - Date.now()) / 86_400_000)) : 0;
  const short = (a?: string) => (a ? `${a.slice(0, 6)} · · · ${a.slice(-4)}` : '');

  return (
    <div className="screen fade-in">
      <div className="bar">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('home')}><Back /></button>
        <span className="label">Control</span>
        <div style={{ width: 30 }} />
      </div>

      <div style={{ marginTop: 22, height: 188, borderRadius: 14, background: 'var(--green)', color: 'var(--paper)', padding: '20px 22px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 12px 24px -16px rgba(15,77,58,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Wordmark width={84} color="var(--paper)" hole="var(--green)" />
          <span className="mono" style={{ fontSize: 10, letterSpacing: '0.1em', opacity: 0.72 }}>POST-QUANTUM READY</span>
        </div>
        <div>
          <p style={{ margin: 0, fontSize: 12, opacity: 0.72 }}>Your wallet</p>
          <button onClick={() => me.account && openLink(`https://testnet.qmsscan.io/address/${me.account}`)} className="mono" style={{ margin: '4px 0 0', padding: 0, border: 0, background: 'transparent', color: 'var(--paper)', fontSize: 15, letterSpacing: '0.04em', cursor: 'pointer' }}>
            {short(me.account)}
          </button>
        </div>
      </div>

      <h1 style={{ margin: '28px 0 0', fontSize: 26, fontWeight: 600, letterSpacing: '-0.03em' }}>You're in charge.</h1>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.55 }}>Qalibre can only trade within these limits. It can never withdraw your money.</p>

      <div className="rows strong" style={{ marginTop: 18 }}>
        <div className="row"><span>Trading permission</span><span style={{ color: me.session?.active ? 'var(--green)' : 'var(--danger)', fontWeight: 600 }}>{me.session?.active ? `On · ${days} days left` : 'Off'}</span></div>
        <div className="row"><span>Per trade</span><span className="num">50 QMS or 100 USDC</span></div>
        <div className="row"><span>Per day</span><span className="num">200 QMS or 400 USDC</span></div>
        <div className="row"><span>Tokens it may buy</span><span>QMS, USDC</span></div>
        <div className="row"><span>Wallet owner</span><span className="mono" style={{ fontSize: 13 }}>{short(me.owner)}</span></div>
      </div>

      <p className="muted" style={{ margin: '16px 0 0', fontSize: 13, lineHeight: 1.55 }}>
        Editing limits, withdrawing and turning the permission off are signed with your PIN-protected key and arrive in the next update. Until then the permission expires on its own, and your funds can always be withdrawn directly through the verified wallet contract.
      </p>
    </div>
  );
}
