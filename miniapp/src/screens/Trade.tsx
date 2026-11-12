import { useEffect, useRef, useState } from 'react';
import { api, ApiError, fromUnits, toUnits, TOKENS, type Me, type OrderRow, type Safety, type TokenRef } from '../api';
import { haptic } from '../tg';
import { Back } from '../ui/Brand';
import { Icon } from '../ui/Icons';
import { applyKey, Keypad } from '../ui/Keypad';
import { TokenIcon } from '../ui/TokenIcon';
import { TokenPicker } from '../ui/TokenPicker';
import type { Nav } from '../App';
import { TestFundsButton } from '../ui/TestFunds';

type Phase = 'idle' | 'placing' | 'matching' | 'filled' | 'expired';
const QMS = TOKENS.QMS as TokenRef;
const USDC = TOKENS.USDC as TokenRef;
const isQms = (t: TokenRef) => t.address.toLowerCase() === QMS.address.toLowerCase();
const isCore = (t: TokenRef) => isQms(t) || t.address.toLowerCase() === USDC.address.toLowerCase();

const VERDICT: Record<Safety['verdict'], { text: string; color: string }> = {
  ok: { text: 'Low risk', color: 'var(--green-text)' },
  caution: { text: 'Some risk', color: 'var(--caution)' },
  high: { text: 'High risk', color: 'var(--caution)' },
  blocked: { text: 'Blocked', color: 'var(--danger)' },
};

/**
 * Buy or sell one token. QMS trades against USDC; every other token trades against QMS, the same as in chat.
 * Amounts are typed in what you pay (buys) or what you sell (sells).
 */
