import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import { historyPageInputSchema, orderIdFromHoldPurpose, serializeHistoryPage, type HistoryPageInput } from './history.js';

/**
 * `historyPage` names the page owner's OWN trade order on each line the ledger links to one
 * (hold, amend, release, fill leg), from the order-hold account the same transaction moves for that owner.
 * PG-hard like `history-page-postgres.test.ts`: TEST_DATABASE_URL in CI, Testcontainers locally.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const TAKER = '81111111-1111-4111-8111-111111111111';
const MAKER = '82222222-2222-4222-8222-222222222222';
const SELF = '83333333-3333-4333-8333-333333333333';

const TAKER_ORDER = 'd1111111-1111-4111-8111-d11111111111';
const MAKER_ORDER = 'd2222222-2222-4222-8222-d22222222222';
const MAKER_ORDER_2 = 'd3333333-3333-4333-8333-d33333333333';
const MM_TAKER_ORDER = 'd4444444-4444-4444-8444-d44444444444';
const SELF_BUY = 'd5555555-5555-4555-8555-d55555555555';
const SELF_SELL = 'd6666666-6666-4666-8666-d66666666666';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_order_id_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    throw new Error(
      `historyPage orderId is PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const scope = (ownerId: string, over: Partial<HistoryPageInput> = {}): HistoryPageInput =>
  historyPageInputSchema.parse({ ownerType: 'user', ownerId, kind: 'available', limit: 200, ...over });

describe('PostgresLedger.historyPage orderId', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  const fund = (userId: string, assetId: string, value: string, ref: string) =>
    engine.post(recipes.deposit({ userId, assetId, amount: amt(value), rail: 'crypto-native', railRef: ref }));

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_history_page_order_id', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);

    await fund(TAKER, 'USDT', '5000', 'oid-taker-usdt');
    await fund(MAKER, 'BTC', '5', 'oid-maker-btc');
    await fund(SELF, 'USDT', '2000', 'oid-self-usdt');
    await fund(SELF, 'BTC', '2', 'oid-self-btc');

    // Taker buys BTC with USDT: one order, topped up once, filled in TWO fills by two different makers' orders
    // (the partial-fill / multi-fill case), then the unfilled rest is released.
    await engine.post(recipes.orderHold({ orderId: TAKER_ORDER, userId: TAKER, assetId: 'USDT', amount: amt('1000') }));
    await engine.post(recipes.orderHoldAmend({ orderId: TAKER_ORDER, userId: TAKER, assetId: 'USDT', amount: amt('500'), sequence: 1 }));
    await engine.post(recipes.orderHold({ orderId: MAKER_ORDER, userId: MAKER, assetId: 'BTC', amount: amt('1') }));
    await engine.post(recipes.orderHold({ orderId: MAKER_ORDER_2, userId: MAKER, assetId: 'BTC', amount: amt('1') }));
    const fill = (fillId: string, makerOrderId: string, quoteAmount: string) =>
      recipes.tradeFill({
        fillId,
        makerId: MAKER,
        takerId: TAKER,
        makerOrderId,
        takerOrderId: TAKER_ORDER,
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('1'),
        quoteAmount: amt(quoteAmount),
        takerSide: 'buy',
        makerFeeBps: 10,
        takerFeeBps: 20,
      });
    await engine.post(fill('oid-fill-1', MAKER_ORDER, '600'));
    await engine.post(fill('oid-fill-2', MAKER_ORDER_2, '620'));
    await engine.post(recipes.orderHoldRelease({ orderId: TAKER_ORDER, userId: TAKER, assetId: 'USDT', amount: amt('280') }));

    // House market-maker is the maker (the Convert shape): only the customer's taker order is on a customer line.
    await engine.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('3'), seedId: 'oid-seed-btc' }));
    await engine.post(recipes.orderHold({ orderId: MM_TAKER_ORDER, userId: TAKER, assetId: 'USDT', amount: amt('700') }));
    await engine.post(recipes.marketMakerOrderHold({ orderId: 'mm-side-1', assetId: 'BTC', amount: amt('1') }));
    await engine.post(
      recipes.marketMakerMakerFill({
        fillId: 'oid-mm-fill',
        takerId: TAKER,
        makerOrderId: 'mm-side-1',
        takerOrderId: MM_TAKER_ORDER,
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('1'),
        quoteAmount: amt('700'),
        takerSide: 'buy',
        makerFeeBps: 0,
        takerFeeBps: 0,
      }),
    );

    // One user on BOTH sides of a fill: each of their two lines must still name its own order.
    await engine.post(recipes.orderHold({ orderId: SELF_BUY, userId: SELF, assetId: 'USDT', amount: amt('900') }));
    await engine.post(recipes.orderHold({ orderId: SELF_SELL, userId: SELF, assetId: 'BTC', amount: amt('1') }));
    await engine.post(
      recipes.tradeFill({
        fillId: 'oid-self-fill',
        makerId: SELF,
        takerId: SELF,
        makerOrderId: SELF_SELL,
        takerOrderId: SELF_BUY,
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('1'),
        quoteAmount: amt('900'),
        takerSide: 'buy',
        makerFeeBps: 0,
        takerFeeBps: 0,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const lines = async (ownerId: string) => (await engine.historyPage(scope(ownerId))).entries;
  const byReason = (entries: Awaited<ReturnType<typeof lines>>, reason: string) => entries.filter((e) => e.reason === reason);

  it('a taker fill leg carries the taker order id, on each of several fills', async () => {
    const fills = byReason(await lines(TAKER), 'trade.fill');
    expect(fills).toHaveLength(2);
    for (const f of fills) expect(f).toMatchObject({ assetId: 'BTC', direction: 'debit', orderId: TAKER_ORDER });
  });

  it("a maker fill leg carries the maker's own order id, never the taker's", async () => {
    const fills = byReason(await lines(MAKER), 'trade.fill');
    expect(fills.map((f) => f.orderId).sort()).toEqual([MAKER_ORDER, MAKER_ORDER_2].sort());
    for (const f of fills) expect(f).toMatchObject({ assetId: 'USDT', direction: 'debit' });
    expect(fills.some((f) => f.orderId === TAKER_ORDER)).toBe(false);
  });

  it('an order hold, a hold amend and a release carry the order id', async () => {
    const t = await lines(TAKER);
    expect(byReason(t, 'order.hold').find((e) => e.orderId === TAKER_ORDER)).toMatchObject({ direction: 'credit', assetId: 'USDT' });
    expect(byReason(t, 'order.hold.amend')).toMatchObject([{ orderId: TAKER_ORDER, direction: 'credit' }]);
    expect(byReason(t, 'order.hold.released')).toMatchObject([{ orderId: TAKER_ORDER, direction: 'debit' }]);
    expect(
      byReason(await lines(MAKER), 'order.hold')
        .map((e) => e.orderId)
        .sort(),
    ).toEqual([MAKER_ORDER, MAKER_ORDER_2].sort());
  });

  it("a fill against the house market maker carries the customer's own order id", async () => {
    const mm = byReason(await lines(TAKER), 'trade.fill.mm_maker');
    expect(mm).toMatchObject([{ assetId: 'BTC', direction: 'debit', orderId: MM_TAKER_ORDER }]);
  });

  it('one user on both sides of a fill: each line names its own order by the asset it received', async () => {
    const own = (await lines(SELF)).filter((e) => e.reason === 'trade.fill');
    expect(own).toHaveLength(2);
    expect(own.find((e) => e.assetId === 'BTC')?.orderId).toBe(SELF_BUY); // bought BTC with the buy order
    expect(own.find((e) => e.assetId === 'USDT')?.orderId).toBe(SELF_SELL); // sold BTC with the sell order
  });

  it('a line with no order (a deposit) has orderId null, and the wire form carries null', async () => {
    const page = await engine.historyPage(scope(TAKER));
    const dep = page.entries.filter((e) => e.reason === 'deposit.credited');
    expect(dep).toHaveLength(1);
    expect(dep[0]!.orderId).toBeNull();
    expect(serializeHistoryPage(page).entries.find((e) => e.reason === 'deposit.credited')).toMatchObject({ orderId: null });
    expect(serializeHistoryPage(page).entries.find((e) => e.reason === 'order.hold.amend')).toMatchObject({ orderId: TAKER_ORDER });
  });

  it('paging is unchanged: the same entries in the same order, with or without order ids', async () => {
    const all = await engine.historyPage(scope(TAKER));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await engine.historyPage(scope(TAKER, { limit: 3, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.entries.map((e) => e.entryId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.entries.map((e) => e.entryId));
  });
});

describe('orderIdFromHoldPurpose', () => {
  it('reads an order hold purpose and nothing else', () => {
    expect(orderIdFromHoldPurpose('order:abc-123')).toBe('abc-123');
    for (const bad of ['withdraw:abc', 'order:', 'order:a b', 'order:a/b', `order:${'x'.repeat(129)}`, '', null, undefined, 7]) {
      expect(orderIdFromHoldPurpose(bad)).toBeNull();
    }
  });
});
