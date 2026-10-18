import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Migration runner.
 *
 * Applies every `NNNN_*.sql` in order, tracked in `p2p.__migrations` so a
 * re-run is a no-op. Pass `--down` to apply reversals in reverse order — which
 * exists so CI can prove the migrations are reversible (§14 DoD 1), not because
 * anyone should run it against a database with live escrows in it. See the
 * warning at the top of the `.down.sql`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const down = process.argv.includes('--down');

/**
 * Migrations run as the schema's OWNER, not as an admin role. The dev database
 * grants each service its own schema and nothing else, so a migration that
 * strays outside `p2p` fails here rather than in production.
 */
const url = process.env.DATABASE_URL ?? 'postgres://svc_p2p:svc_p2p@localhost:5433/intafaced';
const sql = postgres(url, { max: 1, onnotice: () => undefined });

async function main() {
  // The schema comes from the database bootstrap, not from here — this role has
  // no database-level CREATE, by design.
  await sql`
    CREATE TABLE IF NOT EXISTS p2p.__migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const all = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  const ups = all.filter((f) => !f.endsWith('.down.sql')).sort();

  if (down) {
    for (const up of [...ups].reverse()) {
      const downFile = up.replace(/\.sql$/, '.down.sql');
      console.log(`↓ ${downFile}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(join(migrationsDir, downFile), 'utf8'));
        await tx`DELETE FROM p2p.__migrations WHERE name = ${up}`;
      });
    }
    console.log('✓ reversed');
    return;
  }

  const applied = new Set((await sql<Array<{ name: string }>>`SELECT name FROM p2p.__migrations`).map((r) => r.name));

  for (const file of ups) {
    if (applied.has(file)) {
      console.log(`· ${file} (already applied)`);
      continue;
    }
    console.log(`↑ ${file}`);
    await sql.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
    await sql`INSERT INTO p2p.__migrations (name) VALUES (${file})`;
  }

  console.log('✓ migrations up to date');
}

try {
  await main();
} finally {
  // One-shot CLI: the migrations have already committed or rolled back. Waiting
  // out a graceful drain (up to 5s) under a loaded CI Postgres is how the
  // down-runner test crossed its 15s budget three times per run.
  await sql.end({ timeout: 0 });
}
