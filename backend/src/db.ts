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
  dripped: number;
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
  valid_to: number;
  nonce: string;
  signature: string;
  status: 'pending' | 'filled' | 'expired' | 'failed';
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
    setAccount(tgId: number, account: string) {
      db.prepare('UPDATE users SET account = ?, pending_setup = NULL WHERE tg_id = ?').run(account, tgId);
    },
    markDripped(tgId: number) {
      db.prepare('UPDATE users SET dripped = 1 WHERE tg_id = ?').run(tgId);
    },
    userByAccount(account: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE lower(account) = lower(?)').get(account) as UserRow | undefined;
    },
    insertOrder(o: Omit<OrderRow, 'status' | 'reason' | 'tx_hash' | 'buy_amount' | 'fee' | 'direct_quote' | 'batch_id' | 'created_at' | 'updated_at'>) {
      const t = now();
      db.prepare(`INSERT INTO orders (id, tg_id, account, sell_token, buy_token, sell_amount, min_buy_amount, valid_to, nonce, signature, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(o.id, o.tg_id, o.account, o.sell_token, o.buy_token, o.sell_amount, o.min_buy_amount, o.valid_to, o.nonce, o.signature, t, t);
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
    markFilled(id: string, f: { tx: string; buy: string; fee: string; direct: string; batchId: number }) {
      db.prepare("UPDATE orders SET status = 'filled', tx_hash = ?, buy_amount = ?, fee = ?, direct_quote = ?, batch_id = ?, updated_at = ? WHERE id = ?").run(f.tx, f.buy, f.fee, f.direct, f.batchId, now(), id);
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
