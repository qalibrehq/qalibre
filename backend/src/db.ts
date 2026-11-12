import { DatabaseSync } from 'node:sqlite';
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
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash TEXT,
      block INTEGER,
      trades INTEGER,
      qubo_mtx TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  for (const ddl of ['ALTER TABLE users ADD COLUMN pending_session_address TEXT', 'ALTER TABLE users ADD COLUMN pending_session_enc TEXT', 'ALTER TABLE users ADD COLUMN last_drip_at INTEGER NOT NULL DEFAULT 0', "ALTER TABLE orders ADD COLUMN max_network_fee TEXT NOT NULL DEFAULT '0'", 'ALTER TABLE orders ADD COLUMN network_fee TEXT', 'ALTER TABLE users ADD COLUMN settlement TEXT', "ALTER TABLE orders ADD COLUMN mode TEXT NOT NULL DEFAULT 'best'", 'ALTER TABLE orders ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE orders ADD COLUMN created_ms INTEGER']) {
    try {
      db.exec(ddl);
    } catch {
      /* column exists */
    }
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
    insertOrder(o: Omit<OrderRow, 'status' | 'reason' | 'tx_hash' | 'buy_amount' | 'fee' | 'direct_quote' | 'batch_id' | 'created_at' | 'updated_at' | 'confirmed' | 'created_ms' | 'network_fee'>) {
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
    lastBatchId(): number {
      return (db.prepare('SELECT coalesce(max(id), 0) AS n FROM batches').get() as { n: number }).n;
    },
    stats() {
      return db.prepare("SELECT count(*) AS trades, count(DISTINCT tg_id) AS users FROM orders WHERE status = 'filled'").get() as { trades: number; users: number };
    },
  };
}

export type Db = ReturnType<typeof openDb>;
