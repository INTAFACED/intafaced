#!/usr/bin/env node
/**
 * ONE-SHOT MIGRATION RUNNER — runs before any service starts.
 *
 * ── Why a one-shot container and not an entrypoint step ─────────────────────
 *
 * Three options were on the table:
 *
 *   (a) an entrypoint step in each service — "migrate, then start". Rejected:
 *       it runs once per REPLICA, so the moment anything scales past one the
 *       same migration races itself. `postgres` gives no cross-connection lock
 *       here, and a half-applied DDL is the one database failure that is not
 *       fixable by restarting.
 *
 *   (b) an init container per service (10 extra containers). Rejected: it is
 *       correct but it spreads one question — "did the schema apply?" — across
 *       ten places to look, and each one needs its own credentials block in
 *       compose. Ten copies of a credential is ten chances to get one wrong.
 *
 *   (c) THIS: a single container that runs every migration and exits, with the
 *       services gated on `condition: service_completed_successfully`.
 *
 * (c) wins because the migrations are genuinely independent. Doctrine §2 gives
 * each service its own schema and forbids cross-schema reads, so no migration
 * here depends on another having run — they can be applied in any order, and
 * the only ordering that matters is "all of them, before anything starts".
 * Compose enforces exactly that, and a failure is one container's logs.
 *
 * Every runner is idempotent (each tracks applied files in its own
 * `<schema>.__migrations` table), so re-running on every `up` is a no-op that
 * costs a second and removes "did you remember to migrate?" from the list of
 * things a clean clone can get wrong.
 *
 * ── Why each service migrates as its OWN role ───────────────────────────────
 *
 * `tooling/infra/postgres-init/01-service-schemas.sql` creates one role per
 * service, owning one schema, holding no database-level CREATE. A migration
 * that strays outside its own schema therefore fails HERE, in dev, with a
 * permission error — instead of becoming an architecture violation nobody
 * noticed until two services shared a table. Running everything as
 * `intafaced_ops` would throw that away, so we do not.
 *
 * svc-matching is absent on purpose: §5.1 gives it in-memory books and a file
 * journal, and no `DATABASE_URL` at all.
 * svc-mining-pool is listed: it ships drizzle SQL for mining_pool.windows
 * and mining_pool.shares, and compose gives it DATABASE_URL.
 * svc-quant is listed: it ships drizzle SQL for the paper strategy library,
 * and compose gives it DATABASE_URL.
 */
import { spawnSync } from 'node:child_process';

/** service directory name -> the postgres schema and role it owns. */
const SERVICES = [
  ['svc-identity', 'identity'],
  ['svc-ledger', 'ledger'],
  ['svc-token', 'token'],
  ['svc-trade', 'trade'],
  ['svc-pay', 'pay'],
  ['svc-p2p', 'p2p'],
  ['svc-blueprint', 'blueprint'],
  ['svc-bank', 'bank'],
  ['svc-agents', 'agents'],
  ['svc-protocol', 'protocol'],
  ['svc-indexer', 'indexer'],
  ['svc-notify', 'notify'],
  ['svc-support', 'support'],
  ['svc-academy', 'academy'],
  ['svc-market', 'market'],
  ['svc-mining-pool', 'mining_pool'],
  ['svc-ops', 'ops'],
  ['svc-quant', 'quant'],
];

const host = process.env.POSTGRES_HOST ?? 'postgres';
const port = process.env.POSTGRES_PORT ?? '5432';
const database = process.env.POSTGRES_DB ?? 'intafaced';

const failures = [];

for (const [service, schema] of SERVICES) {
  const url = `postgres://svc_${schema}:svc_${schema}@${host}:${port}/${database}`;
  console.log(`\n── ${service} (schema "${schema}", role "svc_${schema}")`);

  const result = spawnSync('pnpm', ['--filter', `@intafaced/${service}`, 'db:migrate'], {
    stdio: 'inherit',
    // The runner reads DATABASE_URL and nothing else. Passing it per-invocation
    // rather than setting one for the container is what keeps each migration
    // inside its own schema.
    env: { ...process.env, DATABASE_URL: url },
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) failures.push(`${service} (exit ${result.status ?? 'signal ' + result.signal})`);
}

if (failures.length > 0) {
  // Every failure, not just the first: an operator fixing a clean-clone setup
  // should see the whole list in one run rather than one per restart.
  console.error(`\n✖ migrations failed:\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}

console.log('\n✓ all schemas migrated\n');
