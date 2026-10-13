import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = join(here, '..', 'drizzle');

/**
 * Each up file and its tracking row commit together. Down reverses only the
 * recorded names, in one transaction. A shared transaction lock serializes
 * bootstrap and migration claims, including concurrent service processes.
 * Tests pass their own migration directory, never write into the service tree.
 */
export async function runMigrations(sql: Sql, migrationsDir = defaultMigrationsDir, down = false): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('indexer.migrations')::bigint)`;
    await tx`
      CREATE TABLE IF NOT EXISTS indexer.__migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  });

  const ups = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();

  if (down) {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('indexer.migrations')::bigint)`;
      const applied = await tx<Array<{ name: string }>>`
        SELECT name FROM indexer.__migrations ORDER BY name DESC
      `;
      for (const { name } of applied) {
        const downFile = name.replace(/\.sql$/, '.down.sql');
        const downPath = join(migrationsDir, downFile);
        if (!existsSync(downPath)) throw new Error(`missing reversal ${downFile} for applied migration ${name}`);
        console.log(`↓ ${downFile}`);
        await tx.unsafe(readFileSync(downPath, 'utf8'));
        await tx`DELETE FROM indexer.__migrations WHERE name = ${name}`;
      }
    });
    console.log('✓ reversed');
    return;
  }

  for (const file of ups) {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('indexer.migrations')::bigint)`;
      // Re-read under the lock: another runner may have just applied this file.
      const applied = await tx<Array<{ name: string }>>`SELECT name FROM indexer.__migrations WHERE name = ${file}`;
      if (applied.length !== 0) {
        console.log(`· ${file} (already applied)`);
        return;
      }
      console.log(`↑ ${file}`);
      await tx.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
      await tx`INSERT INTO indexer.__migrations (name) VALUES (${file})`;
    });
  }
  console.log('✓ migrations up to date');
}

// Importing the runner in tests does not connect to a fleet/default database.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL ?? 'postgres://svc_indexer:svc_indexer@localhost:5433/intafaced';
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await runMigrations(sql, defaultMigrationsDir, process.argv.includes('--down'));
  } finally {
    await sql.end({ timeout: 5 });
  }
}
