import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IdentityOperationDecision, IdentityOperationDecisionPort } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { TradingControls } from '../controls/trading-controls.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';
import { TradeService } from '../spot/trade-service.js';
import type { BotVerificationPolicy } from './bots-verification.js';

/** CB-bots-10 spec rows (copy-bots.md) through the real TradeService.createTwap against isolated PostgreSQL. TEST values. */
const user = 'c1111111-1111-4111-8111-111111111111';

describe('CB-bots-10 bot verification through createTwap (isolated PostgreSQL)', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let spotId: string;
  const identity: IdentityOperationDecisionPort = {
    async decide({ mode, intent }): Promise<IdentityOperationDecision> {
      return mode === 'grant'
        ? { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() }
        : { status: 'cancelled', intent, code: 'admission.cancelled', decidedAt: new Date().toISOString() };
    },
  };
  const build = (botVerification?: BotVerificationPolicy) =>
    new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      accountAdmission: new TradingControls(db.sql, { check: async () => 'enabled' }, identity),
      marketLifecycle: READY_MARKET_LIFECYCLE,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      ...(botVerification ? { botVerification } : {}),
    });
  const twap = (clientAlgoId: string) => ({
    marketId: spotId,
    side: 'buy' as const,
    totalQty: amt('2'),
    durationMs: 2000,
    sliceIntervalMs: 1000,
    limitPrice: amt('100'),
    clientAlgoId,
  });
  const parents = async () => (await db.sql`SELECT id FROM trade.algo_parents`).length;
  const previousJobs = process.env.TRADE_ALGO_JOBS_ENABLED;

  beforeAll(async () => {
    process.env.TRADE_ALGO_JOBS_ENABLED = 'true';
    const directory = new URL('../../drizzle/', import.meta.url);
    const migrations = readdirSync(directory)
      .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, directory), 'utf8'));
    db = await createTestDatabase({ service: 'trade', migrations });
  }, 30_000);
  afterAll(async () => {
    if (previousJobs === undefined) delete process.env.TRADE_ALGO_JOBS_ENABLED;
    else process.env.TRADE_ALGO_JOBS_ENABLED = previousJobs;
    await db?.drop();
  }, 30_000);
  beforeEach(async () => {
    await truncateTradeExceptOrderEvents(db.sql);
    ledger = new MemoryLedger();
    matching = new StubMatching();
    matching.bids = [['99', '100']];
    matching.asks = [['100', '100']];
    const market = await build({ mode: 'off' }).listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.01'),
      minQty: amt('0.01'),
      maxQty: amt('100'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    spotId = market.id;
    await ledger.post(recipes.deposit({ userId: user, assetId: 'USDT', amount: amt('10000'), rail: 'test', railRef: randomUUID() }));
  });

  it('a basic-tier user below the owner level is refused bots_verification_insufficient and no parent row is written', async () => {
    const trade = build({ mode: 'required', level: 'full' });
    await expect(trade.createTwap({ ...principalFor(user), tier: 'basic' }, twap('basic'))).rejects.toMatchObject({
      code: 'trade.bots_verification_insufficient',
    });
    expect(await parents()).toBe(0);
    expect(matching.submitted).toHaveLength(0);
  });

  it('a verified user passes once; a retry with the same client id is the same parent', async () => {
    const trade = build({ mode: 'required', level: 'full' });
    const first = await trade.createTwap({ ...principalFor(user), tier: 'full' }, twap('verified'));
    const again = await trade.createTwap({ ...principalFor(user), tier: 'full' }, twap('verified'));
    expect(again.id).toBe(first.id);
    expect(await parents()).toBe(1);
  });

  it('a blank owner level (and an omitted policy, fail closed) refuses every create the same way, with no parent row', async () => {
    for (const trade of [build({ mode: 'required', level: null }), build()]) {
      await expect(trade.createTwap({ ...principalFor(user), tier: 'institutional' }, twap('blank'))).rejects.toMatchObject({
        code: 'trade.bots_verification_level_not_set',
      });
    }
    expect(await parents()).toBe(0);
  });
});
