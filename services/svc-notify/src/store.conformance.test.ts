import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryNotifyStore, PostgresNotifyStore, type NotifyStore } from './store.js';

/**
 * THE TWO INBOX ENGINES, ANSWERING THE SAME QUESTIONS.
 *
 * Every other test in this service runs against `MemoryNotifyStore`, and the
 * comment on that class says it has "the same dedupe / self-only semantics as
 * Postgres". Nothing checked it. `ledger-client` asserts its memory/Postgres
 * equivalence with a conformance suite for exactly this reason; the inbox had
 * the same claim and none of the proof.
 *
 * Two branches had in fact drifted apart, and both are reachable with a
 * perfectly valid UUID — the router validates the shape, so shape is not what
 * protects this:
 *
 *   a cursor whose row is gone     memory ignored the cursor and returned page
 *                                  ONE. A client paginating a list whose cursor
 *                                  row was deleted would read page one forever.
 *   another user's notification    memory looked the cursor up in an index that
 *   id as a cursor                 is not scoped by user, so it sliced YOUR list
 *                                  at SOMEONE ELSE'S timestamp. Passing guessed
 *                                  ids and watching the page move is a probe for
 *                                  whether an id exists and roughly when it was
 *                                  created. Postgres binds `user_id` in the
 *                                  cursor lookup and always did.
 *
 * Production runs Postgres, so neither was live. The memory store is what every
 * test in this service executes and what anyone reads to learn the semantics,
 * which is its own kind of load-bearing.
 *
 * The suite runs against memory always and against Postgres when a database is
 * reachable. Same assertions, one body: a conformance test that runs one engine
 * proves nothing about the pair.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? 'postgres://svc_notify:svc_notify@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Every up migration, in order. The store reads tables from later files too (the inbox joins
 * `system_notices` and `system_notice_reads`, 0016), so a shorter list passes only when an earlier
 * file in the run has already migrated the shared database.
 */
const MIGRATIONS = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const available = await postgresAvailable(URL);
const sql = available ? postgres(URL, { max: 2, onnotice: () => undefined }) : null;

if (available && sql) {
  await assertTestDatabase(sql, 'svc-notify store.conformance.test');
  for (const migration of MIGRATIONS) {
    await sql.unsafe(migration).catch(() => undefined);
  }
}

afterAll(async () => {
  await sql?.end({ timeout: 1 }).catch(() => undefined);
});

/** A fresh user per run, so a shared database cannot make one case see another's rows. */
const USER = randomUUID();
const OTHER_USER = randomUUID();

const ENGINES: Array<{ name: string; skip: boolean; make: () => NotifyStore }> = [
  { name: 'MemoryNotifyStore', skip: false, make: () => new MemoryNotifyStore() },
  { name: 'PostgresNotifyStore', skip: !available, make: () => new PostgresNotifyStore(sql!) },
];

