import { useEffect, useRef, useState } from 'react';
import { api, usd, type BatchStatus, type Me } from '../api';
import { Wordmark } from '../ui/Brand';
import { Subdial } from '../ui/Subdial';
import type { Nav } from '../App';
import { TestFundsButton } from '../ui/TestFunds';

function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return setV(target);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setV(a + (target - a) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function useBatch() {
  const [b, setB] = useState<BatchStatus | null>(null);
  const [now, setNow] = useState(Date.now());
  const fetchedAt = useRef(Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => api.batch().then((x) => { if (alive) { setB(x); fetchedAt.current = Date.now(); } }).catch(() => {});
    load();
    const poll = setInterval(load, 5_000);
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => { alive = false; clearInterval(poll); clearInterval(tick); };
  }, []);
  if (!b) return null;
  const left = Math.max(0, b.nextBatchInMs - (now - fetchedAt.current));
  return { ...b, leftMs: left, progress: 1 - left / b.intervalMs };
}

export function Home({ me, nav, toast, refresh }: { me: Me; nav: Nav; toast: (m: string) => void; refresh: () => void }) {
  const total = useCountUp(me.totalUsd ?? 0);
  const batch = useBatch();
  const [whole, cents] = usd(total).split('.');
  const secs = batch ? Math.ceil(batch.leftMs / 1000) : null;

  return (
    <div className="screen fade-in" style={{ paddingBottom: 0 }}>
      <div className="bar">
        <Wordmark width={88} />
        <button className="btn-line" onClick={() => nav('control')} aria-label="Wallet" style={{ width: 36, height: 36, borderRadius: 18, border: '1px solid var(--rule-strong)', background: 'var(--white)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          {(me.firstName ?? 'Q').slice(0, 1).toUpperCase()}
        </button>
      </div>

      <p className="muted" style={{ margin: '48px 0 0', fontSize: 13 }}>Balance</p>
      <p className="num" aria-live="polite" style={{ margin: '8px 0 0', fontSize: 60, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 0.95 }}>
        ${whole}<span style={{ color: 'var(--muted)' }}>.{cents}</span>
      </p>
      <p className="muted" style={{ margin: '16px 0 0', fontSize: 15 }}>
        {me.trades ? (
          <><span className="green" style={{ fontWeight: 600 }}>+${usd(me.savedUsd ?? 0)} saved</span> compared with swapping directly</>
        ) : (
          'Your first trade is one tap away.'
        )}
      </p>

      <div style={{ marginTop: 32, display: 'flex', alignItems: 'center', gap: 16, padding: '16px 0', borderTop: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)' }}>
        <Subdial progress={batch?.progress ?? 0} label={secs !== null ? `Next batch in ${secs} seconds` : 'Next batch'} />
        <div className="grow">
          <p style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>
            {batch && batch.waiting > 0 ? <>Next batch within <span className="num">{`0:${String(secs ?? 0).padStart(2, '0')}`}</span></> : 'Ready to trade'}
          </p>
          <p className="muted" style={{ margin: '3px 0 0', fontSize: 13 }}>
            {batch ? (batch.waiting === 0 ? 'Instant orders settle in the next block' : `${batch.waiting} ${batch.waiting === 1 ? 'order' : 'orders'} waiting to be matched`) : 'Connecting'}
          </p>
        </div>
        {batch && <span className="mono muted" style={{ fontSize: 12 }}>#{batch.batch.toLocaleString('en-US')}</span>}
      </div>

      <div style={{ marginTop: 26 }}>
        <div className="muted" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, paddingBottom: 8 }}><span>Holdings</span><span>Value</span></div>
        <div className="rows">
          {(me.holdings ?? []).map((h) => (
            <div key={h.symbol} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--rule)' }}>
              <div style={{ width: 34, height: 34, borderRadius: 17, background: h.symbol === 'QMS' ? 'var(--ink)' : 'var(--white)', color: h.symbol === 'QMS' ? 'var(--paper)' : 'var(--ink)', border: h.symbol === 'QMS' ? 0 : '1px solid var(--rule-strong)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: h.symbol === 'QMS' ? 10 : 9, fontWeight: 700 }}>{h.symbol}</div>
              <div className="grow">
                <p style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>{h.name}</p>
                <p className="muted num" style={{ margin: '2px 0 0', fontSize: 13 }}>
                  {h.amount.toLocaleString('en-US', { maximumFractionDigits: h.symbol === 'USDC' ? 2 : 4 })}
                  {h.symbol === 'QMS' && me.price ? ` at $${me.price.usdcPerQms.toFixed(2)}` : ''}
                </p>
              </div>
              <p className="num" style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>${usd(h.valueUsd)}</p>
            </div>
          ))}
          {(me.positions ?? []).map((p) => (
            <div key={p.token} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--rule)' }}>
              <div style={{ width: 34, height: 34, borderRadius: 17, background: 'var(--paper-2)', color: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, overflow: 'hidden' }}>{p.symbol.slice(0, 4)}</div>
              <div className="grow" style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</p>
                <p className="muted num" style={{ margin: '2px 0 0', fontSize: 13 }}>{p.amount.toLocaleString('en-US', { maximumFractionDigits: p.amount >= 1000 ? 0 : 4 })} {p.symbol}</p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p className="num" style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>${usd(p.valueUsd)}</p>
                <p className="num" style={{ margin: '2px 0 0', fontSize: 12, color: p.pnlPct === null ? 'var(--graphite)' : p.pnlPct >= 0 ? 'var(--green)' : 'var(--danger)' }}>{p.pnlPct === null ? 'Cost unknown' : `${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%`}</p>
              </div>
            </div>
          ))}
          <TestFundsButton onDone={() => setTimeout(refresh, 1500)} toast={toast} />
        </div>
      </div>

      <div className="spacer" style={{ paddingTop: 24, paddingBottom: 18, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <button className="btn btn-green" onClick={() => nav('trade', { side: 'buy' })}>Buy</button>
        <button className="btn btn-line" onClick={() => nav('trade', { side: 'sell' })}>Sell</button>
      </div>

      <nav aria-label="Main" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', margin: '0 calc(-1 * var(--gutter))', padding: '10px var(--gutter) calc(14px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--rule)' }}>
        {([
          ['home', 'Home', 'M3.5 9.5 L11 3.5 L18.5 9.5 V18 H13.5 V13 H8.5 V18 H3.5 Z'],
          ['activity', 'Activity', 'M5 3.5 H17 V18.5 L14 16.8 L11 18.5 L8 16.8 L5 18.5 Z M8.5 8 H13.5 M8.5 11.5 H13.5'],
          ['control', 'Wallet', 'M3.5 6.5 H17.5 V17.5 H3.5 Z M3.5 6.5 L14.5 3.5 V6.5 M13.5 12 H17.5'],
        ] as const).map(([key, label, d]) => (
          <button key={key} onClick={() => nav(key)} aria-current={key === 'home' ? 'page' : undefined} style={{ border: 0, background: 'transparent', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '6px 0', fontSize: 11, fontWeight: key === 'home' ? 600 : 500, color: key === 'home' ? 'var(--ink)' : 'var(--graphite)', cursor: 'pointer' }}>
            <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
