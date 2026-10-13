import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresNotifyStore } from './store.js';

/**
 * `PostgresNotifyStore` against a real database.
 *
 * The inbox is the one delivery every user always gets — it needs no
 * credentials and no address, so when every out-of-app channel refuses, it is
 * the whole of what "we told you" means. Until this file existed, nothing
 * executed it: `svc-notify` had no `TEST_DATABASE_URL_*` wiring at all, and
 * after that was added the delivery store and target store got suites while the
 * inbox store did not.
 *
 * Two properties here cannot be tested against the memory pair at all, because
 * the memory pair does not share the mechanism:
 *
 *   · **Dedupe** is a Postgres `ON CONFLICT` on a three-column unique index. The
 *     memory store keys a `Map`. A redelivered bus event hits the real one.
 *
 *   · **Keyset paging** orders on `(created_at, id)` and steps with a tuple
 *     comparison. In memory every insert gets its own `Date`, so ties never
 *     happen; in Postgres `now()` is TRANSACTION time, so a burst of inserts can
 *     share `created_at` exactly — and a pager that cannot break that tie either
 *     repeats a row or drops one. Dropping one means a margin call the user
 *     never sees in their inbox.
 *
 * Skips when Postgres is unreachable; runs in CI.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? 'postgres://svc_notify:svc_notify@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = [
  '0000_notify_init.sql',
  '0001_notify_channels.sql',
  '0002_notify_delivery_accepted.sql',
  '0003_notify_mute_prefs.sql',
  '0004_notify_delivery_claim_lease.sql',
].map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SUBJECT = 'intafaced.bank.margin_call.created';

const available = await postgresAvailable(URL);
const sql = available ? postgres(URL, { max: 2, onnotice: () => undefined }) : null;

if (available && sql) {
  await assertTestDatabase(sql, 'svc-notify store.pg.test');
  for (const migration of MIGRATIONS) {
    await sql.unsafe(migration).catch(() => undefined);
  }
}

afterAll(async () => {
  await sql?.end({ timeout: 1 }).catch(() => undefined);
});

describe.skipIf(!available)('PostgresNotifyStore — the inbox, executed', () => {
  const store = () => new PostgresNotifyStore(sql!);

  const insert = (overrides: Partial<Parameters<PostgresNotifyStore['insert']>[0]> = {}) =>
    store().insert({
      userId: ALICE,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: SUBJECT,
      sourceIdempotencyKey: 'loan-1:1',
      ...overrides,
    });

  beforeEach(async () => {
    await sql!`DELETE FROM notify.notifications WHERE user_id IN (${ALICE}, ${BOB})`;
  });

  describe('dedupe — a redelivered event is one inbox row', () => {
    it('inserts once and reports the second attempt as not inserted', async () => {
      const first = await insert();
      expect(first.inserted).toBe(true);
      expect(first.notification).not.toBeNull();

      const second = await insert();
      expect(second.inserted).toBe(false);
      // Nothing to return: the row exists but this call did not create it.
      expect(second.notification).toBeNull();

      const [row] = await sql!<{ n: string }[]>`SELECT count(*)::text AS n FROM notify.notifications WHERE user_id = ${ALICE}`;
      expect(row?.n).toBe('1');
    });

    it('is scoped per user — one event fanned to two people is two rows', async () => {
      // p2p escrow notifies seller and buyer off one business event, and both
      // legitimately carry the same source key.
      expect((await insert({ userId: ALICE })).inserted).toBe(true);
      expect((await insert({ userId: BOB })).inserted).toBe(true);
    });

    it('a different idempotency key on the same subject is a different notification', async () => {
      expect((await insert({ sourceIdempotencyKey: 'loan-1:1' })).inserted).toBe(true);
      expect((await insert({ sourceIdempotencyKey: 'loan-1:2' })).inserted).toBe(true);
    });

    it('findBySource returns the row the second insert declined to create', async () => {
      const first = await insert();
      await insert();
      const found = await store().findBySource(ALICE, SUBJECT, 'loan-1:1');
      expect(found?.id).toBe(first.notification!.id);
    });

    it('findBySource and findById never cross users', async () => {
      const mine = await insert({ userId: ALICE });
      expect(await store().findById(BOB, mine.notification!.id)).toBeNull();
      expect(await store().findBySource(BOB, SUBJECT, 'loan-1:1')).toBeNull();
    });
  });

  describe('keyset paging — every row exactly once', () => {
    /** Twelve rows written in ONE statement, so they share `created_at` exactly. */
    async function insertBurst(n: number): Promise<void> {
      await sql!`
        INSERT INTO notify.notifications (user_id, kind, title_key, body_key, severity, source_subject, source_idempotency_key)
        SELECT ${ALICE}, 'bank.margin_call', 'notify.bank.margin_call.title', 'notify.bank.margin_call.body',
               'critical', ${SUBJECT}, 'burst:' || g::text
          FROM generate_series(1, ${n}) AS g
      `;
    }

    async function pageThrough(limit: number, unreadOnly = false): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await store().list({ userId: ALICE, limit, ...(cursor ? { cursor } : {}), unreadOnly });
        seen.push(...page.items.map((i) => i.id));
        if (!page.nextCursor) return seen;
        cursor = page.nextCursor;
      }
      throw new Error('pager did not terminate');
    }

    it('walks a burst that shares one created_at without repeating or dropping a row', async () => {
      // THE CASE THE MEMORY STORE CANNOT PRODUCE. `now()` is transaction time,
      // so all twelve rows carry the same `created_at`; only the `id` half of
      // the tuple comparison separates them. A pager that ordered on time alone
      // would loop on the first page or skip the rest.
      await insertBurst(12);

      const seen = await pageThrough(5);
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
    });

    it('returns them newest-first and consistently across page sizes', async () => {
      await insertBurst(9);
      expect(await pageThrough(4)).toEqual(await pageThrough(9));
    });

    it('stops with a null cursor when the last page is exactly full', async () => {
      await insertBurst(6);
      const first = await store().list({ userId: ALICE, limit: 3, unreadOnly: false });
      expect(first.nextCursor).not.toBeNull();
      const second = await store().list({ userId: ALICE, limit: 3, cursor: first.nextCursor!, unreadOnly: false });
      expect(second.items).toHaveLength(3);
      expect(second.nextCursor).toBeNull();
    });

    it('unreadOnly paging skips what was read, and still walks the rest exactly once', async () => {
      await insertBurst(10);
      const all = await pageThrough(10);
      await store().markRead(ALICE, all.slice(0, 4));

      const unread = await pageThrough(3, true);
      expect(unread).toHaveLength(6);
      expect(new Set(unread).size).toBe(6);
      expect(unread.some((id) => all.slice(0, 4).includes(id))).toBe(false);
    });

    it('a cursor belonging to another user yields nothing rather than their inbox', async () => {
      await insertBurst(3);
      const mine = await store().list({ userId: ALICE, limit: 1, unreadOnly: false });
      const theirs = await store().list({ userId: BOB, limit: 5, cursor: mine.items[0]!.id, unreadOnly: false });
      expect(theirs.items).toEqual([]);
      expect(theirs.nextCursor).toBeNull();
    });

    it('an unknown cursor yields nothing rather than restarting from the top', async () => {
      await insertBurst(3);
      const page = await store().list({ userId: ALICE, limit: 5, cursor: '99999999-9999-4999-8999-999999999999', unreadOnly: false });
      expect(page.items).toEqual([]);
    });
  });

  describe('read state', () => {
    it('markRead counts only what it changed, and is idempotent', async () => {
      const a = await insert({ sourceIdempotencyKey: 'r1' });
      await insert({ sourceIdempotencyKey: 'r2' });

      expect(await store().markRead(ALICE, [a.notification!.id])).toBe(1);
      expect(await store().markRead(ALICE, [a.notification!.id])).toBe(0);
      expect(await store().unreadCount(ALICE)).toBe(1);
    });

    it('markRead cannot reach another user’s notification', async () => {
      const mine = await insert({ userId: ALICE });
      expect(await store().markRead(BOB, [mine.notification!.id])).toBe(0);
      expect(await store().unreadCount(ALICE)).toBe(1);
    });

    it('markAllRead clears the caller’s inbox and nobody else’s', async () => {
      await insert({ userId: ALICE, sourceIdempotencyKey: 'a1' });
      await insert({ userId: ALICE, sourceIdempotencyKey: 'a2' });
      await insert({ userId: BOB, sourceIdempotencyKey: 'b1' });

      expect(await store().markAllRead(ALICE)).toBe(2);
      expect(await store().unreadCount(ALICE)).toBe(0);
      expect(await store().unreadCount(BOB)).toBe(1);
    });
  });

  describe('params — stored as a jsonb object, legacy string rows still read', () => {
    const PARAMS = { amount: '1250.00', asset: 'USDT', nested: { ratio: '0.85', flags: ['a', 'b'] }, count: 3 };

    /** Raw insert that bypasses the store, for shapes only an older build (or a hand edit) could write. */
    async function insertRawParams(key: string, fragment: postgres.PendingQuery<postgres.Row[]>): Promise<string> {
      const [row] = await sql!<{ id: string }[]>`
        INSERT INTO notify.notifications (user_id, kind, title_key, body_key, params, severity, source_subject, source_idempotency_key)
        VALUES (${ALICE}, 'bank.margin_call', 'notify.bank.margin_call.title', 'notify.bank.margin_call.body',
                ${fragment}, 'critical', ${SUBJECT}, ${key})
        RETURNING id
      `;
      return row!.id;
    }

    it('insert writes a jsonb OBJECT (not a JSON string) and every read path returns the same object', async () => {
      const created = await insert({ params: PARAMS });
      expect(created.notification!.params).toEqual(PARAMS);

      // The bug this pins: a bare `::jsonb` let postgres.js encode the string a second time, so
      // the column held a jsonb STRING and `params->>'amount'` was NULL.
      const [shape] = await sql!<{ kind: string; amount: string | null }[]>`
        SELECT jsonb_typeof(params) AS kind, params->>'amount' AS amount
          FROM notify.notifications WHERE id = ${created.notification!.id}
      `;
      expect(shape).toEqual({ kind: 'object', amount: '1250.00' });

      expect((await store().findById(ALICE, created.notification!.id))?.params).toEqual(PARAMS);
      expect((await store().findBySource(ALICE, SUBJECT, 'loan-1:1'))?.params).toEqual(PARAMS);
      const page = await store().list({ userId: ALICE, limit: 5, unreadOnly: false });
      expect(page.items.map((n) => n.params)).toEqual([PARAMS]);
    });

    it('omitted params are stored and read back as an empty object', async () => {
      const created = await insert();
      expect(created.notification!.params).toEqual({});
      const [shape] = await sql!<{ kind: string }[]>`
        SELECT jsonb_typeof(params) AS kind FROM notify.notifications WHERE id = ${created.notification!.id}
      `;
      expect(shape?.kind).toBe('object');
    });

    it('a legacy double-encoded row (jsonb string holding the object) reads back as the object', async () => {
      // Exactly what the pre-fix insert wrote: JSON.stringify(params) sent as a bare `::jsonb` parameter.
      const id = await insertRawParams('legacy:double', sql!`${JSON.stringify(PARAMS)}::jsonb`);
      const [shape] = await sql!<{ kind: string }[]>`SELECT jsonb_typeof(params) AS kind FROM notify.notifications WHERE id = ${id}`;
      expect(shape?.kind).toBe('string');

      expect((await store().findById(ALICE, id))?.params).toEqual(PARAMS);
      const page = await store().list({ userId: ALICE, limit: 5, unreadOnly: false });
      expect(page.items.find((n) => n.id === id)?.params).toEqual(PARAMS);
    });

    it('malformed legacy strings read as an empty object instead of crashing the inbox', async () => {
      // jsonb strings whose content is not a JSON object: not JSON at all, an array, null, a number.
      const notJson = await insertRawParams('legacy:not-json', sql!`to_jsonb(${'{not json'}::text)`);
      const array = await insertRawParams('legacy:array', sql!`to_jsonb(${'["a","b"]'}::text)`);
      const nul = await insertRawParams('legacy:null', sql!`to_jsonb(${'null'}::text)`);
      const num = await insertRawParams('legacy:number', sql!`to_jsonb(${'42'}::text)`);

      for (const id of [notJson, array, nul, num]) {
        expect((await store().findById(ALICE, id))?.params).toEqual({});
      }
      const page = await store().list({ userId: ALICE, limit: 10, unreadOnly: false });
      expect(page.items).toHaveLength(4);
      expect(page.items.every((n) => JSON.stringify(n.params) === '{}')).toBe(true);
    });
  });
});
