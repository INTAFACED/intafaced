import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryNotifyStore, PostgresNotifyStore, type NotifyStore } from './store.js';

/**
 * Audience-all system notices, answered the same way by both inbox engines.
 *
 * The Postgres engine runs inside a transaction that is always rolled back, so a
 * notice that every user's inbox would see is never visible to a concurrent test
 * file on the shared database.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? 'postgres://svc_notify:svc_notify@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  '0000_notify_init.sql',
  '0001_notify_channels.sql',
  '0002_notify_delivery_accepted.sql',
  '0003_notify_mute_prefs.sql',
  '0004_notify_delivery_claim_lease.sql',
  '0016_notify_system_notices.sql',
].map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const available = await postgresAvailable(URL);
const sql = available ? postgres(URL, { max: 2, onnotice: () => undefined }) : null;
if (available && sql) {
  await assertTestDatabase(sql, 'svc-notify system-notice.conformance.test');
  for (const migration of MIGRATIONS) await sql.unsafe(migration).catch(() => undefined);
}
afterAll(async () => {
  await sql?.end({ timeout: 1 }).catch(() => undefined);
});

const ROLLBACK = new Error('rollback');
const SUBJECT = 'intafaced.notify.ledger.freeze.updated';
const NOTICE = {
  kind: 'ledger.freeze.set',
  titleKey: 'notify.ledger.freeze.set.title',
  bodyKey: 'notify.ledger.freeze.set.body',
  params: { frozen: true },
  severity: 'action' as const,
  sourceSubject: SUBJECT,
};

async function body(store: NotifyStore): Promise<void> {
  const A = randomUUID();
  const B = randomUUID();
  const own = await store.insert({
    userId: A,
    kind: 'trade.fill',
    titleKey: 'notify.trade.fill.title',
    bodyKey: 'notify.trade.fill.body',
    sourceSubject: 'intafaced.trade.fill.settled',
    sourceIdempotencyKey: 'f1',
  });
  expect(own.inserted).toBe(true);

  expect(await store.insertSystemNotice({ ...NOTICE, sourceIdempotencyKey: 'freeze:t1:true' })).toEqual({ inserted: true });
  // The same event again writes nothing.
  expect(await store.insertSystemNotice({ ...NOTICE, sourceIdempotencyKey: 'freeze:t1:true' })).toEqual({ inserted: false });

  // Every user's read includes it, merged with their own rows.
  const pageA = await store.list({ userId: A, limit: 10, unreadOnly: false });
  const pageB = await store.list({ userId: B, limit: 10, unreadOnly: false });
  expect(pageA.items.map((r) => r.kind).sort()).toEqual(['ledger.freeze.set', 'trade.fill']);
  expect(pageB.items.map((r) => r.kind)).toEqual(['ledger.freeze.set']);
  expect(pageB.items[0]).toMatchObject({ userId: B, readAt: null, severity: 'action', params: { frozen: true } });
  expect(await store.unreadCount(A)).toBe(2);
  expect(await store.unreadCount(B)).toBe(1);

  // A cleared notice is a second row; the first stays in history.
  await store.insertSystemNotice({
    ...NOTICE,
    kind: 'ledger.freeze.cleared',
    titleKey: 'notify.ledger.freeze.cleared.title',
    bodyKey: 'notify.ledger.freeze.cleared.body',
    sourceIdempotencyKey: 'freeze:t2:false',
  });
  expect((await store.list({ userId: B, limit: 10, unreadOnly: false })).items).toHaveLength(2);

  // Paging walks across both kinds of row with one cursor.
  const first = await store.list({ userId: A, limit: 2, unreadOnly: false });
  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).not.toBeNull();
  const second = await store.list({ userId: A, limit: 2, unreadOnly: false, cursor: first.nextCursor });
  expect(second.items).toHaveLength(1);
  expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(3);

  // Reading is per user: A's mark does not touch B.
  const notice = pageA.items.find((r) => r.kind === 'ledger.freeze.set')!;
  expect(await store.markRead(A, [notice.id])).toBe(1);
  expect(await store.markRead(A, [notice.id])).toBe(0);
  expect(await store.unreadCount(A)).toBe(2);
  expect(await store.unreadCount(B)).toBe(2);
  expect((await store.findById(A, notice.id))?.readAt).not.toBeNull();
  expect((await store.findById(B, notice.id))?.readAt).toBeNull();
  expect((await store.list({ userId: A, limit: 10, unreadOnly: true })).items.map((r) => r.id)).not.toContain(notice.id);

  // markAllRead marks the remaining system notice for the caller only.
  expect(await store.markAllRead(A)).toBe(2);
  expect(await store.unreadCount(A)).toBe(0);
  expect(await store.unreadCount(B)).toBe(2);
}

describe('MemoryNotifyStore — system notices', () => {
  it('merges audience-all notices with per-user read marks', async () => body(new MemoryNotifyStore()));
});

describe.skipIf(!available)('PostgresNotifyStore — system notices', () => {
  it('merges audience-all notices with per-user read marks', async () => {
    await expect(
      sql!.begin(async (tx) => {
        await body(new PostgresNotifyStore(tx as unknown as postgres.Sql));
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });
});
