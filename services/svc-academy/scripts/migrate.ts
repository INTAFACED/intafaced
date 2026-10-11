import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres, { type Sql } from 'postgres';

/**
 * Migration runner.
 *
 * Applies every `NNNN_*.sql` in order, tracked in `academy.__migrations` so a
 * re-run is a no-op. Pass `--down` to apply reversals in reverse order — which
 * exists so CI can prove the migrations are reversible (§14), not because
 * anyone should run it against a database holding live lobbies and certifications.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');

/**
 * Apply every pending up file in `dir`, recording each name in
 * `<schema>.__migrations`. The schema defaults to `academy`.
 *
 * The file and the `__migrations` insert share one transaction. An advisory
 * lock is held until that transaction commits, so a second runner waits, sees
 * the row, and does not execute the file again.
 */
export async function applyPendingUp(sql: Sql, dir: string, schema = 'academy'): Promise<void> {
  const all = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const ups = all.filter((f) => !f.endsWith('.down.sql')).sort();
  const lockKey = `${schema}.__migrations`;

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(schema)}.__migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  });

  const applied = new Set((await sql<Array<{ name: string }>>`SELECT name FROM ${sql(schema)}.__migrations`).map((r) => r.name));

  for (const file of ups) {
    if (applied.has(file)) {
      console.log(`· ${file} (already applied)`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
      const seen = await tx<Array<{ name: string }>>`
        SELECT name FROM ${tx(schema)}.__migrations WHERE name = ${file}
      `;
      if (seen.length > 0) {
        console.log(`· ${file} (already applied)`);
        return;
      }
      console.log(`↑ ${file}`);
      await tx.unsafe(readFileSync(join(dir, file), 'utf8'));
      await tx`INSERT INTO ${tx(schema)}.__migrations (name) VALUES (${file})`;
    });
  }

  console.log('✓ migrations up to date');
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

async function main(): Promise<void> {
  const down = process.argv.includes('--down');
  /**
   * Migrations run as the schema's OWNER, not as an admin role. The dev database
   * grants each service its own schema and nothing else, so a migration that
   * strays outside `academy` fails here rather than in production.
   */
  const url = process.env.DATABASE_URL ?? 'postgres://svc_academy:svc_academy@localhost:5433/intafaced';
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    if (down) {
      // The schema comes from the database bootstrap, not from here — this role has
      // no database-level CREATE, by design.
      await sql`
        CREATE TABLE IF NOT EXISTS academy.__migrations (
          name       text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      const all = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
      const ups = all.filter((f) => !f.endsWith('.down.sql')).sort();
      for (const up of [...ups].reverse()) {
        const downFile = up.replace(/\.sql$/, '.down.sql');
        console.log(`↓ ${downFile}`);
        await sql.unsafe(readFileSync(join(migrationsDir, downFile), 'utf8'));
        await sql`DELETE FROM academy.__migrations WHERE name = ${up}`;
      }
      console.log('✓ reversed');
      return;
    }

    await applyPendingUp(sql, migrationsDir);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (isDirectRun()) {
  await main();
}
