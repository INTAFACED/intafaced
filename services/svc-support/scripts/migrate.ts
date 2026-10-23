import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Migration runner for support schema.
 *
 * Applies every `NNNN_*.sql` in order, tracked in `support.__migrations`.
 * That directory is the registry: 0031_help_centre.sql follows 0029 (the highest on origin/main).
 * 0030 is reserved for the desk-views migration. Pass `--down` to reverse (CI reversibility, not for live desks).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const down = process.argv.includes('--down');

const url = process.env.DATABASE_URL ?? 'postgres://svc_support:svc_support@localhost:5433/intafaced';
const sql = postgres(url, { max: 1, onnotice: () => undefined });

/** Each file and its journal row commit together; the batch is not atomic. */
async function applyFile(file: string): Promise<boolean> {
  const body = readFileSync(join(migrationsDir, file), 'utf8');
  return sql.begin(async (tx) => {
    const claimed = await tx<{ name: string }[]>`
      INSERT INTO support.__migrations (name) VALUES (${file})
      ON CONFLICT (name) DO NOTHING RETURNING name
    `;
    if (claimed.length === 0) return false;
    await tx.unsafe(body);
    return true;
  });
}

async function reverseFile(file: string): Promise<boolean> {
  const body = readFileSync(join(migrationsDir, file.replace(/\.sql$/, '.down.sql')), 'utf8');
  return sql.begin(async (tx) => {
    const claimed = await tx<{ name: string }[]>`
      DELETE FROM support.__migrations WHERE name = ${file} RETURNING name
    `;
    if (claimed.length === 0) return false;
    await tx.unsafe(body);
    return true;
  });
}

async function main() {
  // Serialize only bootstrap: concurrent CREATE TABLE IF NOT EXISTS can still
  // race on catalog rows. No schema or application data is created here.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('support.__migrations.bootstrap'))`;
    await tx`
      CREATE TABLE IF NOT EXISTS support.__migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  });
  const ups = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();

  if (down) {
    for (const file of [...ups].reverse()) {
      const reversed = await reverseFile(file);
      const downFile = file.replace(/\.sql$/, '.down.sql');
      console.log(reversed ? `↓ ${downFile}` : `· ${downFile} (already reversed)`);
    }
    console.log('✓ reversed');
    return;
  }
  for (const file of ups) {
    const applied = await applyFile(file);
    console.log(applied ? `↑ ${file}` : `· ${file} (already applied)`);
  }
  console.log('✓ migrations up to date');
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
