import { fromUnits, usd, type Me } from '../api';
import { useState } from 'react';
import { haptic, openChat, openLink, setThemePref, themePref, type ThemePref } from '../tg';
import { Back } from '../ui/Brand';
import { Icon } from '../ui/Icons';
import { Avatar } from '../ui/Avatar';
import type { Nav } from '../App';

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** You: who you are on Qalibre, what you have done, and what your invites earn. */
export function Profile({ me, nav, toast }: { me: Me; nav: Nav; toast: (m: string) => void }) {
  const name = me.firstName ?? 'Your profile';
  const short = me.account ? `${me.account.slice(0, 6)}…${me.account.slice(-4)}` : '';
  const inv = me.invite;
  const [theme, setTheme] = useState<ThemePref>(themePref());

  async function copyWith(text: string, msg: string) {
    if (await copy(text)) {
      haptic.success();
      toast(msg);
    }
  }

  function share() {
    if (!inv) return;
    haptic.tap();
    const text = 'Trade on QMS with Qalibre: scam tokens blocked before you buy, never worse than a direct swap.';
    openLink(`https://t.me/share/url?url=${encodeURIComponent(inv.link)}&text=${encodeURIComponent(text)}`);
  }

  const stats: [string, string][] = [
    ['Trades', String(me.trades ?? 0)],
    ['Saved', `$${usd(me.savedUsd ?? 0)}`],
    ['Tokens', String((me.positions ?? []).length)],
  ];

  return (
    <div className="screen fade-in">
      <div className="bar">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('home')}><Back /></button>
        <span className="label">Profile</span>
        <div style={{ width: 30 }} />
      </div>

      <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <Avatar name={me.firstName} size={80} />
        <p style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>{name}</p>
        {me.account && (
          <button className="chip num" onClick={() => copyWith(me.account!, 'Wallet address copied.')}>
            {short}<Icon name="copy" size={15} />
          </button>
        )}
      </div>

      <div style={{ marginTop: 26, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        {stats.map(([k, v]) => (
          <div key={k} className="surface" style={{ padding: '16px 0', textAlign: 'center' }}>
            <p className="num" style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>{v}</p>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>{k}</p>
          </div>
        ))}
      </div>

      {inv && (
        <div style={{ marginTop: 14, borderRadius: 20, background: 'var(--green)', color: 'var(--on-green)', padding: '22px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="gift" size={20} />
            <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Invite friends</p>
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 30, fontWeight: 600, letterSpacing: '-0.03em' }}>{inv.sharePct}% of our fee</p>
          <p style={{ margin: '4px 0 0', fontSize: 14, opacity: 0.8, lineHeight: 1.45 }}>on every trade your friends make for {inv.days} days. They pay exactly the same.</p>
          <div style={{ marginTop: 18, display: 'flex', gap: 18, fontSize: 13, opacity: 0.85 }} className="num">
            <span><b style={{ fontSize: 15 }}>{inv.invited}</b> invited</span>
            <span><b style={{ fontSize: 15 }}>{inv.trading}</b> trading</span>
            <span><b style={{ fontSize: 15 }}>{fromUnits(inv.earnedQms, 18, 4)}</b> QMS earned</span>
          </div>
          <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
            <button onClick={share} style={{ height: 44, borderRadius: 12, border: 0, background: 'var(--on-green)', color: '#0F4D3A', fontSize: 15, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Icon name="share" size={18} />Share link</button>
            <button onClick={() => copyWith(inv.link, 'Invite link copied.')} style={{ height: 44, borderRadius: 12, border: '1px solid rgba(246,244,239,0.35)', background: 'transparent', color: 'var(--on-green)', fontSize: 15, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Icon name="copy" size={18} />Copy</button>
          </div>
        </div>
      )}

      <p className="section">Appearance</p>
      <div role="radiogroup" aria-label="Appearance" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', padding: 4, gap: 4, borderRadius: 16, background: 'var(--paper-2)' }}>
        {([['telegram', 'Auto'], ['light', 'Light'], ['dark', 'Dark']] as const).map(([k, label]) => (
          <button key={k} role="radio" aria-checked={theme === k} onClick={() => { haptic.select(); setTheme(k); setThemePref(k); }} style={{ height: 38, border: 0, borderRadius: 12, background: theme === k ? 'var(--white)' : 'transparent', color: theme === k ? 'var(--ink)' : 'var(--graphite)', fontSize: 14, fontWeight: theme === k ? 600 : 500, cursor: 'pointer' }}>
            {label}
          </button>
        ))}
      </div>
      <p className="muted" style={{ margin: '8px 4px 0', fontSize: 12 }}>Auto follows your Telegram theme.</p>

      <div className="surface" style={{ marginTop: 18 }}>
        {([
          ['wallet', 'Wallet and security', 'Keys, trading permission, backups', () => nav('control')],
          ['limits', 'Trading limits', 'How much Qalibre may trade for you', () => nav('limits')],
          ['activity', 'Activity', 'Every trade, with its receipt', () => nav('activity')],
          ['help', 'Help', 'How Qalibre works, fees and safety', () => openChat(me.bot)],
        ] as const).map(([icon, title, sub, go]) => (
          <button key={title} className="item" onClick={() => { haptic.select(); go(); }}>
            <span className="disc-sm"><Icon name={icon} size={20} /></span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 500 }}>{title}</span>
              <span className="sub" style={{ display: 'block' }}>{sub}</span>
            </span>
            <span className="chev"><Icon name="chevron" size={18} /></span>
          </button>
        ))}
      </div>
    </div>
  );
}
