import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Migration runner.
 *
 * Applies every `NNNN_*.sql` in order, tracked in `notify.__migrations` so a
 * re-run is a no-op. The file and the ledger row are one transaction: the
 * INSERT or DELETE claims the name, and only then does the SQL run. A crash
 * rolls both back. A second runner that loses the claim skips the file.
 * Pass `--down` to apply reversals in reverse order — which exists so CI can
 * prove the migrations are reversible (§14), not because anyone should run it
 * against a database holding real inboxes. A down whose name is already gone
 * is a no-op, so two overlapping reversals do not both run the file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const down = process.argv.includes('--down');

/**
 * Migrations run as the schema's OWNER, not as an admin role. The dev database
 * grants each service its own schema and nothing else, so a migration that
 * strays outside `notify` fails here rather than in production.
 */
const url = process.env.DATABASE_URL ?? 'postgres://svc_notify:svc_notify@localhost:5433/intafaced';
const sql = postgres(url, { max: 1, onnotice: () => undefined });

async function ensureLedger(): Promise<void> {
  // The schema comes from the database bootstrap, not from here — this role has
  // no database-level CREATE, by design. The ledger table is the runner's own
  // bookkeeping and is idempotent; each file below is not.
  await sql`
    CREATE TABLE IF NOT EXISTS notify.__migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

/** Claim the name, then run the file. Both commit, or neither does. */
async function applyFile(file: string): Promise<boolean> {
  const body = readFileSync(join(migrationsDir, file), 'utf8');
  return sql.begin(async (tx) => {
    const claimed = await tx<{ name: string }[]>`
      INSERT INTO notify.__migrations (name)
      VALUES (${file})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `;
    if (claimed.length === 0) return false;
    await tx.unsafe(body);
    return true;
  });
}

/** Drop the name, then run the reversal. Both commit, or neither does. */
async function reverseFile(up: string): Promise<boolean> {
  const downFile = up.replace(/\.sql$/, '.down.sql');
  const body = readFileSync(join(migrationsDir, downFile), 'utf8');
  return sql.begin(async (tx) => {
    const claimed = await tx<{ name: string }[]>`
      DELETE FROM notify.__migrations
      WHERE name = ${up}
      RETURNING name
    `;
    if (claimed.length === 0) return false;
    await tx.unsafe(body);
    return true;
  });
}

async function main() {
  await ensureLedger();

  const all = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  const ups = all.filter((f) => !f.endsWith('.down.sql')).sort();

  if (down) {
    for (const up of [...ups].reverse()) {
      const downFile = up.replace(/\.sql$/, '.down.sql');
      const reversed = await reverseFile(up);
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
