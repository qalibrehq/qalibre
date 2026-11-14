import { useEffect, useRef, useState } from 'react';
import { api, usd, type BatchStatus, type Me } from '../api';
import { haptic, openChat } from '../tg';
import { Wordmark } from '../ui/Brand';
import { Icon } from '../ui/Icons';
import { TokenIcon } from '../ui/TokenIcon';
import { Avatar } from '../ui/Avatar';
import { TabBar } from '../ui/TabBar';
import { TestFundsButton } from '../ui/TestFunds';
import type { Nav } from '../App';
import { isBackedUp } from '../wallet';

function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return setV(target);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      // The first frame can be timestamped just before start; never let progress go below zero.
      const t = Math.min(1, Math.max(0, (now - start) / ms));
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

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function Home({ me, nav, toast, refresh }: { me: Me; nav: Nav; toast: (m: string) => void; refresh: () => void }) {
  const total = useCountUp(me.totalUsd ?? 0);
  const [whole, cents] = usd(total).split('.');
  const saved = me.savedUsd ?? 0;

  async function receive() {
    haptic.tap();
    if (me.account && (await copy(me.account))) toast('Address copied. Send QMS or USDC on QMS testnet to it.');
    else nav('control');
  }

  const holdings = [
    ...(me.holdings ?? []).map((h) => ({ key: h.token, symbol: h.symbol, decimals: h.symbol === 'USDC' ? 6 : 18, name: h.name, line: `${h.amount.toLocaleString('en-US', { maximumFractionDigits: h.symbol === 'USDC' ? 2 : 4 })} ${h.symbol}`, value: h.valueUsd, change: null as number | null })),
    // Tokens by value, largest first; QMS and USDC (above) always lead.
    ...[...(me.positions ?? [])].sort((a, b) => b.valueUsd - a.valueUsd).map((p) => ({ key: p.token, symbol: p.symbol, decimals: p.decimals, name: p.symbol, line: `${p.amount.toLocaleString('en-US', { maximumFractionDigits: p.amount >= 1000 ? 0 : 4 })} ${p.symbol}`, value: p.valueUsd, change: p.pnlPct })),
  ];
  // A short list by default: at most five rows, and dust (tokens worth under a cent) only when expanded.
  const [showAll, setShowAll] = useState(false);
  const isCore = (s: string) => s === 'QMS' || s === 'USDC';
  const collapsed = holdings.filter((x) => isCore(x.symbol) || x.value >= 0.01).slice(0, 5);
  const visible = showAll ? holdings : collapsed;
  const hiddenCount = holdings.length - collapsed.length;

  const [needsBackup, setNeedsBackup] = useState(false);
  useEffect(() => {
    let alive = true;
    void isBackedUp().then((done) => alive && setNeedsBackup(!done));
    return () => { alive = false; };
  }, []);

  return (
    <div className="screen fade-in" style={{ paddingBottom: 0 }}>
      <div className="bar">
        <Wordmark width={84} />
        <button onClick={() => { haptic.select(); nav('profile'); }} aria-label="Profile" style={{ width: 38, height: 38, padding: 0, borderRadius: 19, border: 0, background: 'transparent', cursor: 'pointer' }}>
          <Avatar name={me.firstName} size={38} />
        </button>
      </div>

      <div style={{ marginTop: 40, textAlign: 'center' }}>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>Total balance</p>
        <p className="num" aria-live="polite" style={{ margin: '10px 0 0', fontSize: 56, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 1 }}>
          ${whole}<span style={{ color: 'var(--muted)' }}>.{cents}</span>
        </p>
        <p style={{ margin: '12px 0 0', fontSize: 14, minHeight: 20 }}>
          {saved >= 0.01 ? (
            <><span className="green" style={{ fontWeight: 600 }}>${usd(saved)} saved</span><span className="muted"> versus swapping directly</span></>
          ) : !me.trades ? (
            <span className="muted">Your first trade is one tap away</span>
          ) : null}
        </p>
      </div>

      <div className="actions" style={{ marginTop: 30 }}>
        <button className="action primary" onClick={() => nav('trade', { side: 'buy' })}><span className="disc"><Icon name="buy" /></span>Buy</button>
        <button className="action" onClick={() => nav('trade', { side: 'sell' })}><span className="disc"><Icon name="sell" /></span>Sell</button>
        <button className="action" onClick={receive}><span className="disc"><Icon name="receive" /></span>Receive</button>
        <button className="action" onClick={() => nav('send')}><span className="disc"><Icon name="send" /></span>Send</button>
      </div>

      {needsBackup && (
        <button className="nudge" onClick={() => { haptic.select(); nav('control', { backup: '1' }); }}>
          <span className="nudge-icon"><Icon name="key" size={20} /></span>
          <span style={{ minWidth: 0 }}>
            <b>Back up your wallet key</b>
            <span>Your PIN can’t be reset. Your key is the way back in.</span>
          </span>
          <span className="chev"><Icon name="chevron" size={18} /></span>
        </button>
      )}

      <p className="section">Holdings</p>
      <div className="surface">
        {visible.map((h) => (
          <button key={h.key} className="item" onClick={() => { haptic.select(); nav('trade', { side: h.symbol === 'USDC' ? 'sell' : 'buy', token: h.symbol === 'USDC' ? '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34' : h.key, symbol: h.symbol === 'USDC' ? 'QMS' : h.symbol, decimals: String(h.symbol === 'USDC' ? 18 : h.decimals) }); }}>
            <TokenIcon address={h.key} size={40} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ margin: 0, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</p>
              <p className="sub num">{h.line}</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <p className="num" style={{ margin: 0, fontWeight: 500 }}>${usd(h.value)}</p>
              {h.change !== null && (
                <p className="num" style={{ margin: '2px 0 0', fontSize: 13, color: h.change >= 0 ? 'var(--green-text)' : 'var(--danger)' }}>{`${h.change >= 0 ? '+' : '−'}${Math.abs(h.change).toFixed(1)}%`}</p>
              )}
            </div>
          </button>
        ))}
        {hiddenCount > 0 && (
          <button className="item" onClick={() => { haptic.select(); setShowAll(!showAll); }} style={{ justifyContent: 'center', color: 'var(--graphite)', fontSize: 14, fontWeight: 500 }}>
            {showAll ? 'Show less' : `Show ${hiddenCount} more`}
          </button>
        )}
        <TestFundsButton onDone={() => setTimeout(refresh, 1500)} toast={toast} />
      </div>

      <button onClick={() => { haptic.tap(); openChat(me.bot); }} className="surface" style={{ marginTop: 14, width: '100%', border: 0, padding: '18px 18px', display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left', cursor: 'pointer', background: 'var(--green)', color: 'var(--on-green)' }}>
        <span style={{ width: 40, height: 40, borderRadius: 20, background: 'rgba(246,244,239,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><Icon name="chat" size={20} /></span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>Trade any token from chat</span>
          <span style={{ display: 'block', fontSize: 13, marginTop: 2, opacity: 0.78 }}>Paste a token address. We check it, you buy in one tap.</span>
        </span>
        <span style={{ marginLeft: 'auto', opacity: 0.7, flex: 'none' }}><Icon name="chevron" size={18} /></span>
      </button>

      <TabBar current="home" nav={nav} />
    </div>
  );
}
