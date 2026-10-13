import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { formatAmount, parseAmount as amt, railBoundary, userAvailable } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import {
  HISTORY_PAGE_DEFAULT_LIMIT,
  encodeHistoryCursor,
  historyPageInputSchema,
  parseHistoryDoorInput,
  type HistoryPageInput,
} from './history.js';

/**
 * U5a: `historyPage` against a real book. Same PG-hard rules as
 * `history-postgres.test.ts` (no skip-green; TEST_DATABASE_URL in CI,
 * Testcontainers locally).
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const PAGER = '71111111-1111-4111-8111-111111111111';
const OTHER = '72222222-2222-4222-8222-222222222222';
const EMPTY = '73333333-3333-4333-8333-333333333333';
const TIED_AT = '2026-03-01T12:00:00.000Z';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    throw new Error(
      `H8a: ledger historyPage is PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const scope = (over: Partial<HistoryPageInput> = {}): HistoryPageInput =>
  historyPageInputSchema.parse({ ownerType: 'user', ownerId: PAGER, kind: 'available', ...over });

describe('PostgresLedger.historyPage', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;
  /** txIds of the 7 tied USDT entries, in entry-id order. */
  let tiedTxIds: string[] = [];

  const move = (userId: string, key: string, asset: string, value: string) => ({
    idempotencyKey: key,
    module: 'bank',
    reason: 'bank.transfer.in',
    entries: [
      { account: userAvailable(userId, asset), direction: 'debit' as const, amount: amt(value) },
      { account: railBoundary('crypto-native', asset), direction: 'credit' as const, amount: amt(value) },
    ],
  });

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_history_page', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);

    // Two real posted movements per asset (distinct, later timestamps).
    await engine.post(move(PAGER, 'pg-usdt-1', 'USDT', '1'));
    await engine.post(move(PAGER, 'pg-usd-1', 'USD', '2'));
    await engine.post(move(PAGER, 'pg-usdt-2', 'USDT', '3'));
    // Another user in the same asset: must never appear.
    await engine.post(move(OTHER, 'pg-other-1', 'USDT', '999'));

    // Seven entries on the pager's USDT account sharing ONE timestamp. Posted
    // rows are bulk-inserted: the chain is deliberately not extended (this
    // suite never calls reconcile()).
    const accountId = (
      await db.sql<Array<{ id: string }>>`
        SELECT id FROM accounts WHERE owner_id = ${PAGER} AND asset_id = 'USDT' AND kind = 'available'::account_kind
      `
    )[0]!.id;
    await db.sql`
      INSERT INTO ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
      SELECT gen_random_uuid(), 'tied-key-' || i, 'bank', 'bank.tied', '{}'::jsonb, ${TIED_AT}::timestamptz, 'tied-hash-' || i, NULL
        FROM generate_series(1, 7) AS i
    `;
    await db.sql`
      INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
      SELECT t.id, ${accountId}::uuid, 'USDT', 'debit'::direction, 1::numeric, 1::numeric
        FROM ledger_tx t WHERE t.idempotency_key LIKE 'tied-key-%' ORDER BY t.idempotency_key
    `;
    tiedTxIds = (
      await db.sql<Array<{ tx_id: string }>>`
        SELECT e.tx_id FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
         WHERE t.idempotency_key LIKE 'tied-key-%' ORDER BY e.id
      `
    ).map((r) => r.tx_id);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function walk(input: Partial<HistoryPageInput>, limit: number) {
    const seen: Array<{ txId: string; assetId: string; postedAt: Date }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await engine.historyPage(scope({ ...input, limit, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.entries);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 50);
    return { seen, pages };
  }

  it('pages newest first across a boundary inside equal timestamps: every entry once, none skipped', async () => {
    // 7 tied + 3 real USDT/USD = 10 entries across both assets; limit 3 puts a
    // page boundary in the middle of the tied block.
    const all = await engine.historyPage(scope({ limit: 200 }));
    expect(all.entries).toHaveLength(10);
    expect(all.nextCursor).toBeNull();

    const { seen, pages } = await walk({}, 3);
    expect(pages).toBe(4);
    expect(seen.map((e) => e.txId)).toEqual(all.entries.map((e) => e.txId));
    expect(new Set(seen.map((e) => e.txId)).size).toBe(10);

    // Newest first, ties broken by entry id DESC.
    const times = seen.map((e) => e.postedAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const tied = seen.filter((e) => e.postedAt.toISOString() === TIED_AT).map((e) => e.txId);
    expect(tied).toEqual([...tiedTxIds].reverse());
  });

  it('filters by asset and the cursor stays inside that filter', async () => {
    const usd = await engine.historyPage(scope({ assetId: 'USD' }));
    expect(usd.entries).toHaveLength(1);
    expect(usd.entries[0]!.assetId).toBe('USD');
    expect(formatAmount(usd.entries[0]!.amount)).toBe('2');

    const { seen } = await walk({ assetId: 'USDT' }, 4);
    expect(seen).toHaveLength(9);
    expect(seen.every((e) => e.assetId === 'USDT')).toBe(true);
  });

  it('`before` bounds the first page (strictly before)', async () => {
    const page = await engine.historyPage(scope({ before: TIED_AT, limit: 200 }));
    // Real postings are "now", after TIED_AT; nothing is strictly before it.
    expect(page.entries).toEqual([]);
    const page2 = await engine.historyPage(scope({ before: new Date(Date.parse(TIED_AT) + 1).toISOString(), limit: 200 }));
    expect(page2.entries).toHaveLength(7);
  });

  it('answers an empty history, and an account that never existed, as empty with no cursor (and creates nothing)', async () => {
    const page = await engine.historyPage(scope({ ownerId: EMPTY }));
    expect(page).toEqual({ entries: [], nextCursor: null });
    const rows = await db!.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM accounts WHERE owner_id = ${EMPTY}`;
    expect(rows[0]!.n).toBe('0');
  });

  it('a page that ends exactly on the last entry has no nextCursor', async () => {
    const page = await engine.historyPage(scope({ limit: 10 }));
    expect(page.entries).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  it('a FORGED cursor cannot read another account: scope comes from input, never the cursor', async () => {
    // Another user's newest entry id and a valid-looking cursor at the far
    // future: it can only act as a position inside PAGER's own set.
    const otherId = (
      await db!.sql<Array<{ id: string }>>`
        SELECT e.id::text AS id FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
         WHERE a.owner_id = ${OTHER} AND a.asset_id = 'USDT' LIMIT 1
      `
    )[0]!.id;
    const forged = encodeHistoryCursor({ postedAt: new Date('2099-01-01T00:00:00Z'), entryId: otherId });

    const page = await engine.historyPage(scope({ cursor: forged, limit: 200 }));
    expect(page.entries).toHaveLength(10);
    expect(formatAmount(page.entries[0]!.amount)).not.toBe('999');
    expect(page.entries.map((e) => formatAmount(e.amount))).not.toContain('999');
  });

  it('REFUSES garbage cursors with a typed error instead of answering page one', async () => {
    const bad = [
      'not-a-cursor!',
      Buffer.from('v1.abc.def').toString('base64url'),
      Buffer.from('v2.1.1').toString('base64url'),
      Buffer.from("v1.1.1'; DROP TABLE accounts;--").toString('base64url'),
      Buffer.from('v1.1.99999999999999999999').toString('base64url'),
    ];
    for (const cursor of bad) {
      await expect(engine.historyPage(scope({ cursor }))).rejects.toMatchObject({ code: 'ledger.history_cursor_invalid' });
    }
  });

  it('limit is 1..200 with a default of 50', async () => {
    expect(scope().limit).toBe(HISTORY_PAGE_DEFAULT_LIMIT);
    expect(HISTORY_PAGE_DEFAULT_LIMIT).toBe(50);
    for (const limit of [0, -1, 201, 1.5]) {
      expect(() => scope({ limit })).toThrow();
    }
    expect(scope({ limit: 1 }).limit).toBe(1);
    expect(scope({ limit: 200 }).limit).toBe(200);
    const one = await engine.historyPage(scope({ limit: 1 }));
    expect(one.entries).toHaveLength(1);
    expect(one.nextCursor).not.toBeNull();
  });

  it('does not touch the old `history`: ascending bare array, window required, cursor still refused', async () => {
    const entries = await engine.history(userAvailable(PAGER, 'USDT'), {
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2099-01-01T00:00:00Z'),
    });
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(9);
    expect(Object.keys(entries[0]!).sort()).toEqual(['amount', 'direction', 'module', 'postedAt', 'reason', 'txId']);
    const times = entries.map((e) => e.postedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(() =>
      parseHistoryDoorInput({
        account: userAvailable(PAGER, 'USDT'),
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
        cursor: 'x',
      }),
    ).toThrow(/socket/);
  });
});
