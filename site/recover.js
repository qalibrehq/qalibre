// Qalibre recovery: move everything from a Qalibre wallet to its owner account.
// Runs entirely in the browser. Talks only to the user's own wallet (EIP-1193), which talks to the QMS network.
// No Qalibre server, no key handling, no dependencies. Every call it makes is listed below.
(() => {
  'use strict';

  const CHAIN = {
    chainId: '0x4c18', // 19480
    chainName: 'QMS Testnet',
    nativeCurrency: { name: 'QMS', symbol: 'QMS', decimals: 18 },
    rpcUrls: ['https://rpc.testnet.qms.finance'],
    blockExplorerUrls: ['https://testnet.qmsscan.io'],
  };
  const EXPLORER = 'https://testnet.qmsscan.io';
  const FACTORY = '0xC443B86882C67f42EafC136591964FfC82997154';
  const KNOWN = [
    { address: '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34', symbol: 'WQMS', decimals: 18, note: 'Wrapped QMS, 1:1 with QMS' },
    { address: '0xDfF68E53a0A8275212927c12017f5aB5f1842a04', symbol: 'USDC', decimals: 6, note: 'USD Coin' },
  ];
  const NATIVE = '0x0000000000000000000000000000000000000000';
  // Function selectors (first 4 bytes of keccak256 of the signature).
  const SEL = {
    owner: '0x8da5cb5b', // owner()
    withdrawToOwner: '0x47c62a0d', // withdrawToOwner(address,uint256)
    balanceOf: '0x70a08231', // balanceOf(address)
    symbol: '0x95d89b41', // symbol()
    decimals: '0x313ce567', // decimals()
    getAddress: '0x8cb84e18', // getAddress(address,uint256) on the account factory
  };
  const MIN_GAS_WEI = 10n ** 14n; // 0.0001 QMS: below this, a transfer will likely fail for lack of fee

  const $ = (name) => document.querySelector(`[data-el="${name}"]`);
  const step = (name) => document.querySelector(`[data-step="${name}"]`);
  const state = { provider: null, account: null, wallet: null, tokens: [], busy: false };

  // ---------- encoding helpers ----------
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
  const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const encAddr = (a) => word(a);
  const encUint = (n) => word(BigInt(n).toString(16));
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const toBig = (hex) => (!hex || hex === '0x' ? 0n : BigInt(hex));
  const decodeAddr = (hex) => (hex && hex.length >= 66 ? '0x' + hex.slice(-40) : null);
  function decodeString(hex) {
    const h = (hex || '').replace(/^0x/, '');
    if (h.length < 64) return '';
    try {
      if (h.length >= 128 && BigInt('0x' + h.slice(0, 64)) === 32n) {
        const len = Number(BigInt('0x' + h.slice(64, 128)));
        const bytes = h.slice(128, 128 + len * 2);
        return new TextDecoder().decode(new Uint8Array(bytes.match(/../g)?.map((b) => parseInt(b, 16)) ?? []));
      }
      // bytes32-style symbol
      const bytes = h.slice(0, 64).match(/../g).map((b) => parseInt(b, 16)).filter((b) => b);
      return new TextDecoder().decode(new Uint8Array(bytes));
    } catch {
      return '';
    }
  }
  const clean = (s) => s.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 16) || 'Token';
  function fmt(v, decimals) {
    const base = 10n ** BigInt(decimals);
    const whole = v / base;
    let frac = (v % base).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
    if (!frac && v > 0n && whole === 0n) return '< 0.000001';
    return whole.toLocaleString('en-US') + (frac ? '.' + frac : '');
  }

  // ---------- provider ----------
  const rpc = (method, params = []) => state.provider.request({ method, params });
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

  // ---------- wallet picker ----------
  // Installed wallets announce themselves (EIP-6963) with their own name and official icon, so the
  // picker shows real logos without loading anything from elsewhere.
  const GLYPH = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 9.5h18M16 14h2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const ARROW = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const here = encodeURIComponent('https://qalibre.app/recover');
  const SUGGEST = mobile
    ? [
        { name: 'MetaMask', href: 'https://metamask.app.link/dapp/qalibre.app/recover', action: 'Open in app' },
        { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${here}`, action: 'Open in app' },
        { name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${here}`, action: 'Open in app' },
      ]
    : [
        { name: 'MetaMask', href: 'https://metamask.io/download/', action: 'Install' },
        { name: 'Rabby', href: 'https://rabby.io/', action: 'Install' },
        { name: 'Coinbase Wallet', href: 'https://www.coinbase.com/wallet/downloads', action: 'Install' },
      ];
  const found = new Map();
  // Only inline image data from the wallet itself; never a remote URL.
  // Wallets are not always tidy: Phantom pads its icon with a newline, Magic Eden labels a PNG as
  // "image/png+xml". Normalize, then accept only inline image data, never a remote URL.
  const safeIcon = (src) => {
    const s = (typeof src === 'string' ? src.trim() : '').replace(/^data:image\/(png|jpe?g|webp|gif)\+xml/i, 'data:image/$1');
    return /^data:image\/(svg\+xml|png|webp|jpe?g|gif)[;,]/i.test(s) ? s : null;
  };
  // Most-used EVM wallets first; anything else keeps the order it announced in.
  const RANK = ['io.metamask', 'io.rabby', 'com.coinbase.wallet', 'com.okex.wallet', 'com.trustwallet.app', 'io.zerion.wallet', 'me.rainbow'];
  const rank = (w) => { const i = RANK.indexOf(w.info.rdns); return i < 0 ? RANK.length : i; };

  function walletItem({ name, icon, tag, onClick, href, action }) {
    const li = document.createElement('li');
    const el = document.createElement(href ? 'a' : 'button');
    el.className = 'rc-wallet';
    if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener'; } else { el.type = 'button'; el.addEventListener('click', onClick); }
    const ic = document.createElement('span');
    ic.className = 'rc-wicon' + (icon ? '' : ' plain');
    if (icon) { const img = document.createElement('img'); img.src = icon; img.alt = ''; img.width = 32; img.height = 32; ic.appendChild(img); } else ic.innerHTML = GLYPH;
    const nm = document.createElement('span');
    nm.className = 'rc-wname';
    nm.textContent = name;
    const end = document.createElement('span');
    end.className = 'rc-wend';
    if (tag) end.textContent = tag;
    else { end.textContent = action + ' '; end.insertAdjacentHTML('beforeend', ARROW); }
    el.append(ic, nm, end);
    li.appendChild(el);
    return li;
  }

  function renderPicker() {
    const list = $('wlist');
    list.innerHTML = '';
    const wallets = [...found.values()].map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i).map((x) => x.w);
    if (!wallets.length && window.ethereum) wallets.push({ info: { name: 'Browser wallet', uuid: 'injected' }, provider: window.ethereum });
    for (const w of wallets) {
      list.appendChild(walletItem({ name: String(w.info.name || 'Wallet').slice(0, 32), icon: safeIcon(w.info.icon), tag: 'Detected', onClick: () => { $('modal').close(); connect(w.provider); } }));
    }
    list.hidden = !wallets.length;
    $('get').hidden = wallets.length > 0;
    $('get-label').textContent = mobile ? 'Open this page in your wallet app' : 'No wallet found in this browser';
    const get = $('getlist');
    get.innerHTML = '';
    for (const s of SUGGEST) get.appendChild(walletItem(s));
  }

  function discover() {
    window.addEventListener('eip6963:announceProvider', (e) => {
      const d = e.detail;
      // Keyed by rdns as well, because some wallets (Backpack) announce twice with different ids.
      if (d?.provider && d?.info?.uuid) { found.set(d.info.rdns || d.info.uuid, d); renderPicker(); }
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    renderPicker();
    $('open').addEventListener('click', () => {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      renderPicker();
      $('modal').showModal();
    });
    $('close').addEventListener('click', () => $('modal').close());
    // A click on the dimmed backdrop closes the picker.
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').close(); });
  }

  async function connect(provider) {
    state.provider = provider;
    try {
      const accounts = await rpc('eth_requestAccounts');
      if (!accounts?.length) return;
      state.account = accounts[0];
      provider.on?.('accountsChanged', (a) => { state.account = a[0] || null; state.wallet = null; afterConnect(); });
      provider.on?.('chainChanged', () => afterConnect());
      afterConnect();
    } catch (e) {
      say('connect-text', e?.code === 4001 ? 'Connection cancelled. Try again when you are ready.' : 'Could not connect to your wallet.');
    }
  }

  async function onRightChain() {
    const id = await rpc('eth_chainId');
    return String(id).toLowerCase() === CHAIN.chainId;
  }

  async function switchChain() {
    try {
      await rpc('wallet_switchEthereumChain', [{ chainId: CHAIN.chainId }]);
    } catch (e) {
      if (e?.code === 4902 || /unrecognized|not added/i.test(e?.message || '')) await rpc('wallet_addEthereumChain', [CHAIN]);
      else throw e;
    }
  }

  function say(el, text) { const n = $(el); if (n) n.textContent = text; }
  function mark(name, status) { step(name).dataset.status = status; }

  async function afterConnect() {
    if (!state.account) { mark('connect', ''); return; }
    $('open').hidden = true;
    $('account').hidden = false;
    $('account-addr').textContent = short(state.account.toLowerCase());
    $('account-addr').title = state.account;
    if (!(await onRightChain())) {
      say('connect-text', 'Your wallet is on another network. Switch to QMS testnet to continue.');
      $('switch').hidden = false;
      mark('connect', 'warn');
      return;
    }
    $('switch').hidden = true;
    say('connect-text', 'Connected.');
    mark('connect', 'done');
    if (!state.wallet) {
      const predicted = decodeAddr(await call(FACTORY, SEL.getAddress + encAddr(state.account) + encUint(0)));
      state.wallet = predicted;
    }
    await loadWallet();
  }

  async function loadWallet() {
    const w = state.wallet;
    $('wallet-row').hidden = !w;
    if (!w) return;
    const link = $('wallet-addr');
    link.textContent = short(w.toLowerCase());
    link.title = w;
    link.href = `${EXPLORER}/address/${w}`;
    const code = await rpc('eth_getCode', [w, 'latest']);
    if (!code || code === '0x') {
      say('wallet-text', 'No Qalibre wallet exists at this address for this account. If the app shows a different wallet address, use it below.');
      mark('wallet', 'warn');
      return clearList();
    }
    const owner = decodeAddr(await call(w, SEL.owner));
    if (!owner || owner.toLowerCase() !== state.account.toLowerCase()) {
      say('wallet-text', 'This account is not the owner of that wallet. Import the key you backed up in Qalibre, then connect that account.');
      mark('wallet', 'warn');
      return clearList();
    }
    say('wallet-text', 'Verified: this account owns the wallet.');
    mark('wallet', 'done');
    if (!state.tokens.length) state.tokens = [{ address: NATIVE, symbol: 'QMS', decimals: 18 }, ...KNOWN.map((t) => ({ ...t }))];
    await refresh();
  }

  function clearList() {
    $('list').innerHTML = '';
    $('all').hidden = true;
    $('token-form').hidden = true;
    $('gas').hidden = true;
    mark('move', '');
  }

  async function balanceOf(t) {
    if (t.address === NATIVE) return toBig(await rpc('eth_getBalance', [state.wallet, 'latest']));
    return toBig(await call(t.address, SEL.balanceOf + encAddr(state.wallet)));
  }

  async function refresh() {
    await Promise.all(state.tokens.map(async (t) => { t.balance = await balanceOf(t).catch(() => 0n); }));
    const gas = toBig(await rpc('eth_getBalance', [state.account, 'latest']));
    $('gas').hidden = gas >= MIN_GAS_WEI;
    render();
  }

  function render() {
    const list = $('list');
    list.innerHTML = '';
    const withFunds = state.tokens.filter((t) => t.balance > 0n || t.extra);
    for (const t of state.tokens) {
      if (!(t.balance > 0n) && !t.extra && t.address !== NATIVE) continue;
      const li = document.createElement('li');
      li.className = 'rc-token';
      const name = document.createElement('span');
      name.className = 'rc-name';
      name.innerHTML = `<b></b><small></small>`;
      name.querySelector('b').textContent = t.symbol;
      name.querySelector('small').textContent = t.status || t.note || (t.address === NATIVE ? 'Network coin' : short(t.address));
      const amt = document.createElement('span');
      amt.className = 'rc-amt';
      amt.textContent = fmt(t.balance ?? 0n, t.decimals);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-quiet rc-move';
      btn.textContent = t.done ? 'Moved' : 'Move';
      btn.disabled = state.busy || !(t.balance > 0n);
      btn.addEventListener('click', () => move([t]));
      li.append(name, amt, btn);
      list.appendChild(li);
    }
    const movable = state.tokens.filter((t) => t.balance > 0n);
    $('all').hidden = movable.length < 2;
    $('all').disabled = state.busy;
    $('token-form').hidden = false;
    mark('move', movable.length ? 'ready' : withFunds.length ? '' : 'done');
    if (!movable.length) {
      const li = document.createElement('li');
      li.className = 'rc-empty';
      li.textContent = state.tokens.some((t) => t.done) ? 'Everything has been moved to your owner account.' : 'This wallet holds nothing to move.';
      list.appendChild(li);
    }
  }

  async function waitFor(hash) {
    for (let i = 0; i < 120; i++) {
      const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) return r.status === '0x1';
      await new Promise((res) => setTimeout(res, 2000));
    }
    return null;
  }

  async function move(tokens) {
    if (state.busy) return;
    state.busy = true;
    try {
      if (!(await onRightChain())) await switchChain();
      for (const t of tokens) {
        const amount = await balanceOf(t);
        if (amount <= 0n) continue;
        t.status = 'Approve in your wallet…';
        render();
        let hash;
        try {
          hash = await rpc('eth_sendTransaction', [{ from: state.account, to: state.wallet, data: SEL.withdrawToOwner + encAddr(t.address) + encUint(amount) }]);
        } catch (e) {
          t.status = e?.code === 4001 ? 'Cancelled' : /insufficient|funds/i.test(e?.message || '') ? 'Not enough QMS for the network fee' : 'Could not send';
          render();
          continue;
        }
        t.status = 'Sending…';
        render();
        const ok = await waitFor(hash);
        t.status = ok ? 'Moved to your owner account' : ok === false ? 'Failed on-chain, nothing moved' : 'Sent, still confirming';
        if (ok) t.done = true;
        t.balance = await balanceOf(t).catch(() => t.balance);
        render();
      }
    } finally {
      state.busy = false;
      await refresh().catch(() => render());
    }
  }

  // ---------- events ----------
  $('switch').addEventListener('click', () => switchChain().then(afterConnect).catch(() => say('connect-text', 'Switch the network in your wallet, then try again.')));
  $('all').addEventListener('click', () => move(state.tokens.filter((t) => t.balance > 0n)));
  $('wallet-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('wallet-input').value.trim();
    if (!isAddr(v)) return say('wallet-text', 'That is not a valid address.');
    state.wallet = v;
    if (state.account) loadWallet();
    else say('wallet-text', 'Connect the owner account first.');
  });
  $('token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('token-input').value.trim();
    if (!isAddr(v)) return;
    if (state.tokens.some((t) => t.address.toLowerCase() === v.toLowerCase())) return;
    try {
      const [sym, dec] = await Promise.all([call(v, SEL.symbol), call(v, SEL.decimals)]);
      const decimals = Number(toBig(dec));
      if (!(decimals >= 0 && decimals <= 36)) throw new Error('bad decimals');
      state.tokens.push({ address: v, symbol: clean(decodeString(sym)), decimals, extra: true });
      $('token-input').value = '';
      await refresh();
    } catch {
      $('token-input').value = '';
      $('token-input').placeholder = 'Not a token on QMS testnet. Check the address.';
    }
  });

  discover();
})();
