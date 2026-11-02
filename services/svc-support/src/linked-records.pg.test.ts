import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { LinkedRecords, SqlLinkBook, type RecordOwnershipDoor } from './linked-records.js';
import { PostgresSupportStore } from './store.js';
import { SupportService } from './support-service.js';

/**
 * Records linked to a request on the real tables (J-support-public-20 #1): a link the owner confirmed is written once even
 * when two operators link it at the same moment, a refused link writes no row, and the table refuses update and delete.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'));

const CUSTOMER = '5c0e0e02-1111-4111-8111-111111111111';
const OP = '5c0e0e02-3333-4333-8333-333333333333';
const OTHER_OP = '5c0e0e02-4444-4444-8444-444444444444';
const MINE = '5c0e0e02-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THEIRS = '5c0e0e02-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const available = await postgresAvailable(ADMIN_URL);
const db: TestDatabase | null = available ? await createTestDatabase({ service: 'support', url: ADMIN_URL, migrations: MIGRATIONS }) : null;
const sql = db?.sql ?? null;
if (sql) await assertTestDatabase(sql, 'svc-support linked-records.pg.test');

afterAll(async () => {
  await db?.drop();
}, 30_000);

const svcPay: RecordOwnershipDoor = {
  configured: true,
  owns: async ({ kind, recordId, userId }) => kind === 'withdrawal' && recordId === MINE && userId === CUSTOMER,
};

describe.skipIf(!available)('records linked to a request, on Postgres', () => {
  const desk = (conn = sql!) => {
    const store = new PostgresSupportStore(conn);
    return { store, links: new LinkedRecords(new SqlLinkBook(conn), new SupportService(store), svcPay) };
  };
  const count = async (ticketId: string) =>
    (await sql!<{ n: number }[]>`SELECT count(*)::int AS n FROM support.ticket_record_links WHERE ticket_id = ${ticketId}`)[0]!.n;

  it('two operators linking the same record at once leave one row, and both read it', async () => {
    const { store, links } = desk();
    const ticket = await store.createTicket({ userId: CUSTOMER, category: 'deposit_withdraw', subject: 'TEST', body: 'TEST' });
    const second = postgres(db!.url, { max: 1, onnotice: () => undefined });
    try {
      const other = desk(second).links;
      const [a, b] = await Promise.all([
        links.link(OP, { ticketId: ticket.id, kind: 'withdrawal', recordId: MINE }),
        other.link(OTHER_OP, { ticketId: ticket.id, kind: 'withdrawal', recordId: MINE }),
      ]);
      expect(a).toEqual(b);
      expect(await count(ticket.id)).toBe(1);
      expect(await links.list(OP, ticket.id)).toEqual([a]);
    } finally {
      await second.end({ timeout: 5 });
    }
  });

  it("a refused link writes nothing: another customer's record, and an order", async () => {
    const { store, links } = desk();
    const ticket = await store.createTicket({ userId: CUSTOMER, category: 'deposit_withdraw', subject: 'TEST', body: 'TEST' });
    await expect(links.link(OP, { ticketId: ticket.id, kind: 'deposit', recordId: THEIRS })).rejects.toMatchObject({
      code: 'support.link_record_not_owned',
    });
    await expect(links.link(OP, { ticketId: ticket.id, kind: 'order', recordId: MINE })).rejects.toMatchObject({
      code: 'support.link_record_owner_unwired',
    });
    expect(await count(ticket.id)).toBe(0);
  });

  it('a link cannot be changed or removed, and names a real ticket and a known kind', async () => {
    const { store, links } = desk();
    const ticket = await store.createTicket({ userId: CUSTOMER, category: 'deposit_withdraw', subject: 'TEST', body: 'TEST' });
    await links.link(OP, { ticketId: ticket.id, kind: 'withdrawal', recordId: MINE });
    await expect(sql!`UPDATE support.ticket_record_links SET record_id = ${THEIRS} WHERE ticket_id = ${ticket.id}`).rejects.toThrow(
      /append-only/,
    );
    await expect(sql!`DELETE FROM support.ticket_record_links WHERE ticket_id = ${ticket.id}`).rejects.toThrow(/append-only/);
    await expect(
      sql!`INSERT INTO support.ticket_record_links (ticket_id, kind, record_id, linked_by, linked_at)
           VALUES (${ticket.id}, 'payment', ${THEIRS}, ${OP}, now())`,
    ).rejects.toThrow(/check/i);
    await expect(
      sql!`INSERT INTO support.ticket_record_links (ticket_id, kind, record_id, linked_by, linked_at)
           VALUES (${THEIRS}, 'withdrawal', ${THEIRS}, ${OP}, now())`,
    ).rejects.toThrow(/foreign key/i);
    expect(await count(ticket.id)).toBe(1);
  });
});
