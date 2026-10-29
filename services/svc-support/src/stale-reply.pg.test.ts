import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { PostgresSupportStore } from './store.js';

/**
 * A stale reply on the real tables (SP-tickets-09, J-support-public-10 #8): a trail row someone else wrote after the
 * agent's last read refuses the comment or the status change under the ticket lock, and nothing is written.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'));
const USER = '5c0e0e01-1111-4111-8111-111111111111';

// A per-run database (#6713): on the shared intafaced_test, another file's migration replay rewrote the status trigger
// under this file's tests.
const available = await postgresAvailable(ADMIN_URL);
const db: TestDatabase | null = available ? await createTestDatabase({ service: 'support', url: ADMIN_URL, migrations: MIGRATIONS }) : null;
const sql = db?.sql ?? null;
if (sql) await assertTestDatabase(sql, 'svc-support stale-reply.pg.test');

afterAll(async () => {
  await db?.drop();
}, 30_000);

const OP = '5c0e0e01-3333-4333-8333-333333333333';
const OTHER_OP = '5c0e0e01-4444-4444-8444-444444444444';

describe.skipIf(!available)('stale reply on Postgres', () => {
  const store = () => new PostgresSupportStore(sql!);

  it('refuses with the newer rows and writes no comment; the same reply after them is written once', async () => {
    const t = await store().createTicket({ userId: USER, category: 'account', subject: 'TEST', body: 'TEST' });
    await store().claimTicket({ ticketId: t.id, operatorId: OP });
    const seen = (await store().listEvents(t.id)).at(-1)!.sequence;
    await store().setStatus({ ticketId: t.id, status: 'on_hold', operatorId: OTHER_OP, note: 'TEST' });
    const reply = { ticketId: t.id, authorId: OP, authorRole: 'operator' as const, body: 'TEST answer' };
    const refused = await store().addComment({ ...reply, expectedSequence: seen });
    expect(refused).toMatchObject({ status: 'refuse', reason: 'stale', newer: [{ actorId: OTHER_OP, toStatus: 'on_hold' }] });
    expect(await store().listComments(t.id)).toHaveLength(0);
    const last = (await store().listEvents(t.id)).at(-1)!.sequence;
    expect(await store().addComment({ ...reply, expectedSequence: last })).toMatchObject({ status: 'ok' });
    expect(await store().listComments(t.id)).toHaveLength(1);
  });

  it("the writer's own newer rows do not make it stale", async () => {
    const t = await store().createTicket({ userId: USER, category: 'account', subject: 'TEST', body: 'TEST' });
    const opened = (await store().listEvents(t.id)).at(-1)!.sequence;
    await store().claimTicket({ ticketId: t.id, operatorId: OP });
    const ok = await store().addComment({ ticketId: t.id, authorId: OP, authorRole: 'operator', body: 'TEST', expectedSequence: opened });
    expect(ok).toMatchObject({ status: 'ok' });
  });

  it('a status change naming an older row is refused with the newer rows and changes nothing', async () => {
    const t = await store().createTicket({ userId: USER, category: 'account', subject: 'TEST', body: 'TEST' });
    await store().claimTicket({ ticketId: t.id, operatorId: OP });
    const seen = (await store().listEvents(t.id)).at(-1)!.sequence;
    await store().setStatus({ ticketId: t.id, status: 'on_hold', operatorId: OTHER_OP, note: 'TEST' });
    const before = await store().listEvents(t.id);
    const refused = await store().setStatus({ ticketId: t.id, status: 'resolved', operatorId: OP, expectedSequence: seen });
    expect(refused).toMatchObject({ status: 'refuse', reason: 'stale', newer: [{ actorId: OTHER_OP, toStatus: 'on_hold' }] });
    expect(await store().listEvents(t.id)).toEqual(before);
    expect((await store().findById(t.id))?.status).toBe('on_hold');
  });
});
