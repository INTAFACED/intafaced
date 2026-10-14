import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations } from '../src/migrate-transaction.js';

/**
 * Migration runner.
 *
 * Applies every `NNNN_*.sql` in order, tracked in `mining_pool.__migrations` so
 * a re-run is a no-op. Pass `--down` to apply reversals in reverse order, which
 * exists so CI can prove the migrations are reversible, not because anyone
 * should run it against a database that holds live windows or shares.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const down = process.argv.includes('--down');

/**
 * Migrations run as the schema's OWNER, not as an admin role. The dev database
 * grants each service its own schema and nothing else, so a migration that
 * strays outside `mining_pool` fails here rather than in production.
 */
const url = process.env.DATABASE_URL ?? 'postgres://svc_mining_pool:svc_mining_pool@localhost:5433/intafaced';
const sql = postgres(url, { max: 1, onnotice: () => undefined });

try {
  await runMigrations(sql, migrationsDir, { down, log: (line) => console.log(line) });
  console.log(down ? '✓ reversed' : '✓ migrations up to date');
} finally {
  await sql.end({ timeout: 5 });
}
