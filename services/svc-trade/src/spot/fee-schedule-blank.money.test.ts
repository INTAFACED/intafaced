import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, houseFees, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { TradeService } from './trade-service.js';
import type { Market } from './types.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import { parseFeeScheduleJson, UNPUBLISHED_FEE_SCHEDULE } from './fee-schedule.js';

/**
 * CARD B1 money proof — unpublished TRADE_FEE_SCHEDULE refuses before hold/fill.
 *
 * Dedicated file so the Postgres gate is `postgresAvailable` (CI-red without DB)
 * and so orderHold / tradeFill never posting on unpublished is spied here, not
 * folded into the skip-wrapped idempotency suite.
 *
 * Listing-row makerBps/takerBps 10/20 are catalog columns, not the owner schedule.
 * Owner fixtures 3/7 are published test strings only — never invented product rates.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** Owner-published B1 fixtures as decimal strings — never JSON numbers, never listing 10/20. */
const OWNER_PUBLISHED_B1 = parseFeeScheduleJson(JSON.stringify({ published: true, version: 'b1', makerBps: '3', takerBps: '7' }));

describe('fee-schedule blank hitch (source)', () => {
  it('assertOwnerFeeSchedulePublished sits before recipes.orderHold and before fill recipes in settleFill', () => {
    const src = readFileSync(join(here, 'trade-service.ts'), 'utf8');
    const placeHitch = src.indexOf('this.assertOwnerFeeSchedulePublished();');
    const orderHold = src.indexOf('recipes.orderHold({');
    expect(placeHitch).toBeGreaterThan(-1);
    expect(orderHold).toBeGreaterThan(-1);
    expect(placeHitch).toBeLessThan(orderHold);

    const settleStart = src.indexOf('private async settleFill(');
    expect(settleStart).toBeGreaterThan(-1);
    const settle = src.slice(settleStart);
    const settleHitch = settle.indexOf('this.assertOwnerFeeSchedulePublished();');
    const tradeFill = settle.indexOf('recipes.tradeFill({');
    const mmFill = settle.indexOf('recipes.marketMakerMakerFill({');
    expect(settleHitch).toBeGreaterThan(-1);
    expect(tradeFill).toBeGreaterThan(-1);
    expect(mmFill).toBeGreaterThan(-1);
    expect(settleHitch).toBeLessThan(tradeFill);
    expect(settleHitch).toBeLessThan(mmFill);
  });

  it('router.ts has no TRADE_FEE_SCHEDULE / fee-schedule imports', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/TRADE_FEE_SCHEDULE/);
    expect(routerSrc).not.toMatch(/fee-schedule/);
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-trade fee-schedule B1 money (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'trade', url: URL, migrations });
  const sql = db.sql;

  describe('svc-trade fee-schedule B1 money', () => {
    let ledger: MemoryLedger;
    let bus: MemoryEventBus;
    let matching: StubMatching;
    let perks: StubPerks;
    let trade: TradeService;
    let btcusdt: Market;

    async function fund(userId: string, assetId: string, amount: string) {
      await ledger.post(
        recipes.deposit({
          userId,
          assetId,
          amount: amt(amount),
          rail: 'test',
          railRef: `${userId}:${assetId}:${amount}:${Math.random()}`,
        }),
      );
    }

    const avail = async (userId: string, assetId: string) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
    const held = async (userId: string, assetId: string) => {
      const all = await ledger.balances('user', userId);
      return formatAmount(
        all.filter((b) => b.account.kind === 'hold' && b.account.assetId === assetId).reduce((acc, b) => acc + b.amount, 0n),
      );
    };
    const fees = async (assetId: string) => formatAmount((await ledger.balance(houseFees('trade', assetId))).amount);
    const postsWithReason = (reason: string) => ledger.journal().filter((tx) => tx.reason === reason);

    async function rest(userId: string, market: Market, side: 'buy' | 'sell', qty: string, price: string, clientOrderId: string) {
      return trade.placeOrder(principalFor(userId), {
        marketId: market.id,
        side,
        type: 'limit',
        qty: amt(qty),
        price: amt(price),
        clientOrderId,
      });
    }

    beforeEach(async () => {
      await sql`TRUNCATE trade.convert_quotes, trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      bus = new MemoryEventBus('svc-trade');
      matching = new StubMatching();
      perks = new StubPerks();
      trade = new TradeService(sql, ledger, matching, perks, bus, {
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        marketSlippageCapBps: 150,
        feeSchedule: OWNER_PUBLISHED_B1,
      });

      btcusdt = await trade.listMarket({
        symbol: 'BTC/USDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: amt('1000'),
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
      });
    });

    afterAll(async () => {
      await db.drop();
    }, 30_000);

    describe('unpublished TRADE_FEE_SCHEDULE refuses before hold/fill', () => {
      it('unpublished place refuses trade.fee_schedule_blank before orderHold', async () => {
        await fund(ALICE, 'USDT', '1000');
        const closed = new TradeService(sql, ledger, matching, perks, bus, {
          marketLifecycle: READY_MARKET_LIFECYCLE,
          spotEnabled: true,
          feeSchedule: UNPUBLISHED_FEE_SCHEDULE,
        });

        await expect(
          closed.placeOrder(principalFor(ALICE), {
            marketId: btcusdt.id,
            side: 'buy',
            type: 'limit',
            qty: amt('2'),
            price: amt('100'),
            clientOrderId: 'alice-blank-fee-b1',
          }),
        ).rejects.toMatchObject({ code: 'trade.fee_schedule_blank' });

        expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
        expect(matching.submitted).toHaveLength(0);
        expect(postsWithReason('order.hold')).toHaveLength(0);
        expect(await held(ALICE, 'USDT')).toBe('0');
        expect(await avail(ALICE, 'USDT')).toBe('1000');
      });

      it('unpublished settleFillEvent refuses trade.fee_schedule_blank before tradeFill', async () => {
        // Rest both sides on a published service so orders exist; fill recipe is not posted yet.
        await fund(BOB, 'BTC', '5');
        await fund(ALICE, 'USDT', '1000');
        const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-rest-b1');
        const taker = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-rest-b1');
        expect(await sql`SELECT id FROM trade.fills`).toHaveLength(0);
        expect(postsWithReason('trade.fill')).toHaveLength(0);
        const holdsBefore = postsWithReason('order.hold').length;
        expect(holdsBefore).toBe(2);

        const closed = new TradeService(sql, ledger, matching, perks, bus, {
          marketLifecycle: READY_MARKET_LIFECYCLE,
          spotEnabled: true,
          feeSchedule: UNPUBLISHED_FEE_SCHEDULE,
        });

        await expect(
          closed.settleFillEvent({
            marketId: btcusdt.id,
            makerOrderId: maker.id,
            takerOrderId: taker.id,
            price: '100',
            qty: '2',
            sequence: 1,
            makerAccountId: BOB,
            takerAccountId: ALICE,
          }),
        ).rejects.toMatchObject({ code: 'trade.fee_schedule_blank' });

        expect(await sql`SELECT id FROM trade.fills`).toHaveLength(0);
        expect(postsWithReason('trade.fill')).toHaveLength(0);
        expect(postsWithReason('order.hold')).toHaveLength(holdsBefore);
      });

      it('published owner 3/7 drives fill fee_bps — listing 10/20 is not a rate', async () => {
        expect(btcusdt.makerBps).toBe(10);
        expect(btcusdt.takerBps).toBe(20);
        expect(OWNER_PUBLISHED_B1).toMatchObject({ published: true, makerBps: 3, takerBps: 7 });

        await fund(BOB, 'BTC', '5');
        await fund(ALICE, 'USDT', '1000');
        const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-sched-b1');
        matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' }]);
        await trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
          clientOrderId: 'alice-sched-b1',
        });

        // Taker 7 bps of 2 BTC = 0.0014 → Alice receives 1.9986 (listing 20 bps would be 1.996).
        expect(await avail(ALICE, 'BTC')).toBe('1.9986');
        // Maker 3 bps of 200 USDT = 0.06 → Bob receives 199.94 (listing 10 bps would be 199.80).
        expect(await avail(BOB, 'USDT')).toBe('199.94');
        expect(await fees('BTC')).toBe('0.0014');
        expect(await fees('USDT')).toBe('0.06');

        const legs = await sql<Array<{ fee_amount: string; fee_bps: string; liquidity: string }>>`
        SELECT fee_amount::text AS fee_amount, fee_bps::text AS fee_bps, liquidity FROM trade.fills ORDER BY liquidity
      `;
        expect(legs).toHaveLength(2);
        expect(legs.map((l) => l.fee_bps).sort()).toEqual(['3', '7']);
        expect(legs.map((l) => l.fee_bps)).not.toContain('10');
        expect(legs.map((l) => l.fee_bps)).not.toContain('20');
        expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
      });
    });
  });
}