export function Trade({ me, nav, side: initialSide, token: initialToken, toast, refresh }: { me: Me; nav: Nav; side: 'buy' | 'sell'; token?: TokenRef; toast: (m: string) => void; refresh: () => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide);
  const [asset, setAsset] = useState<TokenRef>(initialToken ?? QMS);
  const [safety, setSafety] = useState<Safety | null>(null);
  const [picking, setPicking] = useState(false);
  const counter = isQms(asset) ? USDC : asset.address.toLowerCase() === USDC.address.toLowerCase() ? QMS : QMS;
  const sell = side === 'buy' ? counter : asset;
  const buy = side === 'buy' ? asset : counter;
  const [amount, setAmount] = useState('0');
  const [quote, setQuote] = useState<{ minOut: string; likely: string; direct: string; maxNetworkFee: string; impactBps?: number } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmImpact, setConfirmImpact] = useState<number | null>(null);
  const [confirmRisk, setConfirmRisk] = useState(false);
  const [mode, setMode] = useState<'instant' | 'best'>(() => {
    try {
      return localStorage.getItem('qalibre_mode') === 'best' ? 'best' : 'instant';
    } catch {
      return 'instant';
    }
  });
  const [startedAt, setStartedAt] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (phase !== 'placing' && phase !== 'matching') return;
    const t = setInterval(() => setTick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [phase]);
  const elapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  void tick;

  // A non-core token shows its safety verdict; a blocked one cannot be bought.
  useEffect(() => {
    setSafety(null);
    if (isCore(asset)) return;
    api.token(asset.address).then(setSafety).catch(() => setSafety(null));
  }, [asset.address]);
  const blocked = side === 'buy' && safety?.verdict === 'blocked';

  function chooseMode(m: 'instant' | 'best') {
    haptic.select();
    setMode(m);
    try {
      localStorage.setItem('qalibre_mode', m);
    } catch {
      /* ignore */
    }
  }
  const dp = sell.decimals <= 6 ? 2 : 4;
  const units = toUnits(amount, sell.decimals);
  const balance = isQms(sell)
    ? (me.holdings?.find((h) => h.symbol === 'QMS')?.amount ?? 0) + (me.unwrappedQms ?? 0)
    : sell.address.toLowerCase() === USDC.address.toLowerCase()
      ? me.holdings?.find((h) => h.symbol === 'USDC')?.amount ?? 0
      : me.positions?.find((p) => p.token.toLowerCase() === sell.address.toLowerCase())?.amount ?? 0;
  const exactHeld = me.positions?.find((p) => p.token.toLowerCase() === sell.address.toLowerCase())?.balance;

  // Live quote, debounced.
  useEffect(() => {
    setError(null);
    if (units <= 0n || blocked) return setQuote(null);
    const t = setTimeout(() => {
      api.quote(sell.address, buy.address, units).then(setQuote).catch((e) => { setQuote(null); setError((e as Error).message); });
    }, 280);
    return () => clearTimeout(t);
  }, [units, sell.address, buy.address, blocked]);

  // Follow the order until it settles.
  const poll = useRef<number>();
  useEffect(() => () => window.clearInterval(poll.current), []);
  function follow(id: string) {
    window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      try {
        const o = await api.orderById(id);
        setOrder(o);
        if (o.status === 'filled') {
          window.clearInterval(poll.current);
          haptic.success();
          setPhase('filled');
          refresh();
        } else if (o.status === 'expired' || o.status === 'failed') {
          window.clearInterval(poll.current);
          haptic.warn();
          setPhase('expired');
        }
      } catch {
        /* keep polling */
      }
    }, 1_500);
  }

  async function place(acceptImpact = false, acceptRisk = false) {
    if (units <= 0n) return;
    // High-risk tokens need a second, deliberate tap, the same rule as in chat.
    if (side === 'buy' && safety?.verdict === 'high' && !acceptRisk) {
      haptic.warn();
      return setConfirmRisk(true);
    }
    setConfirmRisk(false);
    haptic.tap();
    setConfirmImpact(null);
    setPhase('placing');
    setStartedAt(Date.now());
    setError(null);
    try {
      const r = await api.order(sell.address, buy.address, units, mode, acceptImpact);
      setPhase('matching');
      follow(r.id);
    } catch (e) {
      setPhase('idle');
      if (e instanceof ApiError && e.code === 'needs_approval') {
        // One PIN approval for this token, then straight back here.
        return nav('approve', { token: String(e.data.token ?? asset.address), back: 'trade' });
      }
      if (e instanceof ApiError && e.code === 'high_impact') {
        haptic.warn();
        return setConfirmImpact(Number(e.data.impactBps ?? 0));
      }
      haptic.warn();
      toast((e as Error).message);
    }
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(asset.address);
      haptic.success();
      toast(`${asset.symbol} contract address copied.`);
    } catch {
      toast(asset.address);
    }
  }

  function pickToken(t: TokenRef, s?: Safety) {
    setPicking(false);
    setAsset(t);
    if (s) setSafety(s);
    setAmount('0');
    setQuote(null);
  }

  function max() {
    haptic.select();
    if (exactHeld && !isCore(sell)) return setAmount(fromUnits(exactHeld, sell.decimals, 4).replace(/,/g, ''));
    setAmount(String(Math.floor(balance * 10 ** dp) / 10 ** dp));
  }

  const len = amount.length;
  const size = len <= 3 ? 84 : len <= 5 ? 70 : len <= 7 ? 56 : 46;
  const prefix = sell.symbol === 'USDC' ? '$' : '';
  const suffix = sell.symbol === 'USDC' ? '' : ` ${sell.symbol}`;
  const verb = side === 'buy' ? 'Buy' : 'Sell';

  return (
    <div className="screen fade-in">
      {picking && <TokenPicker me={me} onPick={pickToken} onClose={() => setPicking(false)} />}
      <div className="bar">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('home')}><Back /></button>
        <div role="group" aria-label="Order side" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', padding: 3, borderRadius: 12, background: 'var(--paper-2)', width: 168 }}>
          {(['buy', 'sell'] as const).map((s) => (
            <button key={s} aria-pressed={side === s} disabled={phase !== 'idle'} onClick={() => { haptic.select(); setSide(s); setAmount('0'); }} style={{ height: 32, border: 0, borderRadius: 9, background: side === s ? 'var(--white)' : 'transparent', color: side === s ? 'var(--ink)' : 'var(--graphite)', fontSize: 14, fontWeight: side === s ? 600 : 500, boxShadow: side === s ? '0 1px 2px rgba(17,18,20,0.08)' : 'none', cursor: 'pointer' }}>
              {s === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>
        <div style={{ width: 30 }} />
      </div>

      <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
        <button className="chip" disabled={phase !== 'idle'} onClick={() => { haptic.select(); setPicking(true); }} style={{ height: 40, borderRadius: 20, padding: '0 14px 0 6px', gap: 8, background: 'var(--white)', fontSize: 15, fontWeight: 600 }} aria-label={`Token: ${asset.symbol}. Change`}>
          <TokenIcon address={asset.address} size={28} />
          {asset.symbol}
          <span style={{ transform: 'rotate(90deg)', display: 'flex', color: 'var(--graphite)' }}><Icon name="chevron" size={16} /></span>
        </button>
        {!isCore(asset) && (
          <button className="chip num" onClick={copyAddress} style={{ marginTop: 10, height: 26, fontSize: 12, padding: '0 10px', background: 'var(--paper-2)' }} aria-label={`Copy ${asset.symbol} contract address`}>
            {asset.address.slice(0, 6)}…{asset.address.slice(-4)}
            <Icon name="copy" size={13} />
          </button>
        )}
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>
          {verb} {asset.symbol} {side === 'buy' ? 'with' : 'for'} {counter.symbol}
          {safety && <> · <span style={{ color: VERDICT[safety.verdict].color, fontWeight: 600 }}>{VERDICT[safety.verdict].text}</span></>}
        </p>
        <p className="num" aria-live="polite" style={{ margin: '18px 0 0', fontSize: size, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 1 }}>
          <span style={{ color: 'var(--muted)' }}>{prefix}</span>{amount}<span style={{ fontSize: size * 0.36, color: 'var(--muted)', letterSpacing: 0 }}>{suffix}</span>
        </p>
        <p className="muted num" style={{ margin: '12px 0 0', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          Available {balance.toLocaleString('en-US', { maximumFractionDigits: balance >= 1000 ? 0 : dp })} {sell.symbol}
          {balance > 0 && phase === 'idle' && <button className="chip" style={{ height: 24, padding: '0 10px', fontSize: 12 }} onClick={max}>Max</button>}
        </p>
      </div>

      {blocked ? (
        <div className="surface" style={{ marginTop: 20, padding: '16px 18px' }}>
          <p style={{ margin: 0, fontWeight: 600, color: 'var(--danger)' }}>Qalibre blocks this token</p>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.5 }}>{safety?.reason}</p>
        </div>
      ) : (
        <div className="rows" style={{ marginTop: 20 }}>
          <div className="row"><span>You get at least</span><span className="num" style={{ fontWeight: 600 }}>{quote ? `${fromUnits(quote.minOut, buy.decimals)} ${buy.symbol}` : '–'}</span></div>
          <div className="row"><span>Likely, if matched</span><span className="num green" style={{ fontWeight: 600 }}>{quote ? `${fromUnits(quote.likely, buy.decimals)} ${buy.symbol}` : '–'}</span></div>
          <div className="row"><span>Network fee, at cost</span><span className="num" style={{ color: 'var(--ink)' }}>{quote ? `up to ${fromUnits(quote.maxNetworkFee, buy.decimals, buy.decimals === 6 ? 6 : 8)} ${buy.symbol}` : '–'}</span></div>
        </div>
      )}
      <p style={{ minHeight: 20, margin: '10px 0 0', fontSize: 13, color: 'var(--danger)' }}>{error ?? ''}</p>
      {phase === 'idle' && balance === 0 && isCore(sell) && <TestFundsButton variant="button" onDone={() => setTimeout(refresh, 1500)} toast={toast} />}

      <div className="spacer">
        {phase === 'idle' && confirmImpact !== null && (
          <div className="fade-in surface" style={{ padding: '18px 18px 14px', marginBottom: 10 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>This trade moves the price about {(confirmImpact / 100).toFixed(1)}%</p>
            <p className="muted" style={{ margin: '4px 0 14px', fontSize: 14, lineHeight: 1.5 }}>The pool is small, so a trade this size pushes the price against you. You still get at least what a direct swap would pay.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              <button className="btn btn-line" style={{ height: 46 }} onClick={() => setConfirmImpact(null)}>Change amount</button>
              <button className="btn btn-ink" style={{ height: 46 }} onClick={() => place(true, true)}>{verb} anyway</button>
            </div>
          </div>
        )}
        {phase === 'idle' && confirmRisk && safety && (
          <div className="fade-in surface" style={{ padding: '18px 18px 14px', marginBottom: 10 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>Careful: {asset.symbol} scores {safety.score}/100</p>
            <p className="muted" style={{ margin: '4px 0 14px', fontSize: 14, lineHeight: 1.5 }}>{safety.findings.filter((f) => f.level === 'caution' || f.level === 'danger').slice(0, 3).map((f) => f.title).join(' · ')}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              <button className="btn btn-line" style={{ height: 46 }} onClick={() => setConfirmRisk(false)}>Cancel</button>
              <button className="btn btn-ink" style={{ height: 46 }} onClick={() => place(false, true)}>Buy anyway</button>
            </div>
          </div>
        )}
        {phase === 'idle' && confirmImpact === null && !confirmRisk && (
          <>
            <div role="radiogroup" aria-label="Execution" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 10 }}>
              {([
                ['instant', 'Instant', 'Next block, about 10 s'],
                ['best', 'Best price', 'Waits up to 5 s for a match'],
              ] as const).map(([m, title, sub]) => (
                <button key={m} role="radio" aria-checked={mode === m} onClick={() => chooseMode(m)} style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 14, border: 0, outline: mode === m ? '1.5px solid var(--ink)' : 'none', background: mode === m ? 'var(--white)' : 'var(--paper-2)', cursor: 'pointer' }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{title}</span>
                  <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>{sub}</span>
                </button>
              ))}
            </div>
            <Keypad onKey={(k) => setAmount((a) => applyKey(a, k, dp))} />
            <button className="btn btn-green" style={{ marginTop: 14 }} disabled={units <= 0n || !quote || blocked} onClick={() => place(false)}>
              {verb} {asset.symbol}
            </button>
            <p className="muted" style={{ margin: '12px 0 0', textAlign: 'center', fontSize: 12 }}>Never less than swapping directly on QWAP. Checked on-chain.</p>
          </>
        )}

        {(phase === 'placing' || phase === 'matching') && (
          <div className="fade-in" role="status" style={{ height: 372, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, textAlign: 'center' }}>
            <svg width="100%" height="96" viewBox="0 0 334 96" aria-hidden="true">
              {[8, 34, 62, 88].map((y, i) => (
                <path key={y} className="draw" style={{ animationDelay: `${i * 0.12}s` }} d={`M0 ${y} C 100 ${y}, ${i === 0 || i === 3 ? 130 : 140} 48, 196 48`} fill="none" stroke="var(--ink)" strokeWidth="1" />
              ))}
              <path className="draw" style={{ animationDelay: '1.1s' }} d="M196 48 H334" fill="none" stroke="var(--green)" strokeWidth="2.2" />
              <g className="jewel-in" style={{ animationDelay: '0.9s' }}><circle cx="196" cy="48" r="6" fill="var(--jewel)" /><circle cx="196" cy="48" r="2" fill="var(--paper)" /></g>
            </svg>
            <div>
              <p style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em' }}>
                {phase === 'placing' ? 'Placing your order' : mode === 'instant' ? 'Settling in the next block' : 'Looking for a match'}
              </p>
              <p className="muted" style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.5 }}>
                {phase === 'placing'
                  ? 'Checking your limits and signing within them.'
                  : mode === 'instant'
                    ? 'Matched with anyone already waiting. The rest goes straight to QWAP.'
                    : 'Giving traders on the other side a few seconds. Only the unmatched part goes to QWAP.'}
              </p>
              <p className="muted num" style={{ margin: '14px 0 0', fontSize: 13 }}>{elapsed} s</p>
            </div>
          </div>
        )}

        {phase === 'filled' && order && (
          <div className="fade-in" style={{ height: 372, display: 'flex', flexDirection: 'column' }}>
            <div role="status" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, textAlign: 'center' }}>
              <Done />
              <p className="num" style={{ margin: 0, fontSize: 32, fontWeight: 600, letterSpacing: '-0.04em' }}>+{fromUnits(order.buy_amount ?? '0', buy.decimals)} {buy.symbol}</p>
              <p className="green" style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>{improvement(order)}</p>
              <p className="muted num" style={{ margin: 0, fontSize: 13 }}>Done in {elapsed} s</p>
            </div>
            <button className="btn btn-ink" onClick={() => nav('receipt', { orderId: order.id })}>View receipt</button>
            <button className="btn" style={{ marginTop: 6, height: 40, background: 'transparent', color: 'var(--graphite)', fontSize: 14, fontWeight: 500 }} onClick={() => { setPhase('idle'); setAmount('0'); setOrder(null); }}>New trade</button>
          </div>
        )}

        {phase === 'expired' && (
          <div className="fade-in" style={{ height: 372, display: 'flex', flexDirection: 'column' }}>
            <div role="status" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>That trade didn’t go through</p>
              <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{order?.reason ?? 'We couldn’t fill it within your price limit, so nothing was traded. Your balance hasn’t changed.'}</p>
            </div>
            <button className="btn btn-ink" onClick={() => { setPhase('idle'); setOrder(null); }}>Try again</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The success moment: a green disc that lands, then the check draws itself. */
export function Done({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="done">
      <circle cx="32" cy="32" r="30" fill="var(--green)" className="done-disc" />
      <path d="M20 33 L28 41 L44 24" fill="none" stroke="var(--paper)" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="done-check" />
    </svg>
  );
}

/** Trade price vs a direct swap, before the at-cost network fee (a direct swap pays its own gas too). */
export function improvement(o: OrderRow): string {
  const priced = BigInt(o.buy_amount ?? '0') + BigInt(o.network_fee ?? '0');
  const direct = BigInt(o.direct_quote ?? '0');
  if (direct <= 0n || priced <= direct) return 'QWAP’s own price, and no Qalibre fee';
  const pct = Number(((priced - direct) * 1_000_000n) / direct) / 10_000;
  return `${pct < 0.01 ? '<0.01' : pct.toFixed(2)}% more than swapping directly`;
}
