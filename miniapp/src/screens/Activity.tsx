import { useEffect, useState } from 'react';
import { api, fromUnits, TOKENS, type Me, type OrderRow } from '../api';
import { TokenIcon } from '../ui/TokenIcon';
import { TabBar } from '../ui/TabBar';
import { Skeleton } from '../ui/Splash';
import type { Nav } from '../App';

const STATUS: Record<OrderRow['status'], { text: string; color: string }> = {
  pending: { text: 'In batch', color: 'var(--graphite)' },
  filled: { text: 'Filled', color: 'var(--green-text)' },
  expired: { text: 'Not filled', color: 'var(--caution)' },
  failed: { text: 'Not filled', color: 'var(--caution)' },
};

const QMS = TOKENS.QMS.address.toLowerCase();
const USDC = TOKENS.USDC.address.toLowerCase();

/** Every token the user may have traded: QMS, USDC, and the tokens bought from chat. */
function tokenMeta(me: Me) {
  const m = new Map<string, { symbol: string; decimals: number }>([
    [QMS, { symbol: 'QMS', decimals: 18 }],
    [USDC, { symbol: 'USDC', decimals: 6 }],
  ]);
  for (const p of me.positions ?? []) m.set(p.token.toLowerCase(), { symbol: p.symbol, decimals: p.decimals });
  return (a: string) => m.get(a.toLowerCase()) ?? { symbol: `${a.slice(0, 6)}…`, decimals: 18 };
}

/** Whole numbers for large amounts, four decimals for small ones. */
function amount(v: string, decimals: number) {
  const n = Number(BigInt(v)) / 10 ** decimals;
  return n >= 1000 ? Math.round(n).toLocaleString('en-US') : fromUnits(v, decimals, 4);
}

function dayLabel(ts: number) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

export function Activity({ me, nav }: { me: Me; nav: Nav }) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const meta = tokenMeta(me);
  useEffect(() => {
    const load = () => api.orders().then((r) => setOrders(r.orders)).catch(() => setOrders([]));
    load();
    const t = setInterval(load, 4_000);
    return () => clearInterval(t);
  }, []);

  // Group by day, newest first.
  const groups: [string, OrderRow[]][] = [];
  for (const o of orders ?? []) {
    const k = dayLabel(o.created_at);
    const g = groups.find(([d]) => d === k);
    if (g) g[1].push(o);
    else groups.push([k, [o]]);
  }

  return (
    <div className="screen fade-in" style={{ paddingBottom: 0 }}>
      <div className="bar">
        <span className="label" style={{ fontSize: 22, letterSpacing: '-0.02em' }}>Activity</span>
      </div>

      {!orders && <div style={{ marginTop: 26 }}><Skeleton rows={4} /></div>}

      {orders && orders.length === 0 && (
        <div style={{ marginTop: 90, textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>No trades yet</p>
          <p className="muted" style={{ margin: '8px 0 24px', fontSize: 14 }}>Every trade you make gets a receipt here.</p>
          <button className="btn btn-green" onClick={() => nav('trade', { side: 'buy' })}>Make your first trade</button>
        </div>
      )}

      {groups.map(([day, list]) => (
        <div key={day}>
          <p className="section">{day}</p>
          <div className="surface">
            {list.map((o) => {
              const sell = meta(o.sell_token);
              const buy = meta(o.buy_token);
              // The trade is about the token that is not QMS (or QMS itself, when trading against USDC).
              const b = o.buy_token.toLowerCase();
              const sl = o.sell_token.toLowerCase();
              const core = (a: string) => a === QMS || a === USDC;
              // A trade is about its non-core token; between QMS and USDC it is about QMS.
              const buyIsSubject = !core(b) || (b === QMS && sl === USDC);
              const subjectAddr = buyIsSubject ? o.buy_token : o.sell_token;
              const subject = buyIsSubject ? buy : sell;
              const s = STATUS[o.status];
              const filled = o.status === 'filled';
              const time = new Date(o.created_at * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
              return (
                <button key={o.id} className="item" onClick={() => filled && nav('receipt', { orderId: o.id })} style={filled ? undefined : { cursor: 'default' }}>
                  <TokenIcon address={subjectAddr} size={40} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ margin: 0, fontWeight: 500 }}>{buyIsSubject ? 'Bought' : 'Sold'} {subject.symbol}</p>
                    <p className="sub num">{time}{!filled ? ` · ${s.text}` : ''}</p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {filled ? (
                      <>
                        <p className="num" style={{ margin: 0, fontWeight: 500 }}>+{amount(o.buy_amount ?? '0', buy.decimals)} {buy.symbol}</p>
                        <p className="sub num">−{amount(o.sell_amount, sell.decimals)} {sell.symbol}</p>
                      </>
                    ) : (
                      <p className="num" style={{ margin: 0, fontSize: 14, color: s.color, fontWeight: 500 }}>{s.text}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="spacer" />
      <TabBar current="activity" nav={nav} />
    </div>
  );
}
