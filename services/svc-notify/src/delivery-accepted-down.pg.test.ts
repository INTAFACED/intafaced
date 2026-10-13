/**
 * Reversal of 0002 must finish while an accepted delivery still exists.
 *
 * Adding `deliveries_status_ck` checks every row already stored. The restored
 * list allows `delivered` and not `accepted`, so the status rewrite has to
 * land before that check. Otherwise Postgres aborts the reversal and the
 * accepted row is never updated.
 *
 * No skip: an unreachable database fails this file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const readSql = (name: string) => readFileSync(join(drizzle, name), 'utf8');

const db: TestDatabase = await createTestDatabase({
  service: 'notify',
  url: URL,
  migrations: [readSql('0000_notify_init.sql'), readSql('0001_notify_channels.sql'), readSql('0002_notify_delivery_accepted.sql')],
});

afterAll(async () => {
  await db.drop();
});

describe('0002 delivery accepted reversal', () => {
  it('updates an existing accepted delivery to delivered and finishes', async () => {
    const [note] = await db.sql<{ id: string }[]>`
      INSERT INTO notify.notifications (
        user_id, kind, title_key, body_key, severity, source_subject, source_idempotency_key
      ) VALUES (
        '11111111-1111-4111-8111-111111111111',
        'bank.margin_call',
        'notify.bank.margin_call.title',
        'notify.bank.margin_call.body',
        'critical',
        'intafaced.bank.margin_call.created',
        'loan-1:1'
      )
      RETURNING id
    `;

    const [accepted] = await db.sql<{ id: string; accepted_at: Date }[]>`
      INSERT INTO notify.deliveries (notification_id, channel, status, accepted_at)
      VALUES (${note!.id}, 'email', 'accepted', timestamptz '2026-10-06 12:00:00+00')
      RETURNING id, accepted_at
    `;

    await db.sql.unsafe(readSql('0002_notify_delivery_accepted.down.sql'));

    const rows = await db.sql<{ id: string; status: string; delivered_at: Date | null }[]>`
      SELECT id, status, delivered_at FROM notify.deliveries
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(accepted!.id);
    expect(rows[0]?.status).toBe('delivered');
    expect(rows[0]?.delivered_at).toEqual(accepted!.accepted_at);
  });
});
