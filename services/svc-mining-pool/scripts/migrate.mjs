/**
 * Migration runner for mining_pool.
 *
 * Applies every `NNNN_*.sql` in order, tracked in `mining_pool.__migrations`.
 * Each file and its bookkeeping row commit together. Pass `--down` to reverse
 * applied files only, each in its own transaction. `--self-check` lists the
 * files and does not open a database.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const schema = 'mining_pool';

export async function applyPendingUp(sql, dir = migrationsDir) {
  const ups = upFilesFrom(dir);
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

  const applied = new Set((await sql`SELECT name FROM ${sql(schema)}.__migrations`).map((r) => r.name));

  for (const file of ups) {
    if (applied.has(file)) {
      console.log(`· ${file} (already applied)`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
      const seen = await tx`SELECT name FROM ${tx(schema)}.__migrations WHERE name = ${file}`;
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

function upFilesFrom(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
}

export async function reverseApplied(sql, dir = migrationsDir) {
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

  const applied = await sql`SELECT name FROM ${sql(schema)}.__migrations ORDER BY name DESC`;
  for (const { name } of applied) {
    const downFile = name.replace(/\.sql$/, '.down.sql');
    if (!existsSync(join(dir, downFile))) throw new Error(`missing reversal ${downFile}`);
  }

  for (const { name } of applied) {
    const downFile = name.replace(/\.sql$/, '.down.sql');
    console.log(`↓ ${downFile}`);
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
      await tx.unsafe(readFileSync(join(dir, downFile), 'utf8'));
      await tx`DELETE FROM ${tx(schema)}.__migrations WHERE name = ${name}`;
    });
  }
  console.log('✓ reversed');
}

function selfCheck() {
  const ups = upFilesFrom(migrationsDir);
  if (ups.length === 0) {
    console.error('no mining_pool migrations');
    process.exit(1);
  }
  const missing = ups.filter((name) => !existsSync(join(migrationsDir, name.replace(/\.sql$/, '.down.sql'))));
  if (missing.length > 0) {
    console.error(`missing reversal for ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`✓ ${ups.length} mining_pool migration(s), reversals present`);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

async function main() {
  if (process.argv.includes('--self-check')) {
    selfCheck();
    return;
  }
  const down = process.argv.includes('--down');
  const { default: postgres } = await import('postgres');
  const url = process.env.DATABASE_URL ?? 'postgres://svc_mining_pool:svc_mining_pool@localhost:5433/intafaced';
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    if (down) await reverseApplied(sql);
    else await applyPendingUp(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (isDirectRun()) {
  await main();
}
