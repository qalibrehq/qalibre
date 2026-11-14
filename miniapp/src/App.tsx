import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Me, type TokenRef } from './api';
import { inTelegram, tg } from './tg';
import { hasVault, Onboarding } from './screens/Onboarding';
import { Home } from './screens/Home';
import { Trade } from './screens/Trade';
import { Receipt } from './screens/Receipt';
import { Activity } from './screens/Activity';
import { Control } from './screens/Control';
import { Limits } from './screens/Limits';
import { Send } from './screens/Send';
import { Approve } from './screens/Approve';
import { Profile } from './screens/Profile';
import { Wordmark } from './ui/Brand';
import { Splash } from './ui/Splash';

type Route = { name: 'home' } | { name: 'trade'; side: 'buy' | 'sell'; token?: TokenRef } | { name: 'receipt'; orderId: string } | { name: 'activity' } | { name: 'control'; backup?: boolean; fast?: boolean } | { name: 'limits' } | { name: 'send' } | { name: 'approve'; token: string; back?: 'trade' } | { name: 'profile' };
export type Nav = (name: Route['name'], params?: Record<string, string>) => void;

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [vault, setVault] = useState<boolean | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  // Deep links from the chat: ?approve=<token address> or ?screen=control|limits.
  const [route, setRoute] = useState<Route>(() => {
    const q = new URLSearchParams(window.location.search);
    const approve = q.get('approve');
    if (approve && /^0x[0-9a-fA-F]{40}$/.test(approve)) return { name: 'approve', token: approve };
    const screen = q.get('screen');
    if (screen === 'fast') return { name: 'control', fast: true };
    if (screen === 'control' || screen === 'limits' || screen === 'activity' || screen === 'profile') return { name: screen };
    return { name: 'home' };
  });
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // The opening moment plays once per session, and never holds the app back longer than it lasts (1.3 s).
  const [intro, setIntro] = useState(() => {
    try {
      return !sessionStorage.getItem('qalibre.intro');
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (!intro) return;
    // Development only: ?preview&splash holds the opening on screen for design review.
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('splash')) return;
    const t = window.setTimeout(() => {
      setIntro(false);
      try {
        sessionStorage.setItem('qalibre.intro', '1');
      } catch {
        /* private mode */
      }
    }, 1300);
    return () => clearTimeout(t);
  }, [intro]);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (e) {
      setFatal(e instanceof ApiError && e.status === 401 ? 'telegram' : (e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!inTelegram) {
      setFatal('telegram');
      return;
    }
    void refresh();
    void hasVault().then(setVault);
  }, [refresh]);

  // Refresh balances whenever the user returns to Home.
  useEffect(() => {
    if (route.name === 'home' && me?.registered) void refresh();
  }, [route.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Telegram's native back button mirrors in-app navigation.
  useEffect(() => {
    const back = tg?.BackButton;
    if (!back) return;
    // Sub-screens of Wallet go back to Wallet; everything else goes Home.
    const goBack = () => setRoute(route.name === 'limits' || route.name === 'send' ? { name: 'control' } : { name: 'home' });
    if (route.name === 'home') back.hide();
    else back.show();
    back.onClick(goBack);
    return () => back.offClick(goBack);
  }, [route.name]);

  const nav: Nav = useCallback((name, params = {}) => {
    window.scrollTo(0, 0);
    if (name === 'trade') setRoute({ name, side: params.side === 'sell' ? 'sell' : 'buy', token: params.token ? { address: params.token, symbol: params.symbol ?? '', decimals: Number(params.decimals ?? 18) } : undefined });
    else if (name === 'receipt') setRoute({ name, orderId: params.orderId ?? '' });
    else if (name === 'control') setRoute({ name, backup: params.backup === '1' });
    else if (name === 'approve') setRoute({ name, token: params.token ?? '', back: params.back === 'trade' ? 'trade' : undefined });
    else setRoute({ name } as Route);
  }, []);

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    window.setTimeout(() => setToastMsg(null), 3_600);
  }, []);

  if (fatal) {
    return (
      <div className="screen">
        <div className="bar"><Wordmark width={96} /></div>
        <div style={{ marginTop: 'auto', marginBottom: 'auto' }}>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.03em', margin: 0 }}>{fatal === 'telegram' ? 'Open Qalibre in Telegram' : 'We could not connect'}</h1>
          <p className="muted" style={{ fontSize: 15, lineHeight: 1.55 }}>
            {fatal === 'telegram' ? 'Qalibre runs inside Telegram. Message @QalibreBot and tap Open.' : fatal}
          </p>
          {fatal !== 'telegram' && <button className="btn btn-ink" onClick={() => { setFatal(null); void refresh(); }}>Try again</button>}
        </div>
      </div>
    );
  }

  if (intro || !me || vault === null) {
    return <div className="screen"><Splash /></div>;
  }

  if (!me.registered) {
    return <Onboarding resume={vault} upgraded={Boolean(me.upgraded)} onDone={() => { setVault(true); void refresh(); setRoute({ name: 'home' }); }} />;
  }

  return (
    <>
      {route.name === 'home' && <Home me={me} nav={nav} toast={toast} refresh={() => void refresh()} />}
      {route.name === 'trade' && <Trade me={me} nav={nav} side={route.side} token={route.token} toast={toast} refresh={() => void refresh()} />}
      {route.name === 'receipt' && <Receipt me={me} orderId={route.orderId} nav={nav} />}
      {route.name === 'activity' && <Activity me={me} nav={nav} />}
      {route.name === 'control' && <Control me={me} backupNow={route.backup} fastNow={route.fast} nav={nav} toast={toast} refresh={() => void refresh()} />}
      {route.name === 'limits' && <Limits me={me} nav={nav} toast={toast} refresh={() => void refresh()} />}
      {route.name === 'profile' && <Profile me={me} nav={nav} toast={toast} />}
      {route.name === 'approve' && <Approve me={me} token={route.token} back={route.back} nav={nav} />}
      {route.name === 'send' && <Send me={me} nav={nav} toast={toast} refresh={() => void refresh()} />}
      {toastMsg && <div className="toast" role="alert">{toastMsg}</div>}
    </>
  );
}
