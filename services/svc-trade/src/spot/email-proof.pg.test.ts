/**
 * RC-identity-01 (J-identity-01 step 8): a new custodial order needs a proved
 * email. Refused before any hold; cancel stays open; identity down fails closed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PositionService, TradeService, readyTestAdmission } from '../controls/test-admission.js';
import { TradeService as ProductionTradeService } from './trade-service.js';
import { memoryMarkBook } from '../futures/mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from '../futures/profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from '../futures/initial-margin.test-harness.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubEmailProof, StubMatching, StubPerks, principalFor } from './testing.js';
import type { Market } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const alice = principalFor(ALICE, ['trade:read', 'trade:write']);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_email_proof_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('email proof gate on new custodial orders (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  async function setup() {
    await db.sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const matching = new StubMatching();
    const emailProof = new StubEmailProof();
    const trade = new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      algoEnabled: true,
      convertEnabled: true,
      convertSpreadBps: 25,
      convertQuoteTtlMs: 60_000,
      marketSlippageCapBps: 200,
      emailProof,
    });
    const market: Market = await trade.listMarket({
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
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'ep:u' }));
    const order = (clientOrderId: string) => ({
      marketId: market.id,
      side: 'buy' as const,
      type: 'limit',
      qty: amt('1'),
      price: amt('50'),
      clientOrderId,
    });
    return { trade, ledger, matching, emailProof, market, order };
  }

  it('refuses an unproved email before any hold, then accepts the same order once proved', async () => {
    const { trade, ledger, matching, emailProof, order } = await setup();
    emailProof.missing.add(ALICE);
    const journal = ledger.journal().length;

    await expect(trade.placeOrder(alice, order('ep-1'))).rejects.toMatchObject({ code: 'trade.email_proof_required' });
    expect(ledger.journal()).toHaveLength(journal);
    expect(matching.submitted).toHaveLength(0);
    expect(await db.sql`SELECT id FROM trade.orders`).toHaveLength(0);
    expect(emailProof.lookedUp).toEqual([ALICE]);

    // No cache: the next request reads identity again.
    emailProof.missing.delete(ALICE);
    const placed = await trade.placeOrder(alice, order('ep-1'));
    expect(placed.status).toBe('open');
    expect(ledger.journal().length).toBeGreaterThan(journal);
  });

  it('fails closed when identity cannot answer', async () => {
    const { trade, ledger, matching, emailProof, order } = await setup();
    emailProof.unavailable = true;
    const journal = ledger.journal().length;
    await expect(trade.placeOrder(alice, order('ep-2'))).rejects.toMatchObject({ code: 'trade.identity_unavailable' });
    expect(ledger.journal()).toHaveLength(journal);
    expect(matching.submitted).toHaveLength(0);
  });

  it('never traps a user: cancel works and a retry of a placed order returns it while unproved', async () => {
    const { trade, emailProof, order } = await setup();
    const placed = await trade.placeOrder(alice, order('ep-3'));
    emailProof.missing.add(ALICE);
    const retry = await trade.placeOrder(alice, order('ep-3'));
    expect(retry.id).toBe(placed.id);
    const cancelled = await trade.cancelOrder(alice, placed.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('a refused replacement leaves the original order live', async () => {
    const { trade, emailProof, order } = await setup();
    const placed = await trade.placeOrder(alice, order('ep-4'));
    emailProof.missing.add(ALICE);
    await expect(trade.replaceOrder(alice, placed.id, { ...order('ep-4b'), price: amt('51') })).rejects.toMatchObject({
      code: 'trade.email_proof_required',
    });
    const [row] = await db.sql<Array<{ status: string }>>`SELECT status FROM trade.orders WHERE id = ${placed.id}`;
    expect(row?.status).toBe('open');
  });

  it('refuses a TWAP schedule up front, since every slice is a custodial order', async () => {
    const { trade, emailProof, market } = await setup();
    emailProof.missing.add(ALICE);
    await expect(
      trade.createTwap(alice, {
        marketId: market.id,
        side: 'buy',
        totalQty: amt('1'),
        durationMs: 60_000,
        sliceIntervalMs: 10_000,
        limitPrice: amt('50'),
        clientAlgoId: 'ep-twap',
      }),
    ).rejects.toMatchObject({ code: 'trade.email_proof_required' });
  });

  it('refuses a convert accept before any money moves, and accepts the same quote once proved', async () => {
    const { trade, ledger, matching, emailProof, market } = await setup();
    matching.bids = [['99', '100']];
    matching.asks = [['100', '100']];
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'ep-convert' }));
    const quote = await trade.convertQuote(principalFor(ALICE, ['trade:read']), { symbol: market.symbol, side: 'buy', qty: amt('1') });
    emailProof.missing.add(ALICE);
    const journal = ledger.journal().length;
    await expect(trade.convertExecute(alice, { quoteId: quote.quoteId })).rejects.toMatchObject({ code: 'trade.email_proof_required' });
    expect(ledger.journal()).toHaveLength(journal);
    emailProof.missing.delete(ALICE);
    expect(await trade.convertExecute(alice, { quoteId: quote.quoteId })).toMatchObject({ quoteId: quote.quoteId });
  });

  it('refuses a new futures position before any margin is locked; reduce-only is never asked', async () => {
    await db.sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const SYMBOL = 'BTC/USDT-PERP';
    const now = new Date('2026-08-08T12:00:00.000Z');
    await db.sql`
      INSERT INTO trade.markets (id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at)
      VALUES (${MARKET}, ${SYMBOL}, 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now())
    `;
    const ledger = new MemoryLedger();
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: 'ep:f' }));
    const marks = memoryMarkBook();
    marks.set({ marketId: MARKET, price: '50000', quality: 'mid', asOfMs: now.getTime() });
    const emailProof = new StubEmailProof();
    emailProof.missing.add(ALICE);
    const positions = new PositionService(db.sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(formatAccountRef(recipeProfitFundingAccount('USDT'))),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus: null,
      now: () => now,
      emailProof,
    });
    const journal = ledger.journal().length;
    const open = () =>
      positions.open({ clientOpenId: 'ep-long', userId: ALICE, symbol: SYMBOL, side: 'long', size: amt('1'), leverage: amt('10') });
    await expect(open()).rejects.toMatchObject({ code: 'trade.email_proof_required' });
    expect(ledger.journal()).toHaveLength(journal);
    expect(emailProof.lookedUp).toEqual([ALICE]);
    emailProof.missing.delete(ALICE);
    expect((await open()).status).toBe('open');
  });

  it('a production service with no email-proof source refuses every new live order', async () => {
    const { ledger, matching, order } = await setup();
    const bare = new ProductionTradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      accountAdmission: readyTestAdmission(),
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    const journal = ledger.journal().length;
    await expect(bare.placeOrder(alice, order('ep-5'))).rejects.toMatchObject({ code: 'trade.identity_unavailable' });
    expect(ledger.journal()).toHaveLength(journal);
  });
});
