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
      { command: 'balance', description: 'Your balance and savings' },
      { command: 'help', description: 'How Qalibre works' },
    ],
  });
  await bot.call('setMyDescription', {
    description: 'Qalibre matches buyers with sellers before going to the exchange, so you never get less than swapping directly. No saving, no fee. Your wallet, your keys.',
  });
  await bot.call('setMyShortDescription', { short_description: 'Trade together. Pay less. Best execution on QMS.' });
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
          'We match buyers with sellers before going to the exchange, so you never get less than swapping directly on QWAP. If we don\'t save you money, we don\'t charge you.',
          '',
          'Your wallet is yours: only you can withdraw.',
          config.miniAppUrl ? '' : '\nThe app opens to testers very soon.',
        ].join('\n'),
        openButton(),
      );
      return;
    }
    if (cmd === '/balance') {
      const p = await svc.portfolio(id);
      if (!p.registered) {
        await bot.sendMessage(id, 'You don\'t have a Qalibre wallet yet. Open the app to create one in about 30 seconds.', openButton());
        return;
      }
      const lines = p.holdings.map((h) => `${h.symbol.padEnd(5)} ${h.amount.toFixed(h.symbol === 'USDC' ? 2 : 4)}   $${h.valueUsd.toFixed(2)}`);
      await bot.sendMessage(
        id,
        [`<b>Balance $${p.totalUsd.toFixed(2)}</b>`, `<pre>${lines.join('\n')}</pre>`, p.savedUsd > 0 ? `Saved $${p.savedUsd.toFixed(2)} across ${p.trades} trades versus swapping directly.` : ''].join('\n'),
        openButton(),
      );
      return;
    }
    if (cmd === '/help') {
      await bot.sendMessage(
        id,
        [
          '<b>How Qalibre works</b>',
          '1. Your order joins a batch with other traders, every few seconds.',
          '2. Buyers and sellers are matched with each other first, at one fair price for everyone.',
          '3. Only what is left over goes to the exchange (QWAP).',
          '4. The contract guarantees you never get less than swapping directly.',
          '',
          'Fee: 20% of what we save you, never more than 0.2%. No saving, no fee.',
        ].join('\n'),
        openButton(),
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
