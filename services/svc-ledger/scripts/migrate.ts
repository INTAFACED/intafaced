import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Migration runner.
 *
 * Applies every `NNNN_*.sql` in order, tracked in `ledger.__migrations`.
 * Each file and its bookkeeping row commit together under a transaction lock,
 * so a crash or a second runner cannot replay a half-applied file.
 * `--down` refuses when `ledger.ledger_tx` has any row, and if any `.down.sql`
 * is missing, before it reverses anything.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const down = process.argv.includes('--down');

/**
 * Migrations run as the schema's OWNER, not as an admin role. The dev database
 * grants each service its own schema and nothing else, so a migration that
 * strays outside `ledger` fails here rather than in production.
 */
const url = process.env.DATABASE_URL ?? 'postgres://svc_ledger:svc_ledger@localhost:5433/intafaced';

export type MigrateTx = {
  unsafe(query: string): Promise<unknown>;
  <T extends readonly unknown[] = readonly unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
};

export type MigrateClient = MigrateTx & {
  begin<T>(cb: (tx: MigrateTx) => Promise<T>): Promise<T>;
};

/** Same key for up and down so two runners cannot apply one file. */
function lockMigrate(tx: MigrateTx): Promise<readonly unknown[]> {
  return tx`SELECT pg_advisory_xact_lock(hashtext('ledger.migrate')::bigint)`;
}

export async function runMigrations(sql: MigrateClient, opts: { migrationsDir: string; down: boolean }): Promise<void> {
  // The bootstrap schema is owned by this service. Serialize tracking DDL too.
  await sql.begin(async (tx) => {
    await lockMigrate(tx);
    await tx`
      CREATE TABLE IF NOT EXISTS ledger.__migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  });

  const all = readdirSync(opts.migrationsDir).filter((f) => f.endsWith('.sql'));
  const ups = all.filter((f) => !f.endsWith('.down.sql')).sort();

  if (opts.down) {
    const reversals = ups.map((up) => ({ up, downFile: up.replace(/\.sql$/, '.down.sql') }));
    // One transaction owns the book check, every reversal, and its tracking row.
    await sql.begin(async (tx) => {
      await lockMigrate(tx);
      const applied = new Set((await tx<Array<{ name: string }>>`SELECT name FROM ledger.__migrations`).map((row) => row.name));
      const selected = reversals.filter((rev) => applied.has(rev.up));
      for (const rev of selected) {
        if (!existsSync(join(opts.migrationsDir, rev.downFile))) {
          throw new Error(`refusing --down: missing ${rev.downFile}`);
        }
      }
      if (applied.has('0000_ledger_init.sql')) {
        await tx`SELECT id FROM ledger.chain_tip WHERE id = true FOR UPDATE`;
        await tx`LOCK TABLE ledger.ledger_tx IN SHARE ROW EXCLUSIVE MODE`;
        const existing = await tx`SELECT 1 FROM ledger.ledger_tx LIMIT 1`;
        if (existing.length > 0) throw new Error('refusing --down: ledger.ledger_tx is not empty');
      }
      for (const rev of [...selected].reverse()) {
        console.log(`↓ ${rev.downFile}`);
        await tx.unsafe(readFileSync(join(opts.migrationsDir, rev.downFile), 'utf8'));
        await tx`DELETE FROM ledger.__migrations WHERE name = ${rev.up}`;
      }
    });
    console.log('✓ reversed');
    return;
  }

  for (const file of ups) {
    let already = false;
    await sql.begin(async (tx) => {
      await lockMigrate(tx);
      const rows = await tx<Array<{ name: string }>>`SELECT name FROM ledger.__migrations WHERE name = ${file}`;
      if (rows.length > 0) {
        already = true;
        return;
      }
      if (file === '0007_purposed_lock_kinds.sql') {
        await tx`LOCK TABLE ledger.accounts IN SHARE ROW EXCLUSIVE MODE`;
        const unnamed = await tx`SELECT id FROM ledger.accounts WHERE kind IN ('escrow', 'stake', 'collateral') AND purpose = '' LIMIT 1`;
        if (unnamed.length > 0) throw new Error('Cannot apply 0007: unnamed lock claim; refusing invented legacy purpose');
      }
      await tx.unsafe(readFileSync(join(opts.migrationsDir, file), 'utf8'));
      await tx`INSERT INTO ledger.__migrations (name) VALUES (${file})`;
    });
    console.log(already ? `· ${file} (already applied)` : `↑ ${file}`);
  }

  console.log('✓ migrations up to date');
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await runMigrations(sql as unknown as MigrateClient, { migrationsDir, down });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
