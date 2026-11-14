import { config } from './config.js';
import type { Db } from './db.js';
import { Bot, esc } from './telegram.js';
import { fmtSig } from './chat.js';
import type { Service } from './service.js';
import type { Chat } from './chat.js';
import type { Social } from './social.js';
import { AGENT_KEY_DAYS, hashKey, issueAgentKey } from './agent.js';
import { detectSecret, GROUP_WARNING, SECRET_WARNING } from './secrets.js';
import { cleanText } from './tokens.js';
import type { OAuth } from './oauth.js';

interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; from?: { id: number; first_name?: string; is_bot?: boolean }; text?: string };
  callback_query?: { id: string; from: { id: number; first_name?: string }; data?: string; message?: { message_id: number; chat: { id: number; type: string } } };
  inline_query?: { id: string; from: { id: number }; query: string };
  my_chat_member?: { chat: { id: number; type: string; title?: string }; new_chat_member: { status: string } };
}

export async function setupBot(bot: Bot) {
  await bot.call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Home' },
      { command: 'buy', description: 'Check a token and buy it' },
      { command: 'sell', description: 'Sell a token you hold' },
      { command: 'portfolio', description: 'What you hold, with profit and loss' },
      { command: 'wallet', description: 'Your wallet, keys and limits' },
      { command: 'agent', description: 'Let an AI agent trade within your limits' },
      { command: 'invite', description: 'Invite friends, earn from our fee' },
      { command: 'stats', description: 'Scams blocked and trades so far' },
      { command: 'help', description: 'How Qalibre works' },
    ],
  });
  // Shown before the user presses Start (max 512 characters).
  await bot.call('setMyDescription', {
    description: [
      'Trade any token on QMS from this chat.',
      '',
      'Paste a token address and Qalibre checks it first: it simulates a buy and a sale, and blocks honeypots and hidden taxes before you lose money.',
      '',
      'Every trade gets at least the price of a direct QWAP swap, guaranteed by the contract. When other traders meet you in the same batch, you get better.',
      '',
      'Your wallet is yours. Only you can withdraw.',
    ].join('\n'),
  });
  // Shown on the bot's profile and in shares (max 120 characters).
  await bot.call('setMyShortDescription', { short_description: 'Trade any QMS token from chat. Scams blocked before you buy. Never worse than a direct swap.' });
  if (config.miniAppUrl) {
    await bot.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Wallet', web_app: { url: config.miniAppUrl } } });
  }
}

