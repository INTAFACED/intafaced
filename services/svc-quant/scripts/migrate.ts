import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Applies every `NNNN_*.sql` in drizzle/, tracked in `quant.__migrations`.
 * DATABASE_URL is required. There is no localhost default.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const down = process.argv.includes('--down');

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('quant.database_url_unset — DATABASE_URL is unset');
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => undefined });

async function main() {
  // postgres-init creates schema quant owned by svc_quant. That role has no
  // database CREATE, and CREATE SCHEMA IF NOT EXISTS still checks it (42501)
  // even when the schema already exists. Create only when it is missing.
  const existing = await sql`SELECT 1 FROM pg_namespace WHERE nspname = 'quant'`;
  if (existing.length === 0) await sql`CREATE SCHEMA quant`;
  await sql`
    CREATE TABLE IF NOT EXISTS quant.__migrations (
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
      await sql.unsafe(readFileSync(join(migrationsDir, downFile), 'utf8'));
      await sql`DELETE FROM quant.__migrations WHERE name = ${up}`;
    }
    console.log('✓ reversed');
    return;
  }

  const applied = new Set((await sql<Array<{ name: string }>>`SELECT name FROM quant.__migrations`).map((r) => r.name));

  for (const file of ups) {
    if (applied.has(file)) {
      console.log(`· ${file} (already applied)`);
      continue;
    }
    console.log(`↑ ${file}`);
    await sql.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
    await sql`INSERT INTO quant.__migrations (name) VALUES (${file})`;
  }

  console.log('✓ migrations up to date');
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