for (const engine of ENGINES) {
  describe.skipIf(engine.skip)(`${engine.name} — inbox conformance`, () => {
    let store: NotifyStore;

    beforeEach(async () => {
      store = engine.make();
      if (sql) {
        await sql`DELETE FROM notify.notifications WHERE user_id IN (${USER}, ${OTHER_USER})`;
      }
    });

    /** Insert `n` notifications for `userId`, newest last. Returns them in insert order. */
    async function seed(userId: string, n: number, prefix = 'k') {
      const made = [];
      for (let i = 0; i < n; i += 1) {
        const result = await store.insert({
          userId,
          kind: 'bank.margin_call',
          titleKey: 'notify.bank.margin_call.title',
          bodyKey: 'notify.bank.margin_call.body',
          severity: 'critical',
          sourceSubject: 'intafaced.bank.margin_call.created',
          sourceIdempotencyKey: `${prefix}-${i}`,
        });
        expect(result.inserted).toBe(true);
        made.push(result.notification!);
      }
      return made;
    }

    it('dedupes on (user, subject, idempotency key) and says which call inserted', async () => {
      const first = await store.insert({
        userId: USER,
        kind: 'bank.margin_call',
        titleKey: 'notify.bank.margin_call.title',
        bodyKey: 'notify.bank.margin_call.body',
        sourceSubject: 'intafaced.bank.margin_call.created',
        sourceIdempotencyKey: 'dedupe-1',
      });
      expect(first).toMatchObject({ inserted: true });

      const replay = await store.insert({
        userId: USER,
        kind: 'bank.margin_call',
        titleKey: 'notify.bank.margin_call.title',
        bodyKey: 'notify.bank.margin_call.body',
        sourceSubject: 'intafaced.bank.margin_call.created',
        sourceIdempotencyKey: 'dedupe-1',
      });
      // Not inserted, and no row handed back — the caller must use findBySource,
      // which is what makes the two halves independently recoverable.
      expect(replay).toEqual({ inserted: false, notification: null });

      const found = await store.findBySource(USER, 'intafaced.bank.margin_call.created', 'dedupe-1');
      expect(found?.id).toBe(first.notification!.id);
    });

    it('the same key for a different user is a different notification', async () => {
      await seed(USER, 1, 'shared');
      const other = await store.insert({
        userId: OTHER_USER,
        kind: 'bank.margin_call',
        titleKey: 'notify.bank.margin_call.title',
        bodyKey: 'notify.bank.margin_call.body',
        sourceSubject: 'intafaced.bank.margin_call.created',
        sourceIdempotencyKey: 'shared-0',
      });
      expect(other.inserted).toBe(true);
    });

    it('walks every row exactly once and then stops', async () => {
      const made = await seed(USER, 5);

      // Asserted as a WALK rather than a fixed 2 / 2 / 1 split, because the two
      // engines get `createdAt` from different clocks — `new Date()` and
      // Postgres `now()`, which is the TRANSACTION timestamp and can repeat
      // across rows written back to back. A tie is legal; the ordering falls to
      // the id and both engines still have a total order. What must never
      // happen either way is a row served twice or skipped, and a fixed split
      // asserts the clock, not that.
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const page: { items: Array<{ id: string }>; nextCursor: string | null } = await store.list({
          userId: USER,
          cursor,
          limit: 2,
          unreadOnly: false,
        });
        pages += 1;
        expect(page.items.length).toBeLessThanOrEqual(2);
        // A cursor is the LAST row of the page it came with, or the next page
        // starts in the wrong place.
        if (page.nextCursor !== null) expect(page.nextCursor).toBe(page.items[page.items.length - 1]!.id);
        seen.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
        // A walk that will not terminate is the failure this bounds.
        expect(pages).toBeLessThan(10);
      } while (cursor !== null);

      // Every row, once. Duplicates and gaps are separately named because they
      // are different bugs: `seen.length` catches a row served twice, the Set
      // catches one never served at all.
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect(new Set(seen)).toEqual(new Set(made.map((r) => r.id)));
    });

    it('a cursor whose row is gone returns an empty page, never page one', async () => {
      await seed(USER, 3);

      // A stale cursor is a real state: the row it named can be deleted between
      // two pages. Restarting at page one silently would make a paginating
      // client loop forever instead of finishing.
      const page = await store.list({ userId: USER, cursor: randomUUID(), limit: 2, unreadOnly: false });
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it("another user's notification id is not a usable cursor", async () => {
      const mine = await seed(USER, 3);
      const theirs = await seed(OTHER_USER, 1, 'theirs');

      const page = await store.list({ userId: USER, cursor: theirs[0]!.id, limit: 2, unreadOnly: false });

      // Self-only by construction: the cursor is looked up WITH the caller's id,
      // so a foreign id resolves to nothing. Slicing the caller's list at a
      // stranger's timestamp would answer "does this id exist, and when was it
      // made" to anyone willing to guess.
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
      expect(mine).toHaveLength(3);
    });

    it('unreadOnly filters, and paging within it stays filtered', async () => {
      const rows = await seed(USER, 4);
      await store.markRead(USER, [rows[3]!.id]);

      const page1 = await store.list({ userId: USER, limit: 2, unreadOnly: true });
      expect(page1.items).toHaveLength(2);
      expect(page1.items.every((r) => r.readAt === null)).toBe(true);

      const page2 = await store.list({ userId: USER, cursor: page1.nextCursor, limit: 2, unreadOnly: true });
      const all = [...page1.items, ...page2.items];
      expect(all).toHaveLength(3);
      expect(all.some((r) => r.id === rows[3]!.id)).toBe(false);
    });

    it('never lists, finds or counts another user', async () => {
      const mine = await seed(USER, 2);
      await seed(OTHER_USER, 3, 'theirs');

      const page = await store.list({ userId: USER, limit: 50, unreadOnly: false });
      expect(page.items).toHaveLength(2);
      expect(await store.unreadCount(USER)).toBe(2);
      expect(await store.findById(OTHER_USER, mine[0]!.id)).toBeNull();
      expect(await store.findBySource(OTHER_USER, 'intafaced.bank.margin_call.created', 'k-0')).toBeNull();
    });

    it('markRead counts only what it changed, and only the caller’s rows', async () => {
      const mine = await seed(USER, 3);
      const theirs = await seed(OTHER_USER, 1, 'theirs');

      expect(await store.markRead(USER, [mine[0]!.id, mine[1]!.id])).toBe(2);
      // Already read — nothing changed, so nothing is counted.
      expect(await store.markRead(USER, [mine[0]!.id])).toBe(0);
      // Somebody else's row, and an id that does not exist: both no-ops.
      expect(await store.markRead(USER, [theirs[0]!.id, randomUUID()])).toBe(0);
      expect(await store.unreadCount(USER)).toBe(1);
      expect(await store.unreadCount(OTHER_USER)).toBe(1);
    });

    it('markAllRead clears the caller and leaves everyone else alone', async () => {
      await seed(USER, 3);
      await seed(OTHER_USER, 2, 'theirs');

      expect(await store.markAllRead(USER)).toBe(3);
      expect(await store.markAllRead(USER)).toBe(0);
      expect(await store.unreadCount(USER)).toBe(0);
      expect(await store.unreadCount(OTHER_USER)).toBe(2);
    });

    it('markRead of an empty list is a no-op, not an error', async () => {
      await seed(USER, 1);
      expect(await store.markRead(USER, [])).toBe(0);
      expect(await store.unreadCount(USER)).toBe(1);
    });
  });
}
