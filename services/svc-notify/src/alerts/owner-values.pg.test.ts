import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { assertTestDatabase } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { AlertOwnerValues } from './owner-values.js';

/**
 * The alert owner values on a real database (J-charts-desk-18 #6): the newest write for a plan is what applies, also once
 * a slot holds ten or more rows. Found on the local stack, 18 Nov 2026: the reads ordered by the text alias `id`
 * (`id::text AS id`), so row "9" sorted above row "10" and a saved quota kept reading as the one before it.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? 'postgres://svc_notify:svc_notify@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migration = (f: string) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8');

// Runs against a real database every time: CI provides it. Without one the suite fails, and says so.
const sql = postgres(URL, { max: 3, onnotice: () => undefined });
await assertTestDatabase(sql, 'svc-notify owner-values.pg.test');
// The table needs only its schema. On CI the service's migrations made both already, and the test role may not create a
// schema, so a refused create is fine; the table read below fails by name if neither is there.
await sql`CREATE SCHEMA IF NOT EXISTS notify`.catch(() => undefined);
await sql.unsafe(migration('20261107093559_alert_owner_values.sql')).catch(() => undefined);
await sql`SELECT 1 FROM notify.alert_owner_values LIMIT 1`;

// A plan id of this run only, so the rows here never meet another test's.
const PLAN = `t${randomBytes(6).toString('hex')}`;
afterAll(async () => {
  await sql`DELETE FROM notify.alert_owner_values WHERE plan = ${PLAN}`;
  await sql.end();
});

const founder = { sub: '00000000-0000-4000-8000-000000000001', scopes: ['admin:read', 'admin:write'] } as Principal;
const values = new AlertOwnerValues(
  sql,
  { maxActivePrice: 20, triggerLogDays: 7 },
  { defaultPlanId: PLAN, plans: [{ id: PLAN, name: 'TEST' }] },
);

describe('AlertOwnerValues on Postgres (J-charts-desk-18 #6)', () => {
  it('reads the newest write as current, in the history first and in what applies, past ten writes', async () => {
    // The ids must cross a power of ten, where a text sort and a number sort disagree: move the table's id sequence to six
    // below the next one (it only ever moves forward, so no other test's rows are touched).
    const [seq] = await sql<{ next: string }[]>`SELECT nextval(pg_get_serial_sequence('notify.alert_owner_values', 'id'))::text AS next`;
    const next = seq!.next;
    await sql`SELECT setval(pg_get_serial_sequence('notify.alert_owner_values', 'id'), ${String(10n ** BigInt(next.length) - 6n)}::bigint)`;
    let version = (await values.get(founder)).quotas.find((q) => q.plan === PLAN)!.version;
    // Twelve writes, the sixth onwards past the power of ten.
    for (let n = 1; n <= 12; n += 1) {
      const view = await values.set(founder, {
        key: 'priceQuota',
        plan: PLAN,
        value: n,
        expectedVersion: version,
        reason: `TEST quota write number ${n}`,
        clientRequestId: `owner-values-pg:${PLAN}:${n}`,
      });
      const quota = view.quotas.find((q) => q.plan === PLAN)!;
      expect(quota.value, `after write ${n}`).toBe(n);
      expect(view.history.find((h) => h.plan === PLAN)?.newValue, `history after write ${n}`).toBe(n);
      version = quota.version;
    }
    expect((await values.effective(PLAN)).maxActivePrice).toBe(12);
  });
});
