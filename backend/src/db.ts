import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
// Loaded through Node's own resolver: some bundlers (vitest/vite) do not yet know the node:sqlite built-in.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UserRow {
  tg_id: number;
  first_name: string | null;
  owner: string | null;
  account: string | null;
  session_address: string | null;
  session_key_enc: string | null;
  pending_setup: string | null;
  settlement: string | null;
  dripped: number;
  last_drip_at: number;
  created_at: number;
  ref_code: string | null;
  referrer_tg: number | null;
  referred_at: number | null;
}

export interface OrderRow {
  id: string;
  tg_id: number;
  account: string;
  sell_token: string;
  buy_token: string;
  sell_amount: string;
  min_buy_amount: string;
  max_network_fee: string;
  network_fee: string | null;
  valid_to: number;
  nonce: string;
  signature: string;
  status: 'pending' | 'filled' | 'expired' | 'failed';
  mode: 'instant' | 'best';
  created_ms: number | null;
  confirmed: number;
  reason: string | null;
  tx_hash: string | null;
  buy_amount: string | null;
  fee: string | null;
  direct_quote: string | null;
  batch_id: number | null;
  created_at: number;
  updated_at: number;
  /** The chat message that tracks this order live (chat trading), if any. */
  status_msg_id: number | null;
}

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      tg_id INTEGER PRIMARY KEY,
      first_name TEXT,
      owner TEXT,
      account TEXT UNIQUE,
      session_address TEXT,
      session_key_enc TEXT,
      pending_setup TEXT,
      dripped INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      tg_id INTEGER NOT NULL,
      account TEXT NOT NULL,
      sell_token TEXT NOT NULL,
      buy_token TEXT NOT NULL,
      sell_amount TEXT NOT NULL,
      min_buy_amount TEXT NOT NULL,
      valid_to INTEGER NOT NULL,
      nonce TEXT NOT NULL,
      signature TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      tx_hash TEXT,
      buy_amount TEXT,
      fee TEXT,
      direct_quote TEXT,
      batch_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS orders_user ON orders(tg_id, created_at);
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      tg_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      chat_id INTEGER PRIMARY KEY,
      title TEXT,
      alerts INTEGER NOT NULL DEFAULT 1,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_alerts (
      chat_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, token)
    );
    CREATE TABLE IF NOT EXISTS referral_rewards (
      order_id TEXT PRIMARY KEY,
      referrer_tg INTEGER NOT NULL,
      referee_tg INTEGER NOT NULL,
      amount_qms TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      paid_tx TEXT
    );
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash TEXT,
      block INTEGER,
      trades INTEGER,
      qubo_mtx TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  for (const ddl of ['ALTER TABLE users ADD COLUMN pending_session_address TEXT', 'ALTER TABLE users ADD COLUMN pending_session_enc TEXT', 'ALTER TABLE users ADD COLUMN last_drip_at INTEGER NOT NULL DEFAULT 0', "ALTER TABLE orders ADD COLUMN max_network_fee TEXT NOT NULL DEFAULT '0'", 'ALTER TABLE orders ADD COLUMN network_fee TEXT', 'ALTER TABLE users ADD COLUMN settlement TEXT', "ALTER TABLE orders ADD COLUMN mode TEXT NOT NULL DEFAULT 'best'", 'ALTER TABLE orders ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE orders ADD COLUMN created_ms INTEGER', 'ALTER TABLE orders ADD COLUMN status_msg_id INTEGER', 'ALTER TABLE users ADD COLUMN ref_code TEXT', 'ALTER TABLE users ADD COLUMN referrer_tg INTEGER', 'ALTER TABLE users ADD COLUMN referred_at INTEGER', 'ALTER TABLE cards ADD COLUMN msg_id INTEGER']) {
    try {
      db.exec(ddl);
    } catch {
      /* column exists */
    }
  }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_ref_code ON users(ref_code)');
  } catch {
    /* exists */
  }
  const now = () => Math.floor(Date.now() / 1000);
  return {
    raw: db,
    getUser(tgId: number): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId) as UserRow | undefined;
    },
    upsertUser(tgId: number, firstName: string | null) {
      db.prepare('INSERT INTO users (tg_id, first_name, created_at) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET first_name = excluded.first_name').run(tgId, firstName, now());
    },
    setPending(tgId: number, fields: { owner: string; session_address: string; session_key_enc: string; pending_setup: string }) {
      db.prepare('UPDATE users SET owner = ?, session_address = ?, session_key_enc = ?, pending_setup = ? WHERE tg_id = ?').run(fields.owner, fields.session_address, fields.session_key_enc, fields.pending_setup, tgId);
    },
    setAccount(tgId: number, account: string, settlement: string) {
      db.prepare('UPDATE users SET account = ?, settlement = ?, pending_setup = NULL, dripped = 0, last_drip_at = 0 WHERE tg_id = ?').run(account, settlement, tgId);
    },
    setPendingSession(tgId: number, address: string, enc: string) {
      db.prepare('UPDATE users SET pending_session_address = ?, pending_session_enc = ? WHERE tg_id = ?').run(address, enc, tgId);
    },
    /** Make the issued key the live trading key, only if it is the one the owner just approved on-chain. */
    activatePendingSession(tgId: number, approvedKey: string) {
      db.prepare(
        'UPDATE users SET session_address = pending_session_address, session_key_enc = pending_session_enc, pending_session_address = NULL, pending_session_enc = NULL WHERE tg_id = ? AND lower(pending_session_address) = lower(?)',
      ).run(tgId, approvedKey);
    },
    markDripped(tgId: number) {
      db.prepare('UPDATE users SET dripped = 1, last_drip_at = ? WHERE tg_id = ?').run(now(), tgId);
    },
    userByAccount(account: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE lower(account) = lower(?)').get(account) as UserRow | undefined;
    },
    insertOrder(o: Omit<OrderRow, 'status' | 'reason' | 'tx_hash' | 'buy_amount' | 'fee' | 'direct_quote' | 'batch_id' | 'created_at' | 'updated_at' | 'confirmed' | 'created_ms' | 'network_fee' | 'status_msg_id'>) {
      const t = now();
      db.prepare(`INSERT INTO orders (id, tg_id, account, sell_token, buy_token, sell_amount, min_buy_amount, max_network_fee, valid_to, nonce, signature, status, mode, created_ms, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(o.id, o.tg_id, o.account, o.sell_token, o.buy_token, o.sell_amount, o.min_buy_amount, o.max_network_fee, o.valid_to, o.nonce, o.signature, o.mode, Date.now(), t, t);
    },
    markConfirmed(txHash: string) {
      db.prepare('UPDATE orders SET confirmed = 1 WHERE tx_hash = ?').run(txHash);
    },
    pendingOrders(): OrderRow[] {
      return db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at").all() as unknown as OrderRow[];
    },
    countPending(): number {
      return (db.prepare("SELECT count(*) AS n FROM orders WHERE status = 'pending'").get() as { n: number }).n;
    },
    getOrder(id: string): OrderRow | undefined {
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
    },
    userOrders(tgId: number, limit = 30): OrderRow[] {
      return db.prepare('SELECT * FROM orders WHERE tg_id = ? ORDER BY created_at DESC LIMIT ?').all(tgId, limit) as unknown as OrderRow[];
    },
    /** Every filled order, for one user or (no argument) everyone, oldest first. */
    filledOrders(tgId?: number): OrderRow[] {
      return (tgId === undefined
        ? db.prepare("SELECT * FROM orders WHERE status = 'filled' ORDER BY created_at").all()
        : db.prepare("SELECT * FROM orders WHERE status = 'filled' AND tg_id = ? ORDER BY created_at").all(tgId)) as unknown as OrderRow[];
    },
    markFilled(id: string, f: { tx: string; buy: string; fee: string; networkFee: string; direct: string; batchId: number }) {
      db.prepare("UPDATE orders SET status = 'filled', tx_hash = ?, buy_amount = ?, fee = ?, network_fee = ?, direct_quote = ?, batch_id = ?, updated_at = ? WHERE id = ?").run(f.tx, f.buy, f.fee, f.networkFee, f.direct, f.batchId, now(), id);
    },
    /** A settlement vanished in a reorganization: its fills never happened on-chain, so the orders go back in the queue. */
    requeueByTx(txHash: string): OrderRow[] {
      const rows = db.prepare("SELECT * FROM orders WHERE tx_hash = ? AND status = 'filled'").all(txHash) as unknown as OrderRow[];
      db.prepare("UPDATE orders SET status = 'pending', tx_hash = NULL, buy_amount = NULL, fee = NULL, network_fee = NULL, direct_quote = NULL, batch_id = NULL, updated_at = ? WHERE tx_hash = ? AND status = 'filled'").run(now(), txHash);
      return rows;
    },
    /** Cancel a user's waiting orders (for example after their trading key changed). Returns how many. */
    cancelPending(tgId: number, reason: string): number {
      const r = db.prepare("UPDATE orders SET status = 'expired', reason = ?, updated_at = ? WHERE tg_id = ? AND status = 'pending'").run(reason, now(), tgId);
      return Number(r.changes);
    },
    markStatus(id: string, status: 'expired' | 'failed', reason: string) {
      db.prepare('UPDATE orders SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(status, reason, now(), id);
    },
    insertBatch(b: { tx: string; block: number; trades: number; mtx: string }): number {
      const r = db.prepare('INSERT INTO batches (tx_hash, block, trades, qubo_mtx, created_at) VALUES (?, ?, ?, ?, ?)').run(b.tx, b.block, b.trades, b.mtx, now());
      return Number(r.lastInsertRowid);
    },
    /** A chat card: an opaque id that stands for (user, token) in button data, so buttons never carry addresses or amounts. */
    putCard(id: string, tgId: number, token: string) {
      db.prepare('INSERT OR REPLACE INTO cards (id, tg_id, token, created_at) VALUES (?, ?, ?, ?)').run(id, tgId, token, now());
      db.prepare('DELETE FROM cards WHERE created_at < ?').run(now() - 30 * 86400);
    },
    setCardMessage(id: string, msgId: number) {
      db.prepare('UPDATE cards SET msg_id = ? WHERE id = ?').run(msgId, id);
    },
    /** The most recent chat message showing a card for this user and token. */
    lastCardMessage(tgId: number, token: string): number | undefined {
      const r = db.prepare('SELECT msg_id FROM cards WHERE tg_id = ? AND lower(token) = lower(?) AND msg_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1').get(tgId, token) as { msg_id: number } | undefined;
      return r?.msg_id;
    },
    getCard(id: string): { id: string; tg_id: number; token: string } | undefined {
      return db.prepare('SELECT id, tg_id, token FROM cards WHERE id = ?').get(id) as { id: string; tg_id: number; token: string } | undefined;
    },
    setStatusMessage(orderId: string, messageId: number) {
      db.prepare('UPDATE orders SET status_msg_id = ? WHERE id = ?').run(messageId, orderId);
    },
    // ---- Referrals --------------------------------------------------------------------------
    /** The user's invite code, created on first request. */
    refCode(tgId: number, make: () => string): string {
      const u = db.prepare('SELECT ref_code FROM users WHERE tg_id = ?').get(tgId) as { ref_code: string | null } | undefined;
      if (u?.ref_code) return u.ref_code;
      for (let i = 0; i < 5; i++) {
        const code = make();
        try {
          db.prepare('UPDATE users SET ref_code = ? WHERE tg_id = ?').run(code, tgId);
          return code;
        } catch {
          /* collision on the unique index: try another */
        }
      }
      throw new Error('could not allocate an invite code');
    },
    userByRefCode(code: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE ref_code = ?').get(code) as UserRow | undefined;
    },
    /** Attach a referrer once, only to a user without a wallet yet and never to themselves. */
    setReferrer(tgId: number, referrerTg: number): boolean {
      const r = db.prepare('UPDATE users SET referrer_tg = ?, referred_at = ? WHERE tg_id = ? AND referrer_tg IS NULL AND account IS NULL AND tg_id != ?').run(referrerTg, now(), tgId, referrerTg);
      return Number(r.changes) === 1;
    },
    addReward(r: { orderId: string; referrer: number; referee: number; amountQms: string }) {
      db.prepare('INSERT OR IGNORE INTO referral_rewards (order_id, referrer_tg, referee_tg, amount_qms, created_at) VALUES (?, ?, ?, ?, ?)').run(r.orderId, r.referrer, r.referee, r.amountQms, now());
    },
    referralStats(tgId: number) {
      const invited = (db.prepare('SELECT count(*) AS n FROM users WHERE referrer_tg = ?').get(tgId) as { n: number }).n;
      const trading = (db.prepare('SELECT count(*) AS n FROM users WHERE referrer_tg = ? AND account IS NOT NULL').get(tgId) as { n: number }).n;
      const rows = db.prepare('SELECT amount_qms, paid_tx FROM referral_rewards WHERE referrer_tg = ?').all(tgId) as { amount_qms: string; paid_tx: string | null }[];
      const earned = rows.reduce((s, r) => s + BigInt(r.amount_qms), 0n);
      const paid = rows.filter((r) => r.paid_tx).reduce((s, r) => s + BigInt(r.amount_qms), 0n);
      return { invited, trading, earned, paid };
    },
    unpaidRewards(): { referrer_tg: number; total: string; ids: string }[] {
      return db.prepare("SELECT referrer_tg, CAST(sum(CAST(amount_qms AS INTEGER)) AS TEXT) AS total, group_concat(order_id) AS ids FROM referral_rewards WHERE paid_tx IS NULL GROUP BY referrer_tg").all() as { referrer_tg: number; total: string; ids: string }[];
    },
    markRewardsPaid(orderIds: string[], tx: string) {
      const st = db.prepare('UPDATE referral_rewards SET paid_tx = ? WHERE order_id = ? AND paid_tx IS NULL');
      for (const id of orderIds) st.run(tx, id);
    },

    // ---- Groups ------------------------------------------------------------------------------
    upsertGroup(chatId: number, title: string | null) {
      db.prepare('INSERT INTO groups (chat_id, title, added_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title').run(chatId, title, now());
    },
    groupAlerts(chatId: number): boolean {
      const g = db.prepare('SELECT alerts FROM groups WHERE chat_id = ?').get(chatId) as { alerts: number } | undefined;
      return g ? g.alerts === 1 : true;
    },
    setGroupAlerts(chatId: number, on: boolean) {
      db.prepare('INSERT INTO groups (chat_id, alerts, added_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET alerts = excluded.alerts').run(chatId, on ? 1 : 0, now());
    },
    /** True if this token was already flagged in this chat within `withinSec`; otherwise records it now. */
    alertSeen(chatId: number, token: string, withinSec: number): boolean {
      const r = db.prepare('SELECT at FROM group_alerts WHERE chat_id = ? AND token = ?').get(chatId, token.toLowerCase()) as { at: number } | undefined;
      if (r && now() - r.at < withinSec) return true;
      db.prepare('INSERT OR REPLACE INTO group_alerts (chat_id, token, at) VALUES (?, ?, ?)').run(chatId, token.toLowerCase(), now());
      return false;
    },
    hasGroup(chatId: number): boolean {
      return Boolean(db.prepare('SELECT 1 FROM groups WHERE chat_id = ?').get(chatId));
    },
    getBatch(id: number): { id: number; tx_hash: string; block: number } | undefined {
      return db.prepare('SELECT id, tx_hash, block FROM batches WHERE id = ?').get(id) as { id: number; tx_hash: string; block: number } | undefined;
    },
    groupCount(): number {
      return (db.prepare('SELECT count(*) AS n FROM groups').get() as { n: number }).n;
    },

    lastBatchId(): number {
      return (db.prepare('SELECT coalesce(max(id), 0) AS n FROM batches').get() as { n: number }).n;
    },
    stats() {
      return db.prepare("SELECT count(*) AS trades, count(DISTINCT tg_id) AS users FROM orders WHERE status = 'filled'").get() as { trades: number; users: number };
    },
  };
}

export type Db = ReturnType<typeof openDb>;
