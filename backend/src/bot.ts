import { config } from './config.js';
import type { Db } from './db.js';
import { Bot, esc } from './telegram.js';
import { fmtSig } from './chat.js';
import type { Service } from './service.js';
import type { Chat } from './chat.js';
import type { Social } from './social.js';

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

export function startBot(bot: Bot, db: Db, svc: Service, chat: Chat, social: Social) {
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
      return chat.onCallback(q);
    }
    if (u.inline_query) return chat.onInlineQuery(u.inline_query);
    const msg = u.message;
    if (!msg?.text || !msg.from || msg.from.is_bot) return;
    if (msg.chat.type !== 'private') return social.onGroupMessage(msg.chat.id, msg.text, msg.message_id, msg.from.id);
    const id = msg.from.id;
    db.upsertUser(id, msg.from.first_name ?? null);
    const [first = '', payload = ''] = msg.text.trim().split(/\s+/);
    const cmd = first.toLowerCase().replace(/@\w+$/, '');

    if (cmd === '/start' && payload && (await chat.onStartPayload(id, payload))) return;
    // An invite link: remember the inviter, then continue to the normal welcome.
    if (cmd === '/start' && payload) social.applyInvite(id, payload);
    if (cmd === '/invite') return social.inviteMessage(id);
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
