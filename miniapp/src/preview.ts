/**
 * Design preview (development only): open http://localhost:5173/?preview to see every screen with realistic
 * sample data, without Telegram or the server. Production builds never run this (import.meta.env.DEV is false).
 */
if (import.meta.env.DEV && new URLSearchParams(location.search).has('preview')) {
  const fresh = new URLSearchParams(location.search).has('new');
  const store = new Map<string, string>(fresh ? [] : [['qalibre_owner_v1', '{"v":1,"preview":true}']]);
  (window as unknown as { Telegram: unknown }).Telegram = {
    WebApp: {
      initData: 'preview',
      colorScheme: new URLSearchParams(location.search).has('dark') ? 'dark' : 'light',
      onEvent() {},
      initDataUnsafe: { user: { id: 1, first_name: 'Ada' } },
      version: '8.0',
      ready() {},
      expand() {},
      setHeaderColor() {},
      setBackgroundColor() {},
      disableVerticalSwipes() {},
      openLink(u: string) {
        window.open(u, '_blank');
      },
      close() {},
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
      CloudStorage: {
        setItem(k: string, v: string, cb?: (e: null, ok: boolean) => void) {
          store.set(k, v);
          cb?.(null, true);
        },
        getItem(k: string, cb: (e: null, v?: string) => void) {
          cb(null, store.get(k) ?? '');
        },
      },
      BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
    },
  };

  const now = Math.floor(Date.now() / 1000);
  const DOG = '0xb3b3426CDc928377e8221f9DB75CF3Fdd26a3763';
  const me = {
    registered: true,
    account: '0xDf8cF7BcF4091D5693863417881A53a6a1eB10eB',
    owner: '0x5a1b0000000000000000000000000000000c0ffe',
    firstName: 'Ada',
    price: { usdcPerQms: 3.37 },
    holdings: [
      { symbol: 'QMS', name: 'QMS', amount: 1.2483, valueUsd: 4.21, token: '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34' },
      { symbol: 'USDC', name: 'USD Coin', amount: 12.4, valueUsd: 12.4, token: '0xDfF68E53a0A8275212927c12017f5aB5f1842a04' },
    ],
    positions: [
      { symbol: 'QTDOG', name: 'Qalibre Test Dog (testnet)', token: DOG, decimals: 18, balance: '61540993180947721362412', amount: 61540.99, valueUsd: 0.034, pnlPct: 4.2 },
      // ?preview&many: a crowded wallet, with dust, to check the list stays short.
      ...(new URLSearchParams(location.search).has('many')
        ? [['PEPE', 3.2, 12.5], ['WIF', 1.4, -3.1], ['BONK', 0.9, 40.2], ['MOON', 0.12, -60], ['DUST1', 0.004, -90], ['DUST2', 0.0001, -99], ['CAT', 0.45, 8]].map(([sym, v, pnl], i) => ({ symbol: sym as string, name: sym as string, token: `0x${(i + 1).toString(16).padStart(40, '0')}`, decimals: 18, balance: '1000000000000000000000', amount: 1000, valueUsd: v as number, pnlPct: pnl as number }))
        : []),
    ],
    totalUsd: 16.64,
    savedUsd: 0.18,
    trades: 6,
    session: { active: true, validUntil: now + 26 * 86400, anyBuyToken: false },
    limits: [
      { token: '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34', symbol: 'QMS', decimals: 18, perTrade: 10, perDay: 50, spentToday: 0.06 },
      { token: '0xDfF68E53a0A8275212927c12017f5aB5f1842a04', symbol: 'USDC', decimals: 6, perTrade: 20, perDay: 100, spentToday: 2 },
    ],
    unwrappedQms: 0,
    testFundsAt: now - 10,
    invite: { link: 'https://t.me/QalibreBot?start=r_Hk3pQ', invited: 3, trading: 2, earnedQms: '4200000000000000', paidQms: '0', sharePct: 20, days: 90 },
    bot: 'QalibreBot',
  };
  const order = (id: string, sell: string, buy: string, sellAmt: string, buyAmt: string, direct: string, ago: number) => ({
    id, account: me.account, sell_token: sell, buy_token: buy, sell_amount: sellAmt, min_buy_amount: '0', max_network_fee: '0', network_fee: '1000',
    status: 'filled', reason: null, tx_hash: '0x9256cb74a331605ca4f5605267643c5c7e2e2d34a46fd5fda949031eac52f3f6', buy_amount: buyAmt, fee: '0', direct_quote: direct,
    batch_id: 3, created_at: now - ago, updated_at: now - ago, mode: 'instant',
  });
  const routes: Record<string, unknown> = {
    '/api/me': fresh ? { registered: false } : me,
    '/api/batch': { nextBatchInMs: 0, waiting: 0, batch: 3, intervalMs: 5000, lastRunAt: 0 },
    '/api/orders': {
      orders: [
        order('a1', me.holdings[0]!.token, DOG, '10000000000000000', '61540993180947721362412', '61540993277333879324505', 120),
        order('a2', me.holdings[1]!.token, me.holdings[0]!.token, '2000000', '593000000000000000', '590000000000000000', 3600 * 5),
      ],
    },
    '/api/quote': { direct: '2960000', minOut: '2945000', likely: '2975000', waiting: 1, maxNetworkFee: '9000', impactBps: 12 },
    '/api/token': {
      token: { address: DOG, symbol: 'QTDOG', name: 'Qalibre Test Dog (testnet)', decimals: 18, verified: false },
      verdict: 'high', score: 30, tradable: true, priceQms: 1.6e-7, priceUsd: 5.4e-7, liquidityUsd: 2.7, checkedAt: Date.now(),
      findings: [
        { level: 'pass', title: 'You can sell it', detail: 'A simulated buy and sale both went through.' },
        { level: 'caution', title: 'Small pool', detail: 'About $2.70 available to trade. Even small trades move the price.' },
        { level: 'danger', title: 'Wallets can be blacklisted', detail: 'The creator can block specific wallets from selling.' },
        { level: 'caution', title: 'Creator can mint more', detail: 'New tokens can be created, which dilutes holders.' },
      ],
    },
    '/api/stats': { savedUsd: 0.18, trades: 6, traders: 1, groups: 1, since: now - 86400, checked: 3, blocked: 2 },
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.startsWith('/api/orders/')) return new Response(JSON.stringify((routes['/api/orders'] as { orders: unknown[] }).orders[0]), { status: 200 });
    if (path.startsWith('/api/')) return new Response(JSON.stringify({ error: 'Preview: not available.' }), { status: 400 });
    return realFetch(input, init);
  };
}
export {};
