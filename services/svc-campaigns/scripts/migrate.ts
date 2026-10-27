import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Applies every `drizzle/*.sql` in order, tracked in `campaigns.__migrations`.
 * Pass `--down` to reverse them. The `campaigns` schema comes from the database bootstrap.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const down = process.argv.includes('--down');
const url = process.env.DATABASE_URL ?? 'postgres://svc_campaigns:svc_campaigns@localhost:5433/intafaced';
const sql = postgres(url, { max: 1, onnotice: () => undefined });

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS campaigns.__migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const all = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  const ups = all.filter((f) => !f.endsWith('.down.sql')).sort();

  if (down) {
    const applied = new Set((await sql<Array<{ name: string }>>`SELECT name FROM campaigns.__migrations`).map((r) => r.name));
    for (const up of [...ups].reverse()) {
      if (!applied.has(up)) continue;
      const downFile = up.replace(/\.sql$/, '.down.sql');
      console.log(`↓ ${downFile}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(join(migrationsDir, downFile), 'utf8'));
        await tx`DELETE FROM campaigns.__migrations WHERE name = ${up}`;
      });
    }
    console.log('✓ reversed');
    return;
  }

  const applied = new Set((await sql<Array<{ name: string }>>`SELECT name FROM campaigns.__migrations`).map((r) => r.name));
  for (const file of ups) {
    if (applied.has(file)) {
      console.log(`· ${file} (already applied)`);
      continue;
    }
    console.log(`↑ ${file}`);
    // The file and its record commit together: a failure part way leaves neither.
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
      await tx`INSERT INTO campaigns.__migrations (name) VALUES (${file})`;
    });
  }
  console.log('✓ migrations up to date');
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