export function startBot(bot: Bot, db: Db, svc: Service, chat: Chat, social: Social, oauth?: OAuth) {
  let offset = 0;
  let stopped = false;

  const walletButton = (label = 'Wallet') => (config.miniAppUrl ? [{ text: label, web_app: { url: config.miniAppUrl } }] : []);

  /** Home: one line of balance, then everything as buttons. Registered and new users see different first steps. */
  async function home(tgId: number, firstName: string | null): Promise<{ text: string; kb: unknown[][] }> {
    const p = await svc.portfolio(tgId).catch(() => null);
    if (!p || !p.registered) {
      const name = firstName ? `, ${esc(firstName)}` : '';
      return {
        text: [
          `<b>Welcome to Qalibre${name}.</b>`,
          '',
          'Trade any token on QMS right here in the chat. Every token is checked before you buy, and every trade gets at least the price of a direct QWAP swap.',
          '',
          'First, create your wallet. It takes about thirty seconds, and only you can withdraw from it.',
          '',
          '<i>You can already paste any token address to check it.</i>',
        ].join('\n'),
        kb: [walletButton('Create your wallet'), [{ text: 'How it works', callback_data: 'm:help' }, { text: 'Is it safe?', callback_data: 'm:sec' }]].filter((r) => r.length),
      };
    }
    const qms = p.holdings[0]!.amount + p.unwrappedQms;
    const usdc = p.holdings[1]!.amount;
    const held = p.positions.length;
    return {
      text: [
        `<b>$${p.totalUsd.toFixed(2)}</b>`,
        `${fmtSig(qms)} QMS  ·  ${usdc.toFixed(2)} USDC${held ? `  ·  ${held} ${held === 1 ? 'token' : 'tokens'}` : ''}`,
        '',
        p.session.active ? 'Paste any token address to check it and trade.' : '<b>Trading is off.</b> Turn it on in your Wallet to trade from chat.',
      ].join('\n'),
      kb: [
        [{ text: 'Buy', callback_data: 'm:buy' }, { text: 'Sell', callback_data: 'm:sell' }],
        [{ text: 'Portfolio', callback_data: 'm:pf' }, ...walletButton()],
        [{ text: 'Invite', callback_data: 'm:inv' }, { text: 'Stats', callback_data: 'm:st' }],
        [{ text: 'Help', callback_data: 'm:help' }],
      ],
    };
  }

  const back = [{ text: 'Back', callback_data: 'm:home' }];
  const PAGES: Record<string, { text: string; kb: unknown[][] }> = {
    help: {
      text: [
        '<b>How Qalibre works</b>',
        '',
        '<b>Trade in the chat.</b> Paste a token address, or tap Buy. You get a card with the price and a safety check, then trade with one tap. Sell from the same card or from Portfolio.',
        '',
        '<b>Open the Wallet only when your PIN is needed:</b> creating your wallet, approving a new token once, changing limits, sending money out, or turning trading off.',
        '',
        '<b>Price.</b> Your order joins a batch. If other traders take the other side, you are matched at one fair price and pay less. If not, it goes to QWAP at exactly its price and Qalibre charges nothing. The contract never lets a trade settle below a direct swap.',
        '',
        '<b>In groups.</b> Add Qalibre to a group and it warns everyone when someone posts a scam token. Nobody can trade from a group.',
        '',
        '<b>Official links.</b> News: t.me/qalibre · X: x.com/qalibreapp · qalibre.app',
        'We never message you first and never ask for your key or PIN.',
      ].join('\n'),
      kb: [[{ text: 'Fees', callback_data: 'm:fees' }, { text: 'Is it safe?', callback_data: 'm:sec' }], back],
    },
    fees: {
      text: [
        '<b>What you pay</b>',
        '',
        "<b>Qalibre:</b> 20% of what we save you versus a direct swap, never more than 0.2% of the trade. No saving, no fee.",
        '',
        "<b>QWAP:</b> its usual 0.3%, only on the part of your trade that goes to QWAP. The same as swapping there yourself.",
        '',
        '<b>Network:</b> the real cost, shared by everyone in the batch, never above the maximum shown before you trade.',
        '',
        'Turning trading off, changing limits and moving your own money are free.',
      ].join('\n'),
      kb: [back],
    },
    sec: {
      text: [
        '<b>Who controls your money</b>',
        '',
        'You do. Your wallet is a smart account owned by a key made on your own phone and locked with your PIN. Qalibre never sees it.',
        '',
        'Qalibre holds a limited trading permission: it can trade only into your own wallet, only tokens you approved, only within your limits. It can never withdraw or send your money anywhere.',
        '',
        'You can turn that permission off at any time. Every rule is enforced by contracts verified on the QMS Explorer.',
      ].join('\n'),
      kb: [back],
    },
  };

  // ---------- Agent connector: keys for AI agents (MCP) ----------
  const MAX_AGENT_KEYS = 5;
  const mcpUrl = () => (config.miniAppUrl ? new URL('/mcp', config.miniAppUrl).toString() : 'https://app.qalibre.app/mcp');
  const ago = (t: number | null) => {
    if (!t) return 'never used';
    const s = Math.floor(Date.now() / 1000) - t;
    return s < 120 ? 'used just now' : s < 7200 ? `used ${Math.round(s / 60)} min ago` : s < 172800 ? `used ${Math.round(s / 3600)} h ago` : `used ${Math.round(s / 86400)} days ago`;
  };

  function agentPage(tgId: number): { text: string; kb: unknown[][] } {
    const keys = db.activeAgentKeys(tgId);
    const lines = [
      '<b>AI agents</b>',
      '',
      'Connect Claude or another AI agent to Qalibre. It can check tokens, quote and trade inside your wallet, and nothing else:',
      '· It can never withdraw or send money out.',
      '· It can only buy tokens you approved, never high-risk ones.',
      '· Its own caps: 1 QMS per trade, 5 QMS a day, inside your wallet limits.',
      '· You get a message for every trade it makes, with a Revoke button.',
      '',
    ];
    if (keys.length) {
      lines.push('<b>Active keys</b>');
      for (const k of keys) lines.push(`${esc(k.label)}  <code>${esc(k.prefix)}…</code>  ${k.can_trade ? 'trading' : 'read-only'}, ${ago(k.last_used_at)}`);
    } else {
      lines.push('No agent keys yet.');
    }
    const kb: unknown[][] = [];
    if (keys.length < MAX_AGENT_KEYS) kb.push([{ text: 'New trading key', callback_data: 'ag:new:t' }, { text: 'New read-only key', callback_data: 'ag:new:r' }]);
    for (const k of keys) kb.push([{ text: `Revoke ${k.label} (${k.prefix}…)`, callback_data: `ag:rv:${k.id}` }]);
    if (keys.length > 1) kb.push([{ text: 'Revoke all agent keys', callback_data: 'ag:rvall' }]);
    kb.push([{ text: 'Home', callback_data: 'm:home' }]);
    return { text: lines.join('\n'), kb };
  }

  const AGENT_NAMES = ['Claude', 'Cursor', 'ChatGPT', 'Gemini'];
  /** Users who tapped "Another name" and owe us a typed name (expires after 5 minutes). */
  const pendingName = new Map<number, { canTrade: boolean; at: number }>();

  /** Two agents with one name would make the notices ambiguous: the second becomes "Claude 2". */
  function uniqueLabel(tgId: number, rawName: string): string {
    const taken = new Set(db.activeAgentKeys(tgId).map((x) => x.label.toLowerCase()));
    let label = cleanText(rawName, 24) || 'Agent';
    for (let i = 2; taken.has(label.toLowerCase()); i++) label = `${cleanText(rawName, 20) || 'Agent'} ${i}`;
    return label;
  }

  // ---------- OAuth consent: an AI app asked to connect; the user decides here ----------
  async function onOAuthStart(tgId: number, id: string) {
    const r = oauth?.pending(id);
    if (!r) return void (await bot.sendMessage(tgId, 'That connection request has expired. Start again from your AI app.'));
    if (!svc.isRegistered(tgId)) return void (await bot.sendMessage(tgId, 'Create your wallet first, then connect your AI app again.'));
    if (db.activeAgentKeys(tgId).length >= MAX_AGENT_KEYS) return void (await bot.sendMessage(tgId, `You already have ${MAX_AGENT_KEYS} agents connected. Revoke one with /agent first.`));
    await bot.sendMessage(
      tgId,
      [
        `<b>${esc(r.clientName)} wants to connect to your Qalibre wallet</b>`,
        '',
        `Pairing code: <b>${r.pairing}</b>`,
        'Only continue if this matches the code on your screen and you started this yourself just now.',
        '',
        'If you allow trading, it can check tokens and trade inside your wallet: only tokens you approved, never high-risk ones, at most 1 QMS a trade and 5 QMS a day.',
        'It can never withdraw or send money out. You get a message for every trade, and you can revoke it any time with /agent.',
      ].join('\n'),
      { reply_markup: { inline_keyboard: [[{ text: 'Allow trading', callback_data: `oa:t:${id}` }, { text: 'Read only', callback_data: `oa:r:${id}` }], [{ text: 'Deny', callback_data: `oa:d:${id}` }]] } },
    );
  }

  async function onOAuthDecision(q: { id: string; from: { id: number }; data?: string; message?: { message_id: number } }) {
    const m = /^oa:(t|r|d):([A-Za-z0-9_-]{22})$/.exec(q.data ?? '');
    if (!m || !oauth) return void (await bot.answer(q.id));
    const tgId = q.from.id;
    const allow = m[1] !== 'd';
    if (allow && db.activeAgentKeys(tgId).length >= MAX_AGENT_KEYS) return void (await bot.answer(q.id, `Revoke an agent with /agent first (limit ${MAX_AGENT_KEYS}).`, true));
    const name = oauth.decide(m[2]!, tgId, allow, m[1] === 't', (n) => uniqueLabel(tgId, n));
    if (!name) return void (await bot.answer(q.id, 'This request has expired or was already answered.', true));
    await bot.answer(q.id, allow ? 'Connected' : 'Declined');
    const text = allow
      ? `<b>${esc(name)} is connected</b>  ·  ${m[1] === 't' ? 'can trade' : 'read-only'}
Go back to your AI app; it finishes by itself. Revoke any time with /agent.`
      : `<b>Declined.</b> ${esc(name)} was not connected.`;
    if (q.message?.message_id) await bot.editMessage(tgId, q.message.message_id, text).catch(() => bot.sendMessage(tgId, text));
    else await bot.sendMessage(tgId, text);
  }

  async function createAgentKey(tgId: number, canTrade: boolean, rawName: string) {
    if (!svc.isRegistered(tgId)) return void (await bot.sendMessage(tgId, 'Create your wallet first.'));
    if (db.activeAgentKeys(tgId).length >= MAX_AGENT_KEYS) return void (await bot.sendMessage(tgId, `You can have up to ${MAX_AGENT_KEYS} agent keys. Revoke one with /agent first.`));
    const label = uniqueLabel(tgId, rawName);
    const { secret } = issueAgentKey(db, tgId, { label, canTrade });
    const url = mcpUrl();
    const sent = (await bot.sendMessage(
      tgId,
      [
        `<b>${esc(label)} is ready</b>  ·  ${canTrade ? 'can trade' : 'read-only'}`,
        '',
        `<code>${secret}</code>`,
        '',
        'Shown once. Keep it private: anyone with it can do what this agent can. This message deletes itself in 15 minutes.',
        '',
        '<b>1. Connect</b>  (Claude Code: paste in a terminal, not a chat)',
        `<code>claude mcp add --transport http qalibre ${url} --header "Authorization: Bearer ${secret}"</code>`,
        'Cursor, VS Code and others: qalibre.app/agents',
        '',
        '<b>2. Then ask it</b>',
        `<code>Check my Qalibre wallet and tell me what I hold.</code>`,
        '',
        `Expires in ${AGENT_KEY_DAYS} days. Revoke any time with /agent.`,
      ].join('\n'),
    )) as { message_id?: number };
    if (sent?.message_id) setTimeout(() => void bot.call('deleteMessage', { chat_id: tgId, message_id: sent.message_id }).catch(() => undefined), 15 * 60_000);
  }

  /** A typed agent name, if we asked for one in the last 5 minutes. Returns true when the message was consumed. */
  async function onAgentName(tgId: number, text: string): Promise<boolean> {
    const p = pendingName.get(tgId);
    if (!p) return false;
    pendingName.delete(tgId);
    if (Date.now() - p.at > 5 * 60_000 || text.startsWith('/')) return false;
    await createAgentKey(tgId, p.canTrade, text);
    return true;
  }

  async function onAgent(q: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } }) {
    const tgId = q.from.id;
    const d = q.data ?? '';
    const msgId = q.message?.message_id;
    const refresh = async () => {
      const p = agentPage(tgId);
      if (msgId) await bot.editMessage(tgId, msgId, p.text, { reply_markup: { inline_keyboard: p.kb } }).catch(() => undefined);
    };
    // Step 1: choose the kind of key. Step 2: name the agent (quick picks, or type a name). Step 3: the key.
    const k = /^ag:new:(t|r)$/.exec(d);
    if (k) {
      if (!svc.isRegistered(tgId)) return void (await bot.answer(q.id, 'Create your wallet first.', true));
      if (db.activeAgentKeys(tgId).length >= MAX_AGENT_KEYS) return void (await bot.answer(q.id, `You can have up to ${MAX_AGENT_KEYS} agent keys. Revoke one first.`, true));
      await bot.answer(q.id);
      const kind = k[1]!;
      return void (await bot.sendMessage(tgId, '<b>What should we call this agent?</b>\nThe name appears in every message about what it does.', {
        reply_markup: {
          inline_keyboard: [
            AGENT_NAMES.slice(0, 3).map((n) => ({ text: n, callback_data: `ag:mk:${kind}:${n}` })),
            [{ text: AGENT_NAMES[3]!, callback_data: `ag:mk:${kind}:${AGENT_NAMES[3]}` }, { text: 'Another name', callback_data: `ag:nm:${kind}` }],
          ],
        },
      }));
    }
    const mk = /^ag:mk:(t|r):([A-Za-z]{1,16})$/.exec(d);
    if (mk && AGENT_NAMES.includes(mk[2]!)) {
      await bot.answer(q.id);
      if (msgId) void bot.call('deleteMessage', { chat_id: tgId, message_id: msgId }).catch(() => undefined);
      return createAgentKey(tgId, mk[1] === 't', mk[2]!);
    }
    const nm = /^ag:nm:(t|r)$/.exec(d);
    if (nm) {
      await bot.answer(q.id);
      pendingName.set(tgId, { canTrade: nm[1] === 't', at: Date.now() });
      return void (await bot.sendMessage(tgId, 'Type a name for this agent, up to 24 characters.', { reply_markup: { force_reply: true, input_field_placeholder: 'For example: Research bot' } }));
    }
    if (d === 'ag:rvall') {
      const n = db.revokeAllAgentKeys(tgId);
      await bot.answer(q.id, n ? `Revoked ${n} agent ${n === 1 ? 'key' : 'keys'}.` : 'Nothing to revoke.');
      return refresh();
    }
    if (d === 'ag:list') {
      await bot.answer(q.id);
      const p = agentPage(tgId);
      return void (await bot.sendMessage(tgId, p.text, { reply_markup: { inline_keyboard: p.kb } }));
    }
    const m = /^ag:rv:([0-9a-f-]{36})$/.exec(d);
    if (m) {
      const ok = db.revokeAgentKey(m[1]!, tgId);
      await bot.answer(q.id, ok ? 'Revoked. That agent can no longer do anything.' : 'Already revoked.');
      return refresh();
    }
    await bot.answer(q.id);
  }

  /** Menu buttons. Pages change in place, like an app; actions send their own message. */
  async function onMenu(q: { id: string; from: { id: number; first_name?: string }; data?: string; message?: { message_id: number; chat: { id: number } } }) {
    const tgId = q.from.id;
    const page = (q.data ?? '').slice(2);
    const msgId = q.message?.message_id;
    const show = async (text: string, kb: unknown[][]) => {
      if (msgId) await bot.editMessage(tgId, msgId, text, { reply_markup: { inline_keyboard: kb } }).catch(() => bot.sendMessage(tgId, text, { reply_markup: { inline_keyboard: kb } }));
      else await bot.sendMessage(tgId, text, { reply_markup: { inline_keyboard: kb } });
    };
    if (page === 'home') {
      await bot.answer(q.id);
      const h = await home(tgId, q.from.first_name ?? null);
      return show(h.text, h.kb);
    }
    if (PAGES[page]) {
      await bot.answer(q.id);
      return show(PAGES[page]!.text, PAGES[page]!.kb);
    }
    await bot.answer(q.id);
    if (page === 'buy') return void (await bot.sendMessage(tgId, 'Paste the address of the token you want to buy.', { reply_markup: { force_reply: true, input_field_placeholder: '0x…' } }));
    if (page === 'sell' || page === 'pf') return void (await chat.onPrivateText(tgId, '/portfolio', msgId ?? 0));
    if (page === 'inv') return social.inviteMessage(tgId);
    if (page === 'st') return social.statsMessage(tgId);
  }

  async function handle(u: Update) {
    if (u.my_chat_member) return social.onMembership(u.my_chat_member);
    if (u.callback_query) {
      const q = u.callback_query;
      const d = q.data ?? '';
      // Share buttons (private chat only; ownership is checked inside).
      if (q.message?.chat.type === 'private' && (d.startsWith('f:') || d.startsWith('sp:') || d === 'sv')) {
        await bot.answer(q.id, 'Making your card');
        if (/^f:[0-9a-f-]{36}$/.test(d)) return social.shareFill(q.from.id, d.slice(2));
        if (d === 'sv') return social.shareSavings(q.from.id);
        const card = d.startsWith('sp:') ? db.getCard(d.slice(3)) : undefined;
        if (card && card.tg_id === q.from.id) return social.sharePosition(q.from.id, card.token as `0x${string}`);
        return;
      }
      if (d.startsWith('m:') && q.message?.chat.type === 'private') return onMenu(q);
      if (d.startsWith('ag:') && q.message?.chat.type === 'private') return onAgent(q);
      if (d.startsWith('oa:') && q.message?.chat.type === 'private') return onOAuthDecision(q);
      return chat.onCallback(q);
    }
    if (u.inline_query) return chat.onInlineQuery(u.inline_query);
    const msg = u.message;
    if (!msg?.text || !msg.from || msg.from.is_bot) return;
    // A secret pasted by mistake is deleted before anything else reads it.
    const secret = detectSecret(msg.text);
    if (secret) {
      await bot.call('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => undefined);
      for (const k of secret.agentKeys) db.revokeExposedAgentKey(hashKey(k));
      if (msg.chat.type === 'private') return void (await bot.sendMessage(msg.chat.id, SECRET_WARNING[secret.kind]));
      // In groups the bot can delete only if an admin allowed it; the warning goes out either way.
      return void (await bot.sendMessage(msg.chat.id, GROUP_WARNING).catch(() => undefined));
    }
    if (msg.chat.type !== 'private') return social.onGroupMessage(msg.chat.id, msg.text, msg.message_id, msg.from.id);
    const id = msg.from.id;
    db.upsertUser(id, msg.from.first_name ?? null);
    const [first = '', payload = ''] = msg.text.trim().split(/\s+/);
    const cmd = first.toLowerCase().replace(/@\w+$/, '');

    if (cmd === '/start' && /^oa_[A-Za-z0-9_-]{22}$/.test(payload)) return onOAuthStart(id, payload.slice(3));
    if (cmd === '/start' && payload && (await chat.onStartPayload(id, payload))) return;
    // An invite link: remember the inviter, then continue to the normal welcome.
    if (cmd === '/start' && payload) social.applyInvite(id, payload);
    if (await onAgentName(id, msg.text)) return;
    if (cmd === '/invite') return social.inviteMessage(id);
    if (cmd === '/agent' || cmd === '/agents') {
      const p = agentPage(id);
      return void (await bot.sendMessage(id, p.text, { reply_markup: { inline_keyboard: p.kb } }));
    }
    if (cmd === '/wallet') {
      return void (await bot.sendMessage(id, 'Your wallet: balances, your PIN-protected key, approvals, limits, and sending money out.', config.miniAppUrl ? { reply_markup: { inline_keyboard: [walletButton('Open Wallet')] } } : {}));
    }
    if (cmd === '/help' || cmd === '/how') return void (await bot.sendMessage(id, PAGES.help!.text, { reply_markup: { inline_keyboard: PAGES.help!.kb } }));
    if (cmd === '/fees') return void (await bot.sendMessage(id, PAGES.fees!.text, { reply_markup: { inline_keyboard: [[{ text: 'Home', callback_data: 'm:home' }]] } }));
    if (cmd === '/security') return void (await bot.sendMessage(id, PAGES.sec!.text, { reply_markup: { inline_keyboard: [[{ text: 'Home', callback_data: 'm:home' }]] } }));
    if (cmd === '/savings') return social.shareSavings(id);
    if (cmd === '/stats') return social.statsMessage(id);
    if (await chat.onPrivateText(id, msg.text, msg.message_id)) return;

    if (cmd === '/start' || cmd === '/balance' || cmd === '/home') {
      const h = await home(id, msg.from.first_name ?? null);
      return void (await bot.sendMessage(id, h.text, { reply_markup: { inline_keyboard: h.kb } }));
    }
    // Anything else: a short pointer, never a wall of commands.
    await bot.sendMessage(id, 'Paste any token address and I\'ll check it for you. Or open Home.', { reply_markup: { inline_keyboard: [[{ text: 'Home', callback_data: 'm:home' }]] } });
  }

  (async () => {
    while (!stopped) {
      try {
        const updates = await bot.call<Update[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query', 'inline_query', 'my_chat_member'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          await handle(u).catch((e) => console.error('bot handler', (e as Error).message));
        }
      } catch (e) {
        console.error('bot polling', (e as Error).message);
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
