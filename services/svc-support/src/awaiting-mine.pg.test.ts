import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { PostgresSupportStore } from './store.js';
import { SqlLifecycleBook } from './ticket-lifecycle.js';

/** The awaiting-customer read against Postgres: only the asked tickets, only those waiting on the customer, oldest first. */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const raw = process.env.TEST_DATABASE_URL;
const url = raw && (await postgresAvailable(raw)) && new URL(raw).pathname.replace(/^\//, '').endsWith('_test') ? raw : null;

if (!url) {
  describe.skip('awaiting customer (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });
  const ticket = async (userId: string): Promise<string> => {
    const rows = await db.sql<{ id: string }[]>`
      INSERT INTO support.tickets (user_id, category, subject, body) VALUES (${userId}, 'account', 's', 'b') RETURNING id
    `;
    return rows[0]!.id;
  };

  describe('SqlLifecycleBook.awaitingCustomer', () => {
    it('returns an empty list for no ids without touching the database', async () => {
      expect(await new SqlLifecycleBook(db.sql).awaitingCustomer([])).toEqual([]);
    });

    it('returns only the asked tickets that wait on the customer, longest first', async () => {
      const book = new SqlLifecycleBook(db.sql);
      const [a, b, c, d] = [await ticket('u1'), await ticket('u1'), await ticket('u1'), await ticket('u2')];
      await book.setWaiting(a, 'customer', '2026-10-20T10:00:00.000Z');
      await book.setWaiting(b, 'customer', '2026-10-20T09:00:00.000Z');
      await book.setWaiting(c, 'team', '2026-10-20T08:00:00.000Z');
      await book.setWaiting(d, 'customer', '2026-10-20T07:00:00.000Z');
      expect(await book.awaitingCustomer([a, b, c])).toEqual([
        { ticketId: b, since: '2026-10-20T09:00:00.000Z' },
        { ticketId: a, since: '2026-10-20T10:00:00.000Z' },
      ]);
      await book.setWaiting(b, null, '2026-10-20T11:00:00.000Z');
      expect((await book.awaitingCustomer([a, b, c])).map((r) => r.ticketId)).toEqual([a]);
    });
  });

  describe('PostgresSupportStore.openIdsByUser', () => {
    it("returns the caller's unfinished requests only, as ids", async () => {
      const store = new PostgresSupportStore(db.sql);
      const open = await ticket('u1');
      const done = await ticket('u1');
      await ticket('u2');
      await db.sql`UPDATE support.tickets SET status = 'resolved' WHERE id = ${done}`;
      expect(await store.openIdsByUser('u1')).toEqual([open]);
    });
  });
}
