/**
 * The Fees and convert room's finance reads (J-cex-spot-17 #4, #7, #8) and the money invariant of a fee schedule change
 * (#3): writing a version moves nothing, and an order is charged exactly the version in force when it was placed.
 * Real Postgres via TEST_DATABASE_URL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { MemoryApprovalBook, payloadHash } from './common.js';
import { TradeOpsAdmin } from './service.js';
import { FeesConvertDesk, type ConvertOwnerValues } from './fees-convert-desk.js';
import { feeScheduleAt } from '../spot/fee-schedule-store.js';
import { parseFeeScheduleJson, publishedProductBps } from '../spot/fee-schedule.js';
import { principalFor } from '../spot/testing.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '55555555-5555-4555-8555-555555555555';
const reader = () => principalFor(OP, ['admin:read']);
const writer = () => principalFor(OP, ['admin:read', 'admin:write']);
const stranger = () => principalFor(OP, ['trade:read']);
const NOW = new Date('2026-11-06T10:00:00.000Z');

const CONVERT: ConvertOwnerValues = {
  pairs: async () => ({
    assets: [
      { asset: 'BTC', maxPerConvert: { amount: '100000', asset: 'USDT' } },
      { asset: 'USDT', maxPerConvert: { amount: '100000', asset: 'USDT' } },
    ],
    restricted: ['IFC'],
    paused: false,
  }),
  spreadBps: 20,
  quoteTtlMs: 15_000,
  deskBounds: { convert: { minQty: parseAmount('0.1'), maxQty: parseAmount('5') } },
};

describe('fees and convert desk (PG-hard)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);
  beforeEach(async () => {
    await db.sql`TRUNCATE trade.fee_tier_snapshots, trade.fee_tier_snapshot_runs, trade.convert_quotes, trade.fee_schedule_versions,
      trade.operator_audit RESTART IDENTITY CASCADE`;
  });

  const desk = (convert?: ConvertOwnerValues) => new FeesConvertDesk({ sql: db.sql, ...(convert ? { convert } : {}) });

  async function snapshotRun(instant: string, version: string, rows: Array<{ user: string; tier: string; volume: string }>) {
    for (const row of rows) {
      await db.sql`INSERT INTO trade.fee_tier_snapshots (key, instant, user_id, tier_id, volume_30d, counted_fills, schedule_version)
        VALUES (${`tier-snapshot:${instant.slice(0, 16)}Z:${row.user}`}, ${instant}, ${row.user}, ${row.tier}, ${row.volume}, 1, ${version})`;
    }
    await db.sql`INSERT INTO trade.fee_tier_snapshot_runs (instant, schedule_version, accounts) VALUES (${instant}, ${version}, ${rows.length})`;
  }

  it('lists snapshot runs newest first with the figures each used, a run with no accounts included', async () => {
    await snapshotRun('2026-11-05T00:00:00.000Z', 'v3', []);
    await snapshotRun('2026-11-06T00:00:00.000Z', 'v4', [
      { user: '66666666-6666-4666-8666-666666666661', tier: 'test-vip-1', volume: '1500.5' },
      { user: '66666666-6666-4666-8666-666666666662', tier: 'regular', volume: '0.000000000000000001' },
    ]);
    const runs = await desk().snapshotRuns(reader(), 10);
    expect(runs.map((r) => [r.instant, r.scheduleVersion, r.accounts, r.aboveRegular, r.countedVolume])).toEqual([
      ['2026-11-06T00:00:00.000Z', 'v4', 2, 1, '1500.500000000000000001'],
      ['2026-11-05T00:00:00.000Z', 'v3', 0, 0, '0'],
    ]);
    expect(await desk().snapshotRuns(reader(), 1)).toHaveLength(1);
  });

  it('refuses a snapshot read with no page size or from a caller who is not an operator', async () => {
    await expect(desk().snapshotRuns(reader(), 0)).rejects.toMatchObject({ code: 'fees_desk_limit_unset' });
    await expect(desk().snapshotRuns(reader(), 101)).rejects.toMatchObject({ code: 'fees_desk_limit_unset' });
    await expect(desk().snapshotRuns(stranger(), 10)).rejects.toThrow();
  });

  it("reads Convert's state and owner values, a blank one as null and never a default", async () => {
    expect(await desk(CONVERT).convertSettings(reader())).toEqual({
      paused: false,
      assets: [
        { asset: 'BTC', maxPerConvert: { amount: '100000', asset: 'USDT' } },
        { asset: 'USDT', maxPerConvert: { amount: '100000', asset: 'USDT' } },
      ],
      restricted: ['IFC'],
      spreadBps: '20',
      quoteTtlMs: '15000',
      deskBounds: { convert: { minQty: '0.1', maxQty: '5' }, oneClickBuy: null },
    });
    const blank: ConvertOwnerValues = {
      pairs: async () => ({ assets: [{ asset: 'BTC', maxPerConvert: null }], restricted: [], paused: true }),
      spreadBps: null,
      quoteTtlMs: null,
      deskBounds: {},
    };
    expect(await desk(blank).convertSettings(reader())).toEqual({
      paused: true,
      assets: [{ asset: 'BTC', maxPerConvert: null }],
      restricted: [],
      spreadBps: null,
      quoteTtlMs: null,
      deskBounds: { convert: null, oneClickBuy: null },
    });
  });

  it('refuses the convert read when it was never wired, and for a caller who is not an operator', async () => {
    await expect(desk().convertSettings(reader())).rejects.toMatchObject({ code: 'trade.convert_settings_unwired' });
    await expect(desk(CONVERT).convertSettings(stranger())).rejects.toThrow();
  });

  async function quote(id: string, side: 'buy' | 'sell', createdAt: string, book: string, customer: string) {
    const sell = side === 'sell';
    await db.sql`INSERT INTO trade.convert_quotes (
      quote_id, user_id, lifecycle, symbol, market_id, side, base_asset, quote_asset, in_asset, out_asset, in_amount, out_amount,
      requested_qty, filled_qty, book_notional, user_notional, avg_price, convert_spread_bps, fully_filled, source_kind,
      source_symbol, source_as_of, created_at, expires_at
    ) VALUES (
      ${id}, ${CUSTOMER}, 'open', 'BTC/USDT', 'm-1', ${side}, 'BTC', 'USDT', ${sell ? 'BTC' : 'USDT'}, ${sell ? 'USDT' : 'BTC'},
      ${sell ? '0.001' : customer}, ${sell ? customer : '0.001'}, '0.001', '0.001', ${book}, ${customer}, '64000.123456789012345678',
      20, true, 'book', 'BTC/USDT', ${createdAt}, ${createdAt}, ${createdAt}
    )`;
  }

  it('lists the quotes of one side newest first, with exact amounts and the exact spread kept', async () => {
    await quote('q-old', 'sell', '2026-11-06T09:00:00.000Z', '64.000123456789012345', '63.872123209875434320');
    await quote('q-new', 'sell', '2026-11-06T09:30:00.000Z', '64.5', '64.371');
    await quote('q-buy', 'buy', '2026-11-06T09:45:00.000Z', '64.5', '64.629');
    const sells = await desk().convertQuotes(reader(), { side: 'sell', limit: 10 });
    expect(sells.map((q) => q.quoteId)).toEqual(['q-new', 'q-old']);
    expect(sells[1]).toMatchObject({
      userId: CUSTOMER,
      inAsset: 'BTC',
      inAmount: '0.001',
      outAsset: 'USDT',
      outAmount: '63.87212320987543432',
      avgPrice: '64000.123456789012345678',
      spreadAmount: '0.128000246913578025',
      spreadAsset: 'USDT',
      spreadBps: 20,
      lifecycle: 'open',
    });
    // A buy keeps the spread on the other side: the customer pays more than the book.
    const [buy] = await desk().convertQuotes(reader(), { side: 'buy', limit: 10 });
    expect(buy).toMatchObject({ quoteId: 'q-buy', spreadAmount: '0.129' });
    await expect(desk().convertQuotes(reader(), { side: 'sell', limit: 0 })).rejects.toMatchObject({ code: 'fees_desk_limit_unset' });
    await expect(desk().convertQuotes(stranger(), { side: 'sell', limit: 10 })).rejects.toThrow();
  });

  it('a fee schedule change moves nothing, and each order is charged exactly the version in force when it was placed', async () => {
    const book = new MemoryApprovalBook();
    const balances: string[] = [];
    const admin = new TradeOpsAdmin({
      sql: db.sql,
      approvals: book,
      ledger: {
        async balance(ref) {
          balances.push(JSON.stringify(ref));
          return { accountId: 'unused', amount: 0n };
        },
      },
      reconcileOrder: async () => {
        throw new Error('a schedule change reconciles no order');
      },
      cancelOrder: async () => {
        throw new Error('a schedule change cancels no order');
      },
      now: () => NOW,
    });
    const effectiveAt = '2026-11-06T10:02:00.000Z';
    const reason = 'IFC/USDT maker 0.02% from a stated time';
    const schedule = {
      defaultPairGroup: 'all-others',
      pairGroups: { 'IFC/USDT': 'test-fee-change' },
      rows: [
        { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null },
        { pairGroup: 'test-fee-change', tierId: 'regular', zeroFee: false, makerBps: '2', takerBps: '10', minFee: null },
      ],
    };
    book.put({
      approvalId: 'fee-1',
      actionType: 'trade.fee_schedule_set',
      targetService: 'svc-trade',
      targetId: 'spot-fee-schedule',
      expectedVersion: '0',
      payloadHash: payloadHash({ actionType: 'trade.fee_schedule_set', schedule, effectiveAt, expectedVersion: '0', reason }),
      requesterId: OP,
      approverId: APPROVER,
      operationId: 'op-fee-1',
    });
    const counts = async () =>
      (
        await db.sql<Array<{ orders: number; fills: number }>>`
          SELECT (SELECT count(*) FROM trade.orders)::int AS orders, (SELECT count(*) FROM trade.fills)::int AS fills`
      )[0];
    const before = await counts();
    await admin.feeScheduleSet(writer(), {
      schedule,
      effectiveAt,
      expectedVersion: '0',
      reason,
      approvalId: 'fee-1',
      operationId: 'op-fee-1',
    });
    // Nothing moved: no balance read, no order or fill row, no reconcile or cancel.
    expect(balances).toEqual([]);
    expect(await counts()).toEqual(before);

    const base = parseFeeScheduleJson(JSON.stringify({ published: true, version: 'boot', makerBps: '4', takerBps: '10' }));
    const charged = async (placedAt: string) =>
      publishedProductBps(await feeScheduleAt(db.sql, base, new Date(placedAt)), 'spot', { symbol: 'IFC/USDT' });
    // Placed a millisecond before the stated time: the old version, whenever it fills. At or after it: the new one.
    expect(await charged('2026-11-06T10:01:59.999Z')).toEqual({ makerBps: 4, takerBps: 10 });
    expect(await charged(effectiveAt)).toEqual({ makerBps: 2, takerBps: 10 });
    expect(await charged('2026-11-06T10:05:00.000Z')).toEqual({ makerBps: 2, takerBps: 10 });
  });
});
