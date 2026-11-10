import { config } from './config.js';
import type { Db } from './db.js';
import { Bot, esc } from './telegram.js';
import type { Service } from './service.js';

interface Update {
  update_id: number;
  message?: { chat: { id: number; type: string }; from?: { id: number; first_name?: string }; text?: string };
}

function openButton() {
  return config.miniAppUrl
    ? { reply_markup: { inline_keyboard: [[{ text: 'Open Qalibre', web_app: { url: config.miniAppUrl } }]] } }
    : {};
}

export async function setupBot(bot: Bot) {
  await bot.call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Open Qalibre' },
      { command: 'balance', description: 'Balance and savings' },
      { command: 'how', description: 'How a batch works' },
      { command: 'fees', description: 'What you pay, and when' },
      { command: 'security', description: 'Who controls your funds' },
    ],
  });
  // Shown before the user presses Start (max 512 characters).
  await bot.call('setMyDescription', {
    description: [
      'Qalibre is precision trading on QMS.',
      '',
      'Every few seconds, orders are gathered into a single batch. Buyers are matched with sellers first, at one fair price for everyone. Only the remainder goes to the exchange.',
      '',
      'The contract guarantees you never receive less than a direct swap. We earn only when we improve your price.',
      '',
      'Your wallet stays yours. Only you can withdraw.',
    ].join('\n'),
  });
  // Shown on the bot's profile and in shares (max 120 characters).
  await bot.call('setMyShortDescription', { short_description: 'Precision trading on QMS. Matched first, never worse than a direct swap. Your keys, always.' });
  if (config.miniAppUrl) {
    await bot.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open', web_app: { url: config.miniAppUrl } } });
  }
}

export function startBot(bot: Bot, db: Db, svc: Service) {
  let offset = 0;
  let stopped = false;

  async function handle(u: Update) {
    const msg = u.message;
    if (!msg?.text || !msg.from || msg.chat.type !== 'private') return;
    const id = msg.from.id;
    db.upsertUser(id, msg.from.first_name ?? null);
    const cmd = msg.text.trim().split(/\s+/)[0]!.toLowerCase().replace(/@\w+$/, '');

    if (cmd === '/start') {
      const name = msg.from.first_name ? `, ${esc(msg.from.first_name)}` : '';
      await bot.sendMessage(
        id,
        [
          `<b>Welcome to Qalibre${name}.</b>`,
          '',
          'Trade together. Pay less.',
          '',
          'Your order joins a batch with other traders. Buyers are matched with sellers first, at one fair price, and only the remainder goes to QWAP. You never receive less than a direct swap, and if we don\'t improve your price, there is no fee.',
          '',
          'Your wallet stays yours. Qalibre can trade only within the limits you set, and only you can withdraw.',
          '',
          config.miniAppUrl ? 'Open Qalibre to create your wallet. It takes about thirty seconds.' : 'The app opens to testers shortly. We will message you here.',
        ].join('\n'),
        openButton(),
      );
      return;
    }
    if (cmd === '/balance') {
      const p = await svc.portfolio(id);
      if (!p.registered) {
        await bot.sendMessage(id, 'You don\'t have a Qalibre wallet yet. Creating one takes about thirty seconds.', openButton());
        return;
      }
      const lines = p.holdings.map((h) => `${h.symbol.padEnd(6)}${h.amount.toFixed(h.symbol === 'USDC' ? 2 : 4).padStart(12)}${('$' + h.valueUsd.toFixed(2)).padStart(12)}`);
      await bot.sendMessage(
        id,
        [
          `<b>$${p.totalUsd.toFixed(2)}</b>`,
          `<pre>${lines.join('\n')}</pre>`,
          p.trades > 0 ? `You have saved <b>$${p.savedUsd.toFixed(2)}</b> across ${p.trades} ${p.trades === 1 ? 'trade' : 'trades'}, compared with swapping directly.` : 'Your first trade is one tap away.',
        ].join('\n'),
        openButton(),
      );
      return;
    }
    if (cmd === '/how' || cmd === '/help') {
      await bot.sendMessage(
        id,
        [
          '<b>How a batch works</b>',
          '',
          '1. Every few seconds, Qalibre gathers everyone\'s orders into one batch.',
          '2. Buyers are matched with sellers first. Matched trades skip the exchange fee and its price impact.',
          '3. Everyone in the batch trades at the same price. No one is first in line.',
          '4. Only the unmatched remainder is sent to QWAP.',
          '5. Before anything settles, the contract checks that you receive at least what a direct swap would pay. If not, nothing happens.',
          '',
          'Choosing which orders clear together is an optimization problem, the kind QMS miners are built to solve.',
        ].join('\n'),
        openButton(),
      );
      return;
    }
    if (cmd === '/fees') {
      await bot.sendMessage(
        id,
        [
          '<b>What you pay</b>',
          '',
          'Qalibre takes 20% of the improvement it gets you over a direct swap, and never more than 0.2% of the trade.',
          '',
          'If there is no improvement, there is no fee. You pay only QWAP\'s usual 0.3% on the part that goes to QWAP, exactly as if you had swapped there yourself.',
          '',
          'Network fees are on us.',
        ].join('\n'),
      );
      return;
    }
    if (cmd === '/security') {
      await bot.sendMessage(
        id,
        [
          '<b>Who controls your funds</b>',
          '',
          'You do. Your wallet is a smart account owned by a key created on your own device. Qalibre never sees it.',
          '',
          'Qalibre holds a limited trading permission. It can only place trades into your own wallet, within the per-trade and daily limits you set, and it expires. It cannot withdraw or send your funds anywhere.',
          '',
          'You can turn the permission off at any time, and you can withdraw without Qalibre. Every rule is enforced by verified contracts on the QMS Explorer.',
        ].join('\n'),
      );
    }
  }

  (async () => {
    while (!stopped) {
      try {
        const updates = await bot.call<Update[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
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
