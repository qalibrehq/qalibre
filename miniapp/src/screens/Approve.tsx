import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { api, type Me, type Safety } from '../api';
import { actions, runOwnerAction } from '../owner';
import { haptic, openLink, tg } from '../tg';
import { Back } from '../ui/Brand';
import { PinSheet } from '../ui/PinSheet';
import type { Nav } from '../App';

const tone: Record<string, string> = { danger: 'var(--danger)', caution: 'var(--caution)', unknown: 'var(--graphite)', pass: 'var(--green)' };
const verdictLabel: Record<Safety['verdict'], string> = { ok: 'Low risk', caution: 'Some risk', high: 'High risk', blocked: 'Blocked' };

/**
 * One-time approval of a token for chat trading, opened from a chat card.
 * Signs one action on this phone: allow Qalibre to buy this token, and to sell it back to QMS.
 * The safety check is shown again here, so the decision is made with the facts in front of the user.
 */
export function Approve({ me, token, nav }: { me: Me; token: string; nav: Nav }) {
  const [s, setS] = useState<Safety | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'review' | 'sign' | 'done'>('review');
  const [ack, setAck] = useState(false);
  const [tx, setTx] = useState<string | null>(null);

  useEffect(() => {
    api.token(token).then(setS, (e: Error) => setError(e.message));
  }, [token]);

  const risky = s?.verdict === 'high';

  if (step === 'sign' && s && me.account) {
    return (
      <PinSheet
        title={`Approve ${s.token.symbol}`}
        summary={[
          { label: 'Token', value: `${s.token.symbol}  ${s.token.address.slice(0, 6)}…${s.token.address.slice(-4)}` },
          { label: 'Qalibre may', value: 'Buy it with QMS, sell it back to QMS' },
          { label: 'Spending', value: 'Within your QMS limits' },
        ]}
        onCancel={() => setStep('review')}
        onUnlocked={async (owner) => {
          const hash = await runOwnerAction(owner, me.account!, actions.approveToken(me.account as Address, s.token.address as Address));
          setTx(hash);
          haptic.success();
          setStep('done');
        }}
      />
    );
  }

  if (step === 'done' && s) {
    return (
      <div className="screen fade-in">
        <div style={{ marginTop: 'auto', marginBottom: 'auto', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="21" fill="var(--green)" /><path d="M14 22.5 L19.5 28 L30 17" fill="none" stroke="var(--paper)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <p style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.03em' }}>{s.token.symbol} approved</p>
          <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.55, maxWidth: 290 }}>Go back to the chat and tap Refresh on the card. You can now buy and sell {s.token.symbol} with one tap.</p>
        </div>
        {tx && <button className="btn btn-line" style={{ marginBottom: 10 }} onClick={() => openLink(`https://testnet.qmsscan.io/tx/${tx}`)}>View on QMS Explorer</button>}
        <button className="btn btn-ink" onClick={() => (tg?.close ? tg.close() : nav('home'))}>Back to chat</button>
      </div>
    );
  }

  return (
    <div className="screen fade-in">
      <div className="bar">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('home')}><Back /></button>
        <span className="label">Approve token</span>
        <div style={{ width: 30 }} />
      </div>

      {error && (
        <div style={{ marginTop: 'auto', marginBottom: 'auto' }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.03em', margin: 0 }}>This token cannot be approved</h1>
          <p className="muted" style={{ fontSize: 15, lineHeight: 1.55 }}>{error}</p>
        </div>
      )}
      {!s && !error && <p className="muted" style={{ marginTop: 40, fontSize: 14 }}>Checking this token. A simulated buy and sale is running…</p>}

      {s && (
        <>
          <h1 style={{ margin: '24px 0 0', fontSize: 28, fontWeight: 600, letterSpacing: '-0.03em' }}>{s.token.symbol}</h1>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>{s.token.name}</p>
          <p className="mono" style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--graphite)', wordBreak: 'break-all' }}>{s.token.address}</p>

          <div style={{ marginTop: 22, display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span className="num" style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-0.03em', color: s.verdict === 'ok' ? 'var(--green)' : s.verdict === 'caution' ? 'var(--caution)' : 'var(--danger)' }}>{s.verdict === 'blocked' ? 'Blocked' : s.score}</span>
            {s.verdict !== 'blocked' && <span className="muted" style={{ fontSize: 14 }}>/ 100 · {verdictLabel[s.verdict]}</span>}
          </div>

          <div className="rows" style={{ marginTop: 16 }}>
            {s.findings.map((f, i) => (
              <div key={i} className="row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 3 }}>
                <span style={{ color: tone[f.level], fontWeight: 600, fontSize: 14 }}>{f.title}</span>
                <span className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{f.detail}</span>
              </div>
            ))}
          </div>

          {s.tradable ? (
            <p className="muted" style={{ margin: '18px 0 0', fontSize: 13, lineHeight: 1.55 }}>
              Approving lets Qalibre buy {s.token.symbol} for you with QMS, and sell it back to QMS, from the chat. Spending stays inside your QMS limits, every trade gets at least a direct swap's price, and nothing can leave your wallet. A safety check reduces risk; it cannot guarantee a token is safe.
            </p>
          ) : (
            <p style={{ margin: '18px 0 0', fontSize: 14, lineHeight: 1.55, color: 'var(--danger)' }}>{s.reason}</p>
          )}

          {s.tradable && risky && (
            <label style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, lineHeight: 1.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={ack} onChange={(e) => { haptic.select(); setAck(e.target.checked); }} style={{ marginTop: 3, width: 18, height: 18, accentColor: 'var(--ink)' }} />
              I understand this token is high risk and I could lose what I put in.
            </label>
          )}

          <div className="spacer" style={{ paddingTop: 24 }}>
            <button className="btn btn-ink" disabled={!s.tradable || (risky && !ack)} onClick={() => setStep('sign')}>Approve with PIN</button>
          </div>
        </>
      )}
    </div>
  );
}
