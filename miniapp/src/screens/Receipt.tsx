import { useEffect, useState } from 'react';
import { api, fromUnits, tokenMeta, type Me, type OrderRow } from '../api';
import { openLink } from '../tg';
import { Close } from '../ui/Brand';
import { improvement } from './Trade';
import type { Nav } from '../App';

/** Whole numbers for large amounts, four decimals for small ones. */
function big(v: bigint, decimals: number) {
  const n = Number(v) / 10 ** decimals;
  return n >= 1000 ? Math.round(n).toLocaleString('en-US') : fromUnits(v, decimals, 4);
}

/** A charged fee is never shown as zero: tiny fees read "less than 0.0001". */
function feeText(v: string | null, decimals: number, symbol: string) {
  const x = BigInt(v ?? '0');
  if (x === 0n) return 'None';
  const shown = fromUnits(x, decimals, decimals === 6 ? 6 : 8);
  return /^0(\.0*)?$/.test(shown) ? `less than 0.0001 ${symbol}` : `${shown} ${symbol}`;
}

export function Receipt({ me, orderId, nav }: { me: Me; orderId: string; nav: Nav }) {
  const [o, setO] = useState<OrderRow | null>(null);
  useEffect(() => {
    api.orderById(orderId).then(setO).catch(() => nav('activity'));
  }, [orderId, nav]);
  if (!o) return <div className="screen" />;

  const meta = tokenMeta(me);
  const sell = meta(o.sell_token);
  const buy = meta(o.buy_token);
  const got = BigInt(o.buy_amount ?? '0');
  const direct = BigInt(o.direct_quote ?? '0');
  const fee = BigInt(o.fee ?? '0');
  const priced = got + BigInt(o.network_fee ?? '0'); // trade price, before the at-cost network fee
  const better = priced > direct ? priced - direct : 0n;
  const width = direct > 0n && priced > 0n ? Math.max(60, Math.min(100, Number((direct * 1000n) / priced) / 10)) : 100;
  const when = new Date(o.updated_at * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="screen fade-in">
      <div className="bar">
        <button className="icon-btn" aria-label="Close" onClick={() => nav('activity')}><Close /></button>
        <span className="label">Receipt{o.batch_id ? ` · Batch ${o.batch_id.toLocaleString('en-US')}` : ''}</span>
        <div style={{ width: 30 }} />
      </div>

      <div style={{ marginTop: 40, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>You received</p>
          <p className="num" style={{ margin: '8px 0 0', fontSize: 48, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 1 }}>+{big(got, buy.decimals)}</p>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 15 }}>{buy.symbol}, for {fromUnits(o.sell_amount, sell.decimals)} {sell.symbol}</p>
        </div>
        <svg className="jewel-in" width="60" height="60" viewBox="0 0 64 64" aria-hidden="true" style={{ animationDelay: '0.2s' }}>
          <circle cx="32" cy="32" r="30" fill="none" stroke="var(--jewel)" strokeWidth="1" />
          <circle cx="32" cy="32" r="25" fill="none" stroke="var(--jewel)" strokeWidth="0.6" strokeDasharray="1.5 2.4" />
          <circle cx="32" cy="32" r="9" fill="var(--jewel)" />
          <circle cx="32" cy="32" r="3.2" fill="var(--paper)" />
        </svg>
      </div>

      <div className="surface" style={{ marginTop: 28, padding: '18px 18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{improvement(o).replace('swapping directly', 'QWAP')}</p>
          {better > 0n && <p className="num green" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>+{fromUnits(better, buy.decimals, 6)}</p>}
        </div>
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="muted" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>Swapping directly on QWAP</span><span className="num">{fromUnits(direct, buy.decimals, 6)}</span></div>
            <div style={{ marginTop: 6, height: 4, background: 'var(--paper-2)' }}><div style={{ width: `${width}%`, height: 4, background: 'var(--muted)' }} /></div>
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>With Qalibre, before network fee</span><span className="num">{fromUnits(priced, buy.decimals, 6)}</span></div>
            <div style={{ marginTop: 6, height: 4, background: 'var(--paper-2)' }}><div style={{ width: '100%', height: 4, background: 'var(--green)' }} /></div>
          </div>
        </div>
      </div>

      <div className="rows" style={{ borderTop: 0 }}>
        <div className="row"><span>Qalibre fee</span><span className="num">{fee > 0n ? `${fromUnits(fee, buy.decimals, 6)} ${buy.symbol}, 20% of savings` : 'None'}</span></div>
        <div className="row"><span>Network fee, at cost</span><span className="num">{feeText(o.network_fee, buy.decimals, buy.symbol)}</span></div>
        <div className="row"><span>Settled</span><span>{when}</span></div>
      </div>

      <div className="spacer" style={{ paddingTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {o.tx_hash && (
          <button className="btn btn-line" onClick={() => openLink(`https://testnet.qmsscan.io/tx/${o.tx_hash}`)} style={{ fontWeight: 500, fontSize: 15 }}>
            Verify on QMS Explorer <span className="mono muted" style={{ fontSize: 12 }}>{o.tx_hash.slice(0, 6)}…{o.tx_hash.slice(-4)}</span>
          </button>
        )}
        <button className="btn btn-ink" onClick={() => nav('home')}>Done</button>
      </div>
    </div>
  );
}
