import { useEffect, useRef, useState } from 'react';
import { api, fromUnits, toUnits, TOKENS, type Me, type OrderRow } from '../api';
import { haptic } from '../tg';
import { Back } from '../ui/Brand';
import { applyKey, Keypad } from '../ui/Keypad';
import type { Nav } from '../App';

type Phase = 'idle' | 'placing' | 'matching' | 'filled' | 'expired';

export function Trade({ me, nav, side: initialSide, toast }: { me: Me; nav: Nav; side: 'buy' | 'sell'; toast: (m: string) => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide);
  const sell = side === 'buy' ? TOKENS.USDC : TOKENS.QMS;
  const buy = side === 'buy' ? TOKENS.QMS : TOKENS.USDC;
  const [amount, setAmount] = useState('0');
  const [quote, setQuote] = useState<{ minOut: string; likely: string; direct: string } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  function chooseMode(m: 'instant' | 'best') {
    haptic.select();
    setMode(m);
    try {
      localStorage.setItem('qalibre_mode', m);
    } catch {
      /* ignore */
    }
  }
  const units = toUnits(amount, sell.decimals);
  const balance = me.holdings?.find((h) => h.symbol === sell.symbol)?.amount ?? 0;

  // Live quote, debounced.
  useEffect(() => {
    setError(null);
    if (units <= 0n) return setQuote(null);
    const t = setTimeout(() => {
      api.quote(sell.address, buy.address, units).then(setQuote).catch((e) => { setQuote(null); setError((e as Error).message); });
    }, 280);
    return () => clearTimeout(t);
  }, [units, sell.address, buy.address]);

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

  async function place() {
    if (units <= 0n) return;
    haptic.tap();
    setPhase('placing');
    setStartedAt(Date.now());
    setError(null);
    try {
      const r = await api.order(sell.address, buy.address, units, mode);
      setPhase('matching');
      follow(r.id);
    } catch (e) {
      haptic.warn();
      setPhase('idle');
      toast((e as Error).message);
    }
  }

  const len = amount.length;
  const size = len <= 3 ? 88 : len <= 5 ? 72 : len <= 7 ? 58 : 48;
  const prefix = sell.symbol === 'USDC' ? '$' : '';
  const suffix = sell.symbol === 'USDC' ? '' : ' QMS';

  return (
    <div className="screen fade-in">
      <div className="bar">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('home')}><Back /></button>
        <div role="group" aria-label="Order side" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', padding: 3, borderRadius: 10, background: 'var(--paper-2)', width: 168 }}>
          {(['buy', 'sell'] as const).map((s) => (
            <button key={s} aria-pressed={side === s} disabled={phase !== 'idle'} onClick={() => { haptic.select(); setSide(s); setAmount('0'); }} style={{ height: 32, border: 0, borderRadius: 8, background: side === s ? 'var(--white)' : 'transparent', color: side === s ? 'var(--ink)' : 'var(--graphite)', fontSize: 14, fontWeight: side === s ? 600 : 500, boxShadow: side === s ? '0 1px 2px rgba(17,18,20,0.08)' : 'none', cursor: 'pointer' }}>
              {s === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>
        <div style={{ width: 30 }} />
      </div>

      <div style={{ marginTop: 40, textAlign: 'center' }}>
        <p className="muted" style={{ margin: '0 0 14px', fontSize: 13 }}>{side === 'buy' ? 'Buy QMS with USDC' : 'Sell QMS for USDC'}</p>
        <p className="num" aria-live="polite" style={{ margin: 0, fontSize: size, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 1 }}>
          <span style={{ color: 'var(--muted)' }}>{prefix}</span>{amount}<span style={{ fontSize: size * 0.4, color: 'var(--muted)', letterSpacing: 0 }}>{suffix}</span>
        </p>
        <p className="muted num" style={{ margin: '10px 0 0', fontSize: 12 }}>
          Available {balance.toLocaleString('en-US', { maximumFractionDigits: sell.symbol === 'USDC' ? 2 : 4 })} {sell.symbol}
        </p>
      </div>

      <div className="rows" style={{ marginTop: 20 }}>
        <div className="row"><span>You receive at least</span><span className="num" style={{ fontWeight: 600 }}>{quote ? `${fromUnits(quote.minOut, buy.decimals)} ${buy.symbol}` : '–'}</span></div>
        <div className="row"><span>Likely, when matched</span><span className="num green" style={{ fontWeight: 600 }}>{quote ? `${fromUnits(quote.likely, buy.decimals)} ${buy.symbol}` : '–'}</span></div>
      </div>
      <p style={{ minHeight: 20, margin: '10px 0 0', fontSize: 13, color: 'var(--danger)' }}>{error ?? ''}</p>

      <div className="spacer">
        {phase === 'idle' && (
          <>
            <div role="radiogroup" aria-label="Execution" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 10 }}>
              {([
                ['instant', 'Instant', 'Next block, about 10 s'],
                ['best', 'Best price', 'Waits up to 5 s for a match'],
              ] as const).map(([m, title, sub]) => (
                <button key={m} role="radio" aria-checked={mode === m} onClick={() => chooseMode(m)} style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 10, border: mode === m ? '1.5px solid var(--ink)' : '1px solid var(--rule-strong)', background: mode === m ? 'var(--white)' : 'transparent', cursor: 'pointer' }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{title}</span>
                  <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>{sub}</span>
                </button>
              ))}
            </div>
            <Keypad onKey={(k) => setAmount((a) => applyKey(a, k, sell.symbol === 'USDC' ? 2 : 4))} />
            <button className="btn btn-green" style={{ marginTop: 14 }} disabled={units <= 0n || !quote} onClick={place}>
              {side === 'buy' ? 'Buy QMS' : 'Sell QMS'}
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
                {phase === 'placing' ? 'Placing your order' : mode === 'instant' ? 'Settling in the next block' : 'Matching with other traders'}
              </p>
              <p className="muted" style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.5 }}>
                {phase === 'placing'
                  ? 'Checking your limits and signing within them.'
                  : mode === 'instant'
                    ? 'Matched with anyone already waiting. The rest goes straight to QWAP.'
                    : 'Waiting a few seconds for traders on the other side. Only the unmatched part goes to QWAP.'}
              </p>
              <p className="mono muted num" style={{ margin: '14px 0 0', fontSize: 12 }}>{elapsed} s</p>
            </div>
          </div>
        )}

        {phase === 'filled' && order && (
          <div className="fade-in" style={{ height: 372, display: 'flex', flexDirection: 'column' }}>
            <div role="status" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, textAlign: 'center' }}>
              <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="21" fill="var(--green)" /><path d="M14 22.5 L19.5 28 L30 17" fill="none" stroke="var(--paper)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <p className="num" style={{ margin: 0, fontSize: 32, fontWeight: 600, letterSpacing: '-0.04em' }}>+{fromUnits(order.buy_amount ?? '0', buy.decimals)} {buy.symbol}</p>
              <p className="green" style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>{improvement(order)}</p>
              <p className="mono muted" style={{ margin: 0, fontSize: 12 }}>Filled in {elapsed} s</p>
            </div>
            <button className="btn btn-ink" onClick={() => nav('receipt', { orderId: order.id })}>View receipt</button>
            <button className="btn" style={{ marginTop: 6, height: 40, background: 'transparent', color: 'var(--graphite)', fontSize: 14, fontWeight: 500 }} onClick={() => { setPhase('idle'); setAmount('0'); setOrder(null); }}>New trade</button>
          </div>
        )}

        {phase === 'expired' && (
          <div className="fade-in" style={{ height: 372, display: 'flex', flexDirection: 'column' }}>
            <div role="status" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Not filled</p>
              <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{order?.reason ?? 'We could not fill it within your price limit, so nothing was traded. Your balance is unchanged.'}</p>
            </div>
            <button className="btn btn-ink" onClick={() => { setPhase('idle'); setOrder(null); }}>Try again</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function improvement(o: OrderRow): string {
  const got = BigInt(o.buy_amount ?? '0');
  const direct = BigInt(o.direct_quote ?? '0');
  if (direct <= 0n || got <= direct) return 'The same as a direct swap, with no Qalibre fee';
  const pct = Number(((got - direct) * 1_000_000n) / direct) / 10_000;
  return `${pct < 0.01 ? '<0.01' : pct.toFixed(2)}% more than swapping directly`;
}
