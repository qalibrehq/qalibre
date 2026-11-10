import { useEffect, useState } from 'react';
import { api, fromUnits, tokenBy, type OrderRow } from '../api';
import { Back } from '../ui/Brand';
import type { Nav } from '../App';

const STATUS: Record<OrderRow['status'], { text: string; color: string }> = {
  pending: { text: 'In batch', color: 'var(--graphite)' },
  filled: { text: 'Filled', color: 'var(--green)' },
  expired: { text: 'Not filled', color: 'var(--caution)' },
  failed: { text: 'Not filled', color: 'var(--caution)' },
};

export function Activity({ nav }: { nav: Nav }) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  useEffect(() => {
    const load = () => api.orders().then((r) => setOrders(r.orders)).catch(() => setOrders([]));
    load();
    const t = setInterval(load, 4_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="screen fade-in">
      <div className="bar">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('home')}><Back /></button>
        <span className="label">Activity</span>
        <div style={{ width: 30 }} />
      </div>

      {orders && orders.length === 0 && (
        <div style={{ marginTop: 80, textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>No trades yet</p>
          <p className="muted" style={{ margin: '8px 0 24px', fontSize: 14 }}>Every trade you make gets a receipt here.</p>
          <button className="btn btn-green" onClick={() => nav('trade', { side: 'buy' })}>Make your first trade</button>
        </div>
      )}

      {orders && orders.length > 0 && (
        <div className="rows strong" style={{ marginTop: 28 }}>
          {orders.map((o) => {
            const sell = tokenBy(o.sell_token);
            const buy = tokenBy(o.buy_token);
            const s = STATUS[o.status];
            const filled = o.status === 'filled';
            return (
              <button
                key={o.id}
                onClick={() => filled && nav('receipt', { orderId: o.id })}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', border: 0, borderBottom: '1px solid var(--rule)', background: 'transparent', textAlign: 'left', cursor: filled ? 'pointer' : 'default' }}
              >
                <div className="grow">
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>{buy.symbol === 'QMS' ? 'Bought QMS' : 'Sold QMS'}</p>
                  <p className="muted num" style={{ margin: '2px 0 0', fontSize: 13 }}>
                    {fromUnits(o.sell_amount, sell.decimals)} {sell.symbol} · {new Date(o.created_at * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p className="num" style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>{filled ? `+${fromUnits(o.buy_amount ?? '0', buy.decimals)} ${buy.symbol}` : ''}</p>
                  <p className="label" style={{ margin: '3px 0 0', color: s.color }}>{s.text}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
