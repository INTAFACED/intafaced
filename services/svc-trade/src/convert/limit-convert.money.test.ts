/**
 * Limit convert (J-cex-spot-11 #8). PG-hard, never skipped.
 *
 * The source is held whole while the limit waits; a quote at or better than the target settles once through the
 * ordinary convert path, and what the fill did not use is free again. Every branch ends with nothing held and the
 * ledger reconciled; a crash between the claim and the settle replays the same release and the same quote.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import {
  MemoryLedger,
  formatAmount,
  orderHoldAccount,
  parseAmount as amt,
  recipes,
  stampPostAttempts,
  userAvailable,
  type Amount,
} from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TradeService, readyTestAdmission } from '../controls/test-admission.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';
import { rateReached } from '../spot/trade-service/limit-convert.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SPREAD_BPS = 20;

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_limit_convert_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('rateReached', () => {
  it('a buy reaches the target when it pays at most the target per coin; a sell when it receives at least it', () => {
    expect(rateReached('buy', amt('100'), amt('20'), amt('0.2'))).toBe(true);
    expect(rateReached('buy', amt('100'), amt('20'), amt('0.19'))).toBe(false);
    expect(rateReached('sell', amt('100'), amt('0.2'), amt('20'))).toBe(true);
    expect(rateReached('sell', amt('100'), amt('0.2'), amt('19.99'))).toBe(false);
    expect(rateReached('buy', amt('100'), amt('20'), 0n)).toBe(false);
  });
});

describe('limit convert (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let admission: TradingAdmissionPort;
  let clock: Date;

  const free = async (userId: string, asset: string) => (await ledger.balance(userAvailable(userId, asset))).amount;
  const held = async (userId: string, asset: string, id: string) => (await ledger.balance(orderHoldAccount(userId, asset, id))).amount;
  const fills = () => ledger.journal().filter((tx) => tx.reason === 'trade.fill.mm_maker');
  const alice = () => principalFor(ALICE, ['trade:read', 'trade:write']);

  function service(sweepMs: number | null = 2_000) {
    return new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      convertEnabled: true,
      convertSpreadBps: SPREAD_BPS,
      convertQuoteTtlMs: 15_000,
      convertLimitSweepMs: sweepMs,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      accountAdmission: admission,
      now: () => clock,
    });
  }

  async function place(trade: TradeService, amount = '20', target = '99', clientLimitId = randomUUID()) {
    return trade.placeLimitConvert(alice(), {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: amt(amount),
      targetRate: amt(target),
      clientLimitId,
    });
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.convert_limits, trade.convert_quotes, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    clock = new Date('2026-11-06T06:00:00.000Z');
    ledger = new MemoryLedger();
    matching = new StubMatching();
    // The book now: the ask is 100, above a 99 target once the spread is on.
    matching.asks = [['100', '5']];
    matching.bids = [['99', '5']];
    admission = readyTestAdmission();
    await service().listMarket({
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
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: `${ALICE}:${randomUUID()}` }),
    );
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: `limit-btc-${randomUUID()}` }));
  });

  it('holds the whole source while it waits, then fills once at or under the target and frees the rest', async () => {
    const trade = service();
    const limit = await place(trade);
    expect(limit.status).toBe('waiting');
    expect(await free(ALICE, 'USDT')).toBe(amt('80'));
    expect(await held(ALICE, 'USDT', limit.id)).toBe(amt('20'));

    // Not reached: the quote's own rate (ask plus spread) is above 99.
    expect(await trade.sweepLimitConverts()).toMatchObject({ examined: 1, filled: 0 });
    expect(fills()).toHaveLength(0);
    expect(await free(ALICE, 'USDT')).toBe(amt('80'));

    // The book falls: 98 plus 20 bps is under 99.
    matching.asks = [['98', '5']];
    expect(await trade.sweepLimitConverts()).toMatchObject({ filled: 1 });
    const [done] = await trade.limitConverts(alice());
    expect(done).toMatchObject({ id: limit.id, status: 'filled' });
    const paid = amt(done!.paid!);
    const received = amt(done!.received!);
    expect(paid <= amt('20')).toBe(true);
    expect(rateReached('buy', amt('99'), paid, received)).toBe(true);
    expect(fills()).toHaveLength(1);
    expect(await free(ALICE, 'USDT')).toBe(amt('100') - paid);
    expect(await free(ALICE, 'BTC')).toBe(received);
    expect(await held(ALICE, 'USDT', limit.id)).toBe(0n);
    expect(ledger.reconcile()).toEqual({ ok: true });

    // Filled once: later sweeps find nothing to do.
    expect(await trade.sweepLimitConverts()).toMatchObject({ examined: 0 });
    expect(fills()).toHaveLength(1);
  });

  it('the same request id twice places one limit and holds once', async () => {
    const trade = service();
    const id = randomUUID();
    const a = await place(trade, '20', '99', id);
    const b = await place(trade, '20', '99', id);
    expect(b.id).toBe(a.id);
    expect(await free(ALICE, 'USDT')).toBe(amt('80'));
    await expect(place(trade, '30', '99', id)).rejects.toMatchObject({ code: 'trade.convert_limit_conflict' });
    expect(await free(ALICE, 'USDT')).toBe(amt('80'));
  });

  it('more than the balance, refused on its one attempt: the limit ends at once and holds nothing', async () => {
    const trade = service();
    const post = ledger.post.bind(ledger);
    // The shared HTTP client stamps how many attempts a post made; one attempt and a named refusal prove nothing booked.
    vi.spyOn(ledger, 'post').mockImplementation(async (req) => {
      try {
        return await post(req);
      } catch (err) {
        stampPostAttempts(err, 1);
        throw err;
      }
    });
    await expect(place(trade, '150')).rejects.toMatchObject({ code: 'ledger.insufficient_funds' });
    expect(await free(ALICE, 'USDT')).toBe(amt('100'));
    const [row] = await trade.limitConverts(alice());
    expect(row).toMatchObject({ status: 'ended', endCode: 'ledger.insufficient_funds' });
    expect(await trade.sweepLimitConverts()).toMatchObject({ examined: 0 });
  });

  it('a refused hold that does not prove nothing booked: never held again; ended once the in-flight bound has passed', async () => {
    const trade = service();
    await expect(place(trade, '150')).rejects.toMatchObject({ code: 'ledger.insufficient_funds' });
    const [row] = await trade.limitConverts(alice());
    expect(row!.status).toBe('placing');
    const journal = ledger.journal().length;
    // Within the bound the sweep only reads the key back: no second hold, no fill, the row keeps placing.
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: `${ALICE}:${randomUUID()}` }),
    );
    await trade.sweepLimitConverts();
    expect(ledger.journal()).toHaveLength(journal + 1);
    expect((await trade.limitConverts(alice()))[0]!.status).toBe('placing');
    expect(await free(ALICE, 'USDT')).toBe(amt('200'));
    // Past the bound with no hold booked, it ends; nothing was ever set aside.
    await db.sql`UPDATE trade.convert_limits SET updated_at = now() - interval '8 minutes' WHERE id = ${row!.id}`;
    await trade.sweepLimitConverts();
    expect((await trade.limitConverts(alice()))[0]).toMatchObject({ status: 'ended', endCode: 'trade.convert_limit_hold_not_booked' });
    expect(ledger.journal()).toHaveLength(journal + 1);
    expect(await held(ALICE, 'USDT', row!.id)).toBe(0n);
  });

  it('no sweep configured: placing refuses by name, nothing admitted or held', async () => {
    const journal = ledger.journal().length;
    await expect(place(service(null))).rejects.toMatchObject({ code: 'trade.convert_limit_unset' });
    expect(ledger.journal()).toHaveLength(journal);
    expect(await service().limitConverts(alice())).toEqual([]);
  });

  it('cancel releases the hold once; the sweep then never fills it', async () => {
    const trade = service();
    const limit = await place(trade);
    const cancelled = await trade.cancelLimitConvert(alice(), limit.id);
    expect(cancelled.status).toBe('cancelled');
    expect(await free(ALICE, 'USDT')).toBe(amt('100'));
    expect((await trade.cancelLimitConvert(alice(), limit.id)).status).toBe('cancelled');
    expect(await free(ALICE, 'USDT')).toBe(amt('100'));
    matching.asks = [['90', '5']];
    await trade.sweepLimitConverts();
    expect(fills()).toHaveLength(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it("another person's limit is not found and stays held", async () => {
    const trade = service();
    const limit = await place(trade);
    await expect(trade.cancelLimitConvert(principalFor(BOB, ['trade:read', 'trade:write']), limit.id)).rejects.toMatchObject({
      code: 'trade.convert_limit_not_found',
    });
    expect(await held(ALICE, 'USDT', limit.id)).toBe(amt('20'));
  });

  it('a crash after the claim, before the settle answers, replays the same release and quote: one fill', async () => {
    const trade = service();
    const limit = await place(trade);
    matching.asks = [['98', '5']];
    const post = ledger.post.bind(ledger);
    const spy = vi.spyOn(ledger, 'post').mockImplementation(async (req) => {
      if (req.reason === 'trade.fill.mm_maker') {
        spy.mockRestore();
        await post(req);
        throw new Error('connection reset after the fill posted');
      }
      return post(req);
    });
    expect(await trade.sweepLimitConverts()).toMatchObject({ failed: 1 });
    const [mid] = await trade.limitConverts(alice());
    expect(mid!.status).toBe('triggered');

    expect(await trade.sweepLimitConverts()).toMatchObject({ filled: 1 });
    const [done] = await trade.limitConverts(alice());
    expect(done!.quoteId).toBe(mid!.quoteId);
    expect(fills()).toHaveLength(1);
    expect(await free(ALICE, 'USDT')).toBe(amt('100') - amt(done!.paid!));
    expect(await held(ALICE, 'USDT', limit.id)).toBe(0n);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a claimed quote that expired before it settled ends the limit with the source free, never a second price', async () => {
    const trade = service();
    const limit = await place(trade);
    matching.asks = [['98', '5']];
    const post = ledger.post.bind(ledger);
    const spy = vi.spyOn(ledger, 'post').mockImplementation(async (req) => {
      if (req.reason === 'order.hold.released') {
        spy.mockRestore();
        throw new Error('ledger unreachable');
      }
      return post(req);
    });
    await trade.sweepLimitConverts();
    expect((await trade.limitConverts(alice()))[0]!.status).toBe('triggered');
    clock = new Date(clock.getTime() + 60_000);
    await trade.sweepLimitConverts();
    const [over] = await trade.limitConverts(alice());
    expect(over).toMatchObject({ status: 'ended', endCode: 'trade.convert_quote_expired' });
    expect(fills()).toHaveLength(0);
    expect(await free(ALICE, 'USDT')).toBe(amt('100'));
    expect(await held(ALICE, 'USDT', limit.id)).toBe(0n);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('the source spent elsewhere before the settle: the limit ends, nothing more is taken', async () => {
    const trade = service();
    const limit = await place(trade, '100');
    matching.asks = [['98', '5']];
    const post = ledger.post.bind(ledger);
    // Between the release and the settle's own hold, the freed USDT leaves (a withdrawal elsewhere).
    const spy = vi.spyOn(ledger, 'post').mockImplementation(async (req) => {
      const done = await post(req);
      if (req.reason === 'order.hold.released') {
        spy.mockRestore();
        await post(recipes.orderHold({ orderId: randomUUID(), userId: ALICE, assetId: 'USDT', amount: amt('100') as Amount }));
      }
      return done;
    });
    await trade.sweepLimitConverts();
    const [over] = await trade.limitConverts(alice());
    expect(over).toMatchObject({ status: 'ended', endCode: 'ledger.insufficient_funds' });
    expect(fills()).toHaveLength(0);
    expect(await held(ALICE, 'USDT', limit.id)).toBe(0n);
    expect(formatAmount(await free(ALICE, 'USDT'))).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
