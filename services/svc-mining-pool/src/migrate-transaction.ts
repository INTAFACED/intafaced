import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';

/**
 * The file body and the mining_pool.__migrations write share one transaction.
 * If the bookkeeping write fails, Postgres rolls the body back with it.
 */
export async function applyMigrationUp(sql: Sql, name: string, body: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
    await tx`INSERT INTO mining_pool.__migrations (name) VALUES (${name})`;
  });
}

/** Same boundary as up: the down body and the delete of that name. */
export async function applyMigrationDown(sql: Sql, name: string, body: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
    await tx`DELETE FROM mining_pool.__migrations WHERE name = ${name}`;
  });
}

/**
 * Latest filename first, and only names already recorded in mining_pool.__migrations.
 * A sibling .sql that was never applied is not reversed.
 */
export function reversalNames(upFiles: readonly string[], appliedNames: ReadonlySet<string>): string[] {
  return [...upFiles].reverse().filter((name) => appliedNames.has(name));
}

/**
 * Applies every `NNNN_*.sql` in `dir` in order, tracked in `mining_pool.__migrations`
 * so a re-run is a no-op. With `down`, reverses applied files latest first.
 * Returns the file names it changed.
 */
export async function runMigrations(
  sql: Sql,
  dir: string,
  options: { down?: boolean; log?: (line: string) => void } = {},
): Promise<string[]> {
  const log = options.log ?? (() => undefined);
  // The schema comes from the database bootstrap, not from here: the service
  // role has no database-level CREATE, by design.
  await sql`
    CREATE TABLE IF NOT EXISTS mining_pool.__migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const all = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const ups = all.filter((f) => !f.endsWith('.down.sql')).sort();
  const applied = new Set((await sql<Array<{ name: string }>>`SELECT name FROM mining_pool.__migrations`).map((r) => r.name));
  const changed: string[] = [];

  if (options.down) {
    for (const up of reversalNames(ups, applied)) {
      const downFile = up.replace(/\.sql$/, '.down.sql');
      log(`↓ ${downFile}`);
      await applyMigrationDown(sql, up, readFileSync(join(dir, downFile), 'utf8'));
      changed.push(up);
    }
    return changed;
  }

  for (const file of ups) {
    if (applied.has(file)) {
      log(`· ${file} (already applied)`);
      continue;
    }
    log(`↑ ${file}`);
    await applyMigrationUp(sql, file, readFileSync(join(dir, file), 'utf8'));
    changed.push(file);
  }
  return changed;
}
