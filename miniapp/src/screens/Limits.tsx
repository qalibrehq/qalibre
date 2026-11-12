import { useState } from 'react';
import type { Address } from 'viem';
import { toUnits, TOKENS, type Me } from '../api';
import { actions, runOwnerAction } from '../owner';
import { haptic } from '../tg';
import { Back } from '../ui/Brand';
import { PinSheet } from '../ui/PinSheet';
import type { Nav } from '../App';

const PRESETS = {
  Cautious: { QMS: [5, 25], USDC: [10, 50] },
  Standard: { QMS: [10, 50], USDC: [20, 100] },
  Active: { QMS: [50, 250], USDC: [100, 500] },
} as const;
type Preset = keyof typeof PRESETS;

export function Limits({ me, nav, toast, refresh }: { me: Me; nav: Nav; toast: (m: string) => void; refresh: () => void }) {
  const current = Object.fromEntries((me.limits ?? []).map((l) => [l.symbol, l])) as Record<string, { perTrade: number; perDay: number }>;
  const [vals, setVals] = useState({
    QMS: [String(current.QMS?.perTrade ?? 10), String(current.QMS?.perDay ?? 50)],
    USDC: [String(current.USDC?.perTrade ?? 20), String(current.USDC?.perDay ?? 100)],
  });
  const [confirming, setConfirming] = useState(false);

  const parsed = (['QMS', 'USDC'] as const).map((s) => {
    const t = TOKENS[s];
    const perTrade = Number(vals[s][0]);
    const perDay = Number(vals[s][1]);
    return { s, t, perTrade, perDay, ok: perTrade >= 0 && perDay >= 0 && perTrade <= perDay && Number.isFinite(perTrade) && Number.isFinite(perDay) };
  });
  const valid = parsed.every((p) => p.ok);

  function applyPreset(p: Preset) {
    haptic.select();
    setVals({ QMS: PRESETS[p].QMS.map(String), USDC: PRESETS[p].USDC.map(String) } as typeof vals);
  }

  if (confirming && me.account) {
    return (
      <PinSheet
        title="Update your limits"
        summary={parsed.flatMap((p) => [{ label: `${p.s} per trade`, value: `${p.perTrade}` }, { label: `${p.s} per day`, value: `${p.perDay}` }])}
        onCancel={() => setConfirming(false)}
        onUnlocked={async (owner) => {
          const limits = parsed.map((p) => ({ token: p.t.address as Address, perTrade: toUnits(String(p.perTrade), p.t.decimals), perDay: toUnits(String(p.perDay), p.t.decimals) }));
          await runOwnerAction(owner, me.account!, actions.editLimits(me.account as Address, limits));
          toast('Limits updated on your wallet.');
          refresh();
          nav('control');
        }}
      />
    );
  }

  return (
    <div className="screen fade-in">
      <div className="bar">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('control')}><Back /></button>
        <span className="label">Limits</span>
        <div style={{ width: 30 }} />
      </div>
      <h1 style={{ margin: '24px 0 0', fontSize: 26, fontWeight: 600, letterSpacing: '-0.03em' }}>How much may Qalibre trade?</h1>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.55 }}>These limits live in your wallet contract. Qalibre can never trade above them, and only you can change them.</p>

      <div role="group" aria-label="Presets" style={{ marginTop: 20, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        {(Object.keys(PRESETS) as Preset[]).map((p) => (
          <button key={p} onClick={() => applyPreset(p)} style={{ height: 40, borderRadius: 10, border: '1px solid transparent', background: 'var(--white)', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>{p}</button>
        ))}
      </div>

      {parsed.map((p) => (
        <div key={p.s} style={{ marginTop: 22 }}>
          <p className="label" style={{ margin: 0 }}>{p.s}</p>
          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
            {(['Per trade', 'Per day'] as const).map((label, i) => (
              <label key={label} style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--graphite)' }}>
                {label}
                <input
                  inputMode="decimal"
                  value={vals[p.s][i]}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9.]/g, '');
                    setVals((old) => ({ ...old, [p.s]: i === 0 ? [v, old[p.s][1]] : [old[p.s][0], v] }));
                  }}
                  style={{ height: 48, borderRadius: 10, border: `1px solid ${p.ok ? 'var(--rule-strong)' : 'var(--danger)'}`, background: 'var(--white)', padding: '0 12px', fontSize: 18, fontWeight: 600, fontFamily: 'var(--font)', color: 'var(--ink)' }}
                />
              </label>
            ))}
          </div>
          {!p.ok && <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--danger)' }}>The daily limit must be at least the per-trade limit.</p>}
        </div>
      ))}

      <div className="spacer" style={{ paddingTop: 24 }}>
        <button className="btn btn-ink" disabled={!valid} onClick={() => setConfirming(true)}>Review and sign</button>
      </div>
    </div>
  );
}
