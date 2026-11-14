/**
 * Copies a local SQLite database into the Turso database (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN), table by table,
 * then reads the counts back from Turso through a fresh replica. Refuses to write into a non-empty Turso database.
 *
 *   npx tsx scripts/copy-to-turso.ts <source.sqlite>
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = process.argv[2];
if (!source) throw new Error('usage: copy-to-turso.ts <source.sqlite>');

// Read Turso settings from contracts/.env without printing them.
const envText = readFileSync(join(import.meta.dirname, '..', '..', 'contracts', '.env'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^(TURSO_DATABASE_URL|TURSO_AUTH_TOKEN)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^"|"$/g, '');
}
if (!process.env.TURSO_DATABASE_URL?.startsWith('libsql://') || !process.env.TURSO_AUTH_TOKEN) throw new Error('TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing or malformed in contracts/.env');

const Libsql = createRequire(import.meta.url)('libsql');
const { openDb } = await import('../src/db.js');

// 1. Create the schema in Turso through the app's own code path.
const replicaDir = mkdtempSync(join(tmpdir(), 'qalibre-turso-'));
openDb(join(replicaDir, 'schema.sqlite'));

// 2. Copy rows over a direct replica connection.
const src = new Libsql(source, { readonly: true });
const dst = new Libsql(join(replicaDir, 'copy.sqlite'), { syncUrl: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN, readYourWrites: true });
dst.sync();
const tables: string[] = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r: { name: string }) => r.name);
for (const t of tables) {
  const existing = Number(dst.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n);
  if (existing > 0) throw new Error(`Turso table ${t} already has ${existing} rows; refusing to overwrite.`);
}
for (const t of tables) {
  const rows = src.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[];
  for (const row of rows) {
    delete row._metadata;
    const cols = Object.keys(row);
    dst.prepare(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
  }
}
dst.sync();

// 3. Verify from a brand-new replica, i.e. what Turso itself now holds.
const check = new Libsql(join(replicaDir, 'verify.sqlite'), { syncUrl: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
check.sync();
let ok = true;
for (const t of tables) {
  const a = Number(src.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n);
  const b = Number(check.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n);
  console.log(`${t.padEnd(18)} local ${String(a).padStart(4)}  turso ${String(b).padStart(4)}${a === b ? '' : '  MISMATCH'}`);
  if (a !== b) ok = false;
}
console.log(ok ? 'All tables match.' : 'Some tables do not match.');
process.exit(ok ? 0 : 1);
