import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Migration runner — same shape as every other service (§14, SERVICE_TEMPLATE).
 *
 * Applies every `NNNN_*.sql` in order, tracked in `indexer.__migrations` so a
 * re-run is a no-op. `--down` reverses only names recorded in that table, newest
 * file first, in one transaction. A missing reversal throws. CI — and a human
 * before opening a PR — can prove reversibility rather than assert it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const down = process.argv.includes('--down');

/** Runs as the schema owner. That role holds no database-level CREATE (§2). */
const url = process.env.DATABASE_URL ?? 'postgres://svc_indexer:svc_indexer@localhost:5433/intafaced';
const sql = postgres(url, { max: 1, onnotice: () => undefined });

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS indexer.__migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const all = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  const ups = all.filter((f) => !f.endsWith('.down.sql')).sort();

  if (down) {
    // One transaction: a later reversal throw rolls back newer reversals from
    // this run, and their tracking rows stay. The up loop below stays autocommit.
    await sql.begin(async (tx) => {
      const applied = await tx<Array<{ name: string }>>`
        SELECT name FROM indexer.__migrations ORDER BY name DESC
      `;
      for (const { name } of applied) {
        const downFile = name.replace(/\.sql$/, '.down.sql');
        const downPath = join(migrationsDir, downFile);
        if (!existsSync(downPath)) {
          throw new Error(`missing reversal ${downFile} for applied migration ${name}`);
        }
        console.log(`↓ ${downFile}`);
        await tx.unsafe(readFileSync(downPath, 'utf8'));
        await tx`DELETE FROM indexer.__migrations WHERE name = ${name}`;
      }
    });
    console.log('✓ reversed');
    return;
  }

  const applied = new Set((await sql<Array<{ name: string }>>`SELECT name FROM indexer.__migrations`).map((r) => r.name));

  for (const file of ups) {
    if (applied.has(file)) {
      console.log(`· ${file} (already applied)`);
      continue;
    }
    console.log(`↑ ${file}`);
    await sql.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
    await sql`INSERT INTO indexer.__migrations (name) VALUES (${file})`;
  }

  console.log('✓ migrations up to date');
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
