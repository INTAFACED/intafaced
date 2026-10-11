import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';

/**
 * 0002 rewrites deliveries that 0001 already stored.
 *
 * An empty table lets the UPDATE succeed while `deliveries_status_ck` still
 * forbids `accepted` and `deliveries_delivered_ck` still demands status
 * `delivered` whenever the timestamp is set. A row that was delivered is the
 * case that fails. After the migration that row is `accepted`, the timestamp
 * is the same instant, and `accepted_at` is set if and only if status is
 * `accepted`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const read = (name: string) => readFileSync(join(drizzleDir, name), 'utf8');

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const CHECK_VIOLATION = '23514';

const NOTIFICATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const DELIVERED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const PENDING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const FAILED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const STAMP = new Date('2024-06-15T12:30:00.000Z');
const ATTEMPTED = new Date('2024-06-15T12:00:00.000Z');

const prior = ['0000_notify_init.sql', '0001_notify_channels.sql'].map(
  (file) => (schema: string) => rewriteSchemaSql(read(file), 'notify', schema),
);

describe('0002 notify delivery accepted — existing delivered rows', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb({ service: 'notify', url: URL, migrations: prior });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('rewrites a delivered row to accepted and keeps accepted_at iff status is accepted', async () => {
    await db.sql`
      INSERT INTO notifications (
        id, user_id, kind, title_key, body_key, severity, source_subject, source_idempotency_key
      ) VALUES (
        ${NOTIFICATION}, 'user-1', 'bank.margin_call',
        'notify.bank.margin_call.title', 'notify.bank.margin_call.body', 'critical',
        'intafaced.bank.margin_call.created', 'loan-1:1'
      )
    `;
    await db.sql`
      INSERT INTO deliveries (id, notification_id, channel, status, attempts, attempted_at, delivered_at)
      VALUES
        (${DELIVERED}, ${NOTIFICATION}, 'email', 'delivered', 1, ${ATTEMPTED}, ${STAMP}),
        (${PENDING}, ${NOTIFICATION}, 'push', 'pending', 0, NULL, NULL),
        (${FAILED}, ${NOTIFICATION}, 'sms', 'failed', 2, ${ATTEMPTED}, NULL)
    `;

    await db.sql.unsafe(rewriteSchemaSql(read('0002_notify_delivery_accepted.sql'), 'notify', db.schema));

    const [delivered] = await db.sql<{ status: string; accepted_at: Date | null }[]>`
      SELECT status, accepted_at FROM deliveries WHERE id = ${DELIVERED}
    `;
    expect(delivered?.status).toBe('accepted');
    expect(delivered?.accepted_at?.toISOString()).toBe(STAMP.toISOString());

    const [pending] = await db.sql<{ status: string; accepted_at: Date | null }[]>`
      SELECT status, accepted_at FROM deliveries WHERE id = ${PENDING}
    `;
    expect(pending?.status).toBe('pending');
    expect(pending?.accepted_at).toBeNull();

    const [failed] = await db.sql<{ status: string; accepted_at: Date | null }[]>`
      SELECT status, accepted_at FROM deliveries WHERE id = ${FAILED}
    `;
    expect(failed?.status).toBe('failed');
    expect(failed?.accepted_at).toBeNull();

    await expect(db.sql`UPDATE deliveries SET accepted_at = NULL WHERE id = ${DELIVERED}`).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(db.sql`UPDATE deliveries SET status = 'failed' WHERE id = ${DELIVERED}`).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(db.sql`UPDATE deliveries SET accepted_at = ${STAMP} WHERE id = ${PENDING}`).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(db.sql`UPDATE deliveries SET status = 'accepted' WHERE id = ${PENDING}`).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(db.sql`UPDATE deliveries SET status = 'delivered' WHERE id = ${FAILED}`).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });

    await db.sql`
      UPDATE deliveries SET status = 'accepted', accepted_at = ${STAMP} WHERE id = ${PENDING}
    `;
    const [moved] = await db.sql<{ status: string; accepted_at: Date | null }[]>`
      SELECT status, accepted_at FROM deliveries WHERE id = ${PENDING}
    `;
    expect(moved?.status).toBe('accepted');
    expect(moved?.accepted_at?.toISOString()).toBe(STAMP.toISOString());
  });
});
