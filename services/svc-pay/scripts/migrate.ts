import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Migration runner.
 *
 * Applies every `NNNN_*.sql` in order, tracked in `pay.__migrations` so a
 * re-run is a no-op. Pass `--down` to apply reversals in reverse order — which
 * exists so CI can prove the migrations are reversible, not because anyone
 * should run it against a database holding live merchant settlements.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const down = process.argv.includes('--down');

/**
 * Migrations run as the schema's OWNER, not as an admin role. The dev database
 * grants each service its own schema and nothing else, so a migration that
 * strays outside `pay` fails here rather than in production.
 */
const url = process.env.DATABASE_URL ?? 'postgres://svc_pay:svc_pay@localhost:5433/intafaced';
const sql = postgres(url, { max: 1, onnotice: () => undefined });

async function main() {
  // The journal and its schema changes must commit together. Competing boots
  // serialize here; a failed DDL statement leaves no partially-applied receipt.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('pay.schema_migrations'))`;
    // The schema comes from the database bootstrap, not from here — this role has
    // no database-level CREATE, by design.
    await tx`
    CREATE TABLE IF NOT EXISTS pay.__migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

    const all = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    const ups = all.filter((f) => !f.endsWith('.down.sql')).sort();
    const applied = new Set((await tx<Array<{ name: string }>>`SELECT name FROM pay.__migrations`).map((r) => r.name));

    if (down) {
      for (const up of [...ups].reverse()) {
        if (!applied.has(up)) continue;
        const downFile = up.replace(/\.sql$/, '.down.sql');
        console.log(`↓ ${downFile}`);
        await tx.unsafe(readFileSync(join(migrationsDir, downFile), 'utf8'));
        await tx`DELETE FROM pay.__migrations WHERE name = ${up}`;
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
      await tx.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
      await tx`INSERT INTO pay.__migrations (name) VALUES (${file})`;
    }

    console.log('✓ migrations up to date');
  });
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
