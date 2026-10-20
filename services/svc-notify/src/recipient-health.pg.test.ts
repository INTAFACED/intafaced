import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresRecipientHealthStore } from './recipient-health.js';

/** The Postgres engine of recipient health, against a real database with fresh user ids. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? 'postgres://svc_notify:svc_notify@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = ['0000_notify_init.sql', '0001_notify_channels.sql', '0017_notify_recipient_health.sql'].map((f) =>
  readFileSync(join(here, '..', 'drizzle', f), 'utf8'),
);

const available = await postgresAvailable(URL);
const sql = available ? postgres(URL, { max: 3, onnotice: () => undefined }) : null;
if (available && sql) {
  await assertTestDatabase(sql, 'svc-notify recipient-health.pg.test');
  for (const migration of MIGRATIONS) await sql.unsafe(migration).catch(() => undefined);
}

const mine: string[] = [];
afterAll(async () => {
  if (sql) {
    for (const userId of mine) {
      await sql`DELETE FROM notify.recipient_health WHERE user_id = ${userId}`;
      await sql`DELETE FROM notify.channel_targets WHERE user_id = ${userId}`;
    }
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
});

const NOW = new Date('2026-10-20T13:00:00.000Z');

describe.skipIf(!available)('PostgresRecipientHealthStore', () => {
  const store = () => new PostgresRecipientHealthStore(sql!);
  const fresh = () => {
    const id = randomUUID();
    mine.push(id);
    return id;
  };

  it('counts terminal failures, quarantines at the threshold and pins the row to the address', async () => {
    const userId = fresh();
    const s = store();
    const base = { userId, channel: 'email' as const, address: 'a@example.com', code: 'channel.transport_rejected', now: NOW };
    expect(await s.record({ ...base, ok: false, threshold: 2 })).toEqual({ quarantined: false });
    expect(await s.quarantineOf(userId, 'email', 'a@example.com')).toBeNull();
    expect(await s.record({ ...base, ok: false, threshold: 2 })).toEqual({ quarantined: true });
    expect(await s.quarantineOf(userId, 'email', 'a@example.com')).toMatchObject({
      reason: 'consecutive_failures:2:channel.transport_rejected',
    });
    expect(await s.quarantineOf(userId, 'email', 'other@example.com')).toBeNull();
    // A different address resets the row.
    expect(await s.record({ ...base, address: 'b@example.com', ok: false, threshold: 2 })).toEqual({ quarantined: false });
    expect(await s.quarantineOf(userId, 'email', 'a@example.com')).toBeNull();
  });

  it('a null threshold never quarantines, and a success with nothing recorded creates no row', async () => {
    const userId = fresh();
    const s = store();
    const base = { userId, channel: 'push' as const, address: 'device-token-1', now: NOW };
    expect(await s.record({ ...base, ok: true, threshold: 1 })).toEqual({ quarantined: false });
    expect((await sql!`SELECT 1 FROM notify.recipient_health WHERE user_id = ${userId}`).length).toBe(0);
    for (let i = 0; i < 3; i += 1)
      expect(await s.record({ ...base, ok: false, code: 'x', threshold: null })).toEqual({ quarantined: false });
  });

  it('lists by state with masked addresses, and release is audited, reasoned and idempotent', async () => {
    const userId = fresh();
    const s = store();
    await sql!`INSERT INTO notify.channel_targets (user_id, channel, address, locale, verified_at) VALUES (${userId}, 'email', 'ada@example.com', 'en', now())`;
    await s.record({
      userId,
      channel: 'email',
      address: 'ada@example.com',
      ok: false,
      code: 'channel.transport_rejected',
      threshold: 1,
      now: NOW,
    });

    const q = (await s.list('quarantined', 200)).filter((r) => r.userId === userId);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ address: 'a***@example.com', state: 'quarantined', consecutiveFailures: 1 });
    expect((await s.list('active', 200)).some((r) => r.userId === userId)).toBe(false);

    const input = { userId, channel: 'email' as const, actorId: 'op-1', reason: 'mailbox fixed', reasonId: 'rel-1', now: NOW };
    expect(await s.release(input)).toEqual({ released: true, replayed: false });
    expect(await s.release(input)).toEqual({ released: true, replayed: true });
    expect(await s.quarantineOf(userId, 'email', 'ada@example.com')).toBeNull();
    expect((await s.list('active', 200)).some((r) => r.userId === userId)).toBe(true);
    const audit = await sql!`SELECT actor_id, reason, quarantine_reason FROM notify.recipient_release_audit WHERE user_id = ${userId}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: 'op-1', reason: 'mailbox fixed' });

    // The audit trail cannot be edited or deleted.
    await expect(sql!`DELETE FROM notify.recipient_release_audit WHERE user_id = ${userId}`).rejects.toThrow(/immutable/);
    await expect(s.release({ ...input, reasonId: 'rel-2' })).rejects.toMatchObject({ code: 'notify.recipient_not_quarantined' });
    await expect(s.release({ ...input, userId: randomUUID(), reasonId: 'rel-3' })).rejects.toMatchObject({
      code: 'notify.recipient_unknown',
    });
  });
});
