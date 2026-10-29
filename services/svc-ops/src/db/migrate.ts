import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';

/** Ops-owned migration journal; one transaction and advisory lock per deployment. */
export async function migrateOutreach(sql: Sql, direction: 'up' | 'down' = 'up'): Promise<void> {
  const names = [
    '0000_outreach_crm',
    '0001_crm_workflows',
    '0002_crm_notifications',
    '0003_crm_privacy',
    '0004_crm_retention',
    '0005_crm_erasure_publication',
    '0006_restore_stamps',
    '0007_alert_rules',
    '0008_alert_state',
    '0009_venue_costs',
    '0010_compliance_cases',
    '0011_protocol_listing',
    '0012_restore_runs',
    '0013_protocol_reason_codes',
    '0014_alert_desk',
    '0015_public_settings',
    '0016_alert_notify',
    '20261024080000_console_mode',
    '20261024100000_console_announcements',
    '20261024110000_service_records',
    '20261024160000_staff_holds',
    '20261024200000_staff_hold_rechecks',
    '20261029180000_reconciliation_alerts',
  ];
  const migrations = await Promise.all(
    (direction === 'down' ? [...names].reverse() : names).map(async (name) => ({
      name,
      source: await readFile(new URL(`../../drizzle/${name}${direction === 'down' ? '.down' : ''}.sql`, import.meta.url), 'utf8'),
    })),
  );
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('ops.crm.migrations'))`;
    // A preprovisioned service role owns its schema, without database CREATE.
    // PostgreSQL checks database CREATE even for CREATE SCHEMA IF NOT EXISTS.
    const schema = await tx`SELECT 1 FROM pg_namespace WHERE nspname='ops'`;
    if (!schema.length) await tx`CREATE SCHEMA ops`;
    await tx`CREATE TABLE IF NOT EXISTS ops.crm_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const migration of migrations) {
      const done = await tx`SELECT name FROM ops.crm_migrations WHERE name = ${migration.name}`;
      if (direction === 'down') {
        if (!done.length) continue;
        await tx.unsafe(migration.source);
        await tx`DELETE FROM ops.crm_migrations WHERE name = ${migration.name}`;
      } else if (!done.length) {
        await tx.unsafe(migration.source);
        await tx`INSERT INTO ops.crm_migrations(name) VALUES (${migration.name})`;
      }
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('ops.crm.storage_unconfigured');
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => undefined });
  try {
    await migrateOutreach(sql, process.argv[2] === 'down' ? 'down' : 'up');
  } finally {
    await sql.end();
  }
}
