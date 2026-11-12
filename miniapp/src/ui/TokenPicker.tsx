import { useEffect, useState } from 'react';
import { api, TOKENS, usd, type Me, type Safety, type TokenRef } from '../api';
import { haptic } from '../tg';
import { Icon } from './Icons';
import { TokenIcon } from './TokenIcon';

const VERDICT: Record<Safety['verdict'], { text: string; color: string }> = {
  ok: { text: 'Low risk', color: 'var(--green-text)' },
  caution: { text: 'Some risk', color: 'var(--caution)' },
  high: { text: 'High risk', color: 'var(--caution)' },
  blocked: { text: 'Blocked', color: 'var(--danger)' },
};

/**
 * Choose what to trade: QMS, USDC, the tokens you hold, or any token by pasting its address. A pasted token is
 * safety-checked right here (the same simulated buy and sale as the chat) before it can be picked.
 */
export function TokenPicker({ me, onPick, onClose }: { me: Me; onPick: (t: TokenRef, safety?: Safety) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Safety | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // While the sheet is open, the page behind it stays still.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const addr = q.trim().match(/0x[0-9a-fA-F]{40}/)?.[0];
  useEffect(() => {
    setFound(null);
    setError(null);
    if (!addr) return;
    setChecking(true);
    let alive = true;
    api.token(addr).then((s) => alive && setFound(s)).catch((e) => alive && setError((e as Error).message)).finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, [addr]);

  async function paste() {
    try {
      setQ((await navigator.clipboard.readText()).trim());
      haptic.select();
    } catch {
      /* the field is there to paste into by hand */
    }
  }

  const held = (me.positions ?? []).map((p) => ({ ref: { address: p.token, symbol: p.symbol, decimals: p.decimals }, name: p.name, value: p.valueUsd }));
  const core = [
    { ref: TOKENS.QMS as TokenRef, name: 'QMS', value: me.holdings?.find((h) => h.symbol === 'QMS')?.valueUsd ?? 0 },
    { ref: TOKENS.USDC as TokenRef, name: 'USD Coin', value: me.holdings?.find((h) => h.symbol === 'USDC')?.valueUsd ?? 0 },
  ];

  const pick = (t: TokenRef, s?: Safety) => {
    haptic.select();
    onPick(t, s);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Choose a token" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <p className="title" style={{ textAlign: 'center' }}>Choose a token</p>

        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <input
            id="token-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Paste a token address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{ flex: 1, minWidth: 0, height: 48, borderRadius: 14, border: 0, background: 'var(--paper)', padding: '0 14px', fontSize: 15, color: 'var(--ink)' }}
          />
          <button className="chip" style={{ height: 48, borderRadius: 14, padding: '0 16px' }} onClick={paste}>Paste</button>
        </div>

        {addr && (
          <div className="surface" style={{ marginTop: 12, background: 'var(--paper)' }}>
            {checking && <div className="item" style={{ cursor: 'default' }}><span className="shimmer" style={{ width: 40, height: 40, borderRadius: 20 }} /><span className="sub">Checking this token: a simulated buy and sale…</span></div>}
            {error && <div className="item" style={{ cursor: 'default', color: 'var(--danger)', fontSize: 14 }}>{error}</div>}
            {found && (
              <button className="item" onClick={() => pick({ address: found.token.address, symbol: found.token.symbol, decimals: found.token.decimals }, found)}>
                <TokenIcon address={found.token.address} size={40} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: 500 }}>{found.token.symbol}</span>
                  <span className="sub" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{found.token.name}</span>
                </span>
                <span style={{ textAlign: 'right', flex: 'none' }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: VERDICT[found.verdict].color }}>{VERDICT[found.verdict].text}</span>
                  <span className="sub" style={{ display: 'block' }}>{found.verdict === 'blocked' ? 'Cannot be bought' : `Safety ${found.score}/100`}</span>
                </span>
              </button>
            )}
          </div>
        )}

        {!addr && (
          <>
            <p className="section" style={{ marginTop: 20 }}>Main</p>
            <div className="surface" style={{ background: 'var(--paper)' }}>
              {core.map((c) => (
                <button key={c.ref.address} className="item" onClick={() => pick(c.ref)}>
                  <TokenIcon address={c.ref.address} size={40} />
                  <span style={{ flex: 1 }}><span style={{ display: 'block', fontWeight: 500 }}>{c.ref.symbol}</span><span className="sub" style={{ display: 'block' }}>{c.name}</span></span>
                  <span className="num" style={{ fontWeight: 500 }}>${usd(c.value)}</span>
                </button>
              ))}
            </div>
            {held.length > 0 && (
              <>
                <p className="section">You hold</p>
                <div className="surface" style={{ background: 'var(--paper)' }}>
                  {held.map((h) => (
                    <button key={h.ref.address} className="item" onClick={() => pick(h.ref)}>
                      <TokenIcon address={h.ref.address} size={40} />
                      <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontWeight: 500 }}>{h.ref.symbol}</span><span className="sub" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span></span>
                      <span className="num" style={{ fontWeight: 500 }}>${usd(h.value)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <p className="muted" style={{ margin: '16px 4px 4px', fontSize: 13, lineHeight: 1.5, display: 'flex', gap: 8 }}><Icon name="shield" size={16} />Every token you paste is checked with a simulated buy and sale before you can buy it.</p>
          </>
        )}
      </div>
    </div>
  );
}
