import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { createWithdrawalHistory } from './history.js';

/** The customer's withdrawal history against a real Postgres with every forward migration. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_withdrawal_history_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('withdrawal history (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let history: ReturnType<typeof createWithdrawalHistory>;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    history = createWithdrawalHistory(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  beforeEach(async () => {
    await truncatePayForTest(db.sql, 'pay', `TRUNCATE pay.withdrawals RESTART IDENTITY CASCADE`);
  }, 30_000);

  let n = 0;
  async function put(o: { userId?: string; assetId?: string; status?: string; failure?: string | null; at?: string; id?: string } = {}) {
    n += 1;
    const rows = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, status, failure_code, created_at)
      VALUES (${o.id ?? db.sql`gen_random_uuid()`}, ${o.userId ?? USER}, ${o.assetId ?? 'USDT'}, 5, 'card-sandbox',
              ${db.sql.json({ kind: 'bank', ref: 'DE89370400440532013000' })}, ${`ref-${n}`}, ${o.status === 'sent' ? `rail-${n}` : null}, ${o.status ?? 'pending'}::pay.withdrawal_status,
              ${o.failure ?? null}, ${o.at ?? '2026-10-20T08:00:00.000000Z'}::text::timestamptz)
      RETURNING id`;
    return rows[0]!.id;
  }

  it('shows an empty page, not a made-up row, when there is no history', async () => {
    expect(await history.search(USER, { limit: 10 })).toEqual({ items: [], next: null });
  });

  it('has no default page size: a blank limit refuses', async () => {
    await expect(history.search(USER, {})).rejects.toMatchObject({ code: 'pay.withdrawal_list_limit_unset' });
  });

  it('shows only the caller’s own withdrawals', async () => {
    await put();
    await put({ userId: OTHER });
    const page = await history.search(USER, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.status).toBe('requested');
  });

  it('shows the stored values in the customer vocabulary: an old sent row is settled', async () => {
    await put({ status: 'pending', at: '2026-10-20T08:00:01Z' });
    await put({ status: 'held', at: '2026-10-20T08:00:02Z' });
    await put({ status: 'sent', at: '2026-10-20T08:00:03Z' });
    await put({ status: 'failed', failure: 'rail.refused', at: '2026-10-20T08:00:04Z' });
    const page = await history.search(USER, { limit: 10 });
    expect(page.items.map((i) => i.status)).toEqual(['failed', 'settled', 'held', 'requested']);
    expect(page.items[0]!.failure).toMatchObject({ code: 'rail.refused', known: true });
    expect(page.items[0]!.failure!.message).not.toMatch(/rail\./);
    expect(page.items[1]!.failure).toBeNull();
  });

  it('shows an unknown failure code as itself', async () => {
    await put({ status: 'failed', failure: 'rail.brand_new' });
    const [item] = (await history.search(USER, { limit: 10 })).items;
    expect(item!.failure).toEqual({ code: 'rail.brand_new', known: false, message: 'rail.brand_new' });
  });

  it('filters by asset, status, id and time together', async () => {
    const a = await put({ assetId: 'USDT', status: 'sent', at: '2026-10-20T08:00:00Z' });
    await put({ assetId: 'BTC', status: 'sent', at: '2026-10-20T09:00:00Z' });
    await put({ assetId: 'USDT', status: 'pending', at: '2026-10-20T10:00:00Z' });
    const ids = async (f: Parameters<typeof history.search>[1]) =>
      (await history.search(USER, { limit: 10, ...f })).items.map((i) => i.assetId + ':' + i.status);
    expect(await ids({ assetId: 'USDT' })).toEqual(['USDT:requested', 'USDT:settled']);
    expect(await ids({ status: 'settled' })).toEqual(['BTC:settled', 'USDT:settled']);
    expect(await ids({ assetId: 'USDT', status: 'settled' })).toEqual(['USDT:settled']);
    expect((await history.search(USER, { limit: 10, id: a })).items.map((i) => i.id)).toEqual([a]);
    expect(await ids({ since: '2026-10-20T09:00:00Z', until: '2026-10-20T10:00:00Z' })).toEqual(['BTC:settled']);
  });

  it('returns an empty page for a status no stored value can mean yet', async () => {
    await put({ status: 'sent' });
    expect(await history.search(USER, { limit: 10, status: 'canceled' })).toEqual({ items: [], next: null });
    expect(await history.search(USER, { limit: 10, status: 'broadcast' })).toEqual({ items: [], next: null });
  });

  it('pages a history longer than 200 rows to the end with a cursor, with no row twice or missing', async () => {
    const expected: string[] = [];
    // 230 rows, many sharing the same microsecond so the id is what breaks the tie.
    for (let i = 0; i < 230; i += 1) {
      expected.push(await put({ at: `2026-10-20T08:00:${String(Math.floor(i / 10)).padStart(2, '0')}.000000Z` }));
    }
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await history.search(USER, { limit: 100, after });
      seen.push(...page.items.map((i) => i.id));
      after = page.next ?? undefined;
      pages += 1;
    } while (after);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(230);
    expect(new Set(seen).size).toBe(230);
    expect([...seen].sort()).toEqual([...expected].sort());
  }, 60_000);

  it('keeps microseconds in the cursor so rows a millisecond apart are not skipped', async () => {
    await put({ at: '2026-10-20T08:00:00.000100Z' });
    await put({ at: '2026-10-20T08:00:00.000200Z' });
    await put({ at: '2026-10-20T08:00:00.000300Z' });
    const first = await history.search(USER, { limit: 1 });
    const second = await history.search(USER, { limit: 1, after: first.next! });
    const third = await history.search(USER, { limit: 1, after: second.next! });
    expect([first, second, third].map((p) => p.items[0]!.createdAt)).toEqual([
      '2026-10-20T08:00:00.000300Z',
      '2026-10-20T08:00:00.000200Z',
      '2026-10-20T08:00:00.000100Z',
    ]);
    expect(third.next).toBeNull();
  });

  it('refuses a cursor it did not issue', async () => {
    await expect(history.search(USER, { limit: 10, after: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'pay.withdrawal_cursor_invalid',
    });
    const forged = Buffer.from(JSON.stringify({ t: "2026-10-20'; DROP TABLE x;--", i: 'x' })).toString('base64url');
    await expect(history.search(USER, { limit: 10, after: forged })).rejects.toMatchObject({ code: 'pay.withdrawal_cursor_invalid' });
  });
});
