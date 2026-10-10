import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { applyMigrationDown, applyMigrationUp, reversalNames } from '../src/migrate-transaction.js';

/**
 * Migration runner.
 *
 * Applies every `NNNN_*.sql` in order, tracked in `bank.__migrations` so a
 * re-run is a no-op. Pass `--down` to apply reversals in reverse order — which
 * exists so CI can prove the migrations are reversible (§14), not because
 * anyone should run it against a database with live standing orders in it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const down = process.argv.includes('--down');

/**
 * Migrations run as the schema's OWNER, not as an admin role. The dev database
 * grants each service its own schema and nothing else, so a migration that
 * strays outside `bank` fails here rather than in production (§2).
 */
const url = process.env.DATABASE_URL ?? 'postgres://svc_bank:svc_bank@localhost:5433/intafaced';
const sql = postgres(url, { max: 1, onnotice: () => undefined });

async function main() {
  // The schema comes from the database bootstrap, not from here — this role has
  // no database-level CREATE, by design.
  await sql`
    CREATE TABLE IF NOT EXISTS bank.__migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const all = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  const ups = all.filter((f) => !f.endsWith('.down.sql')).sort();

  const applied = new Set((await sql<Array<{ name: string }>>`SELECT name FROM bank.__migrations`).map((r) => r.name));

  if (down) {
    for (const up of reversalNames(ups, applied)) {
      const downFile = up.replace(/\.sql$/, '.down.sql');
      console.log(`↓ ${downFile}`);
      await applyMigrationDown(sql, up, readFileSync(join(migrationsDir, downFile), 'utf8'));
    }
    console.log('✓ reversed');
    return;
  }

  for (const file of ups) {
    if (applied.has(file)) {
      console.log(`· ${file} (already applied)`);
      continue;
    }
    console.log(`↑ ${file}`);
    await applyMigrationUp(sql, file, readFileSync(join(migrationsDir, file), 'utf8'));
  }

  console.log('✓ migrations up to date');
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
