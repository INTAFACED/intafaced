import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { SqlAgentOrderCallStore } from './agent-order-calls.js';

// trade.user_venue_agent_order_calls (J-agents-21 #11): one row per request id, never changed or deleted.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The agent order call store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const USER = '11111111-1111-4111-8111-1111111111c1';
const OTHER = '11111111-1111-4111-8111-1111111111c2';
const KEY = '22222222-2222-4222-8222-2222222222c1';

describe('SqlAgentOrderCallStore on Postgres (trade.user_venue_agent_order_calls)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it("records a call once by its request id, and reads back only the person's own key's", async () => {
    const store = new SqlAgentOrderCallStore(db!.sql);
    const at = new Date('2026-11-13T10:00:00Z');
    const first = { requestId: 'req-1', keyId: KEY, userId: USER, clientOrderId: 'buy-1', venueOrderId: 'v-1', code: null, at };
    await store.record(first);
    await store.record({ ...first, clientOrderId: 'other', code: 'x' });
    await store.record({
      requestId: 'req-2',
      keyId: KEY,
      userId: USER,
      clientOrderId: 'big',
      venueOrderId: null,
      code: 'trade.venue.insufficient_balance',
      at,
    });
    await store.record({ requestId: 'req-3', keyId: KEY, userId: OTHER, clientOrderId: 'theirs', venueOrderId: null, code: null, at });
    const mine = await store.byRequest(USER, KEY, ['req-1', 'req-2', 'req-3', 'req-none']);
    expect([...mine.keys()].sort()).toEqual(['req-1', 'req-2']);
    expect(mine.get('req-1')).toEqual(first);
    expect(mine.get('req-2')?.code).toBe('trade.venue.insufficient_balance');
    expect((await store.byRequest(USER, KEY, [])).size).toBe(0);
  });

  it('the log is append-only: a row is never changed or deleted', async () => {
    const sql = db!.sql;
    await expect(sql`UPDATE trade.user_venue_agent_order_calls SET code = 'x' WHERE request_id = 'req-1'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM trade.user_venue_agent_order_calls WHERE request_id = 'req-1'`).rejects.toThrow(/append-only/);
  });
});
