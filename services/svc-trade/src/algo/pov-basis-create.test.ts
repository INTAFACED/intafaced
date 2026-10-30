/**
 * POV on opposite-side liquidity at create (isolated PostgreSQL): an empty opposite side is refused as volume immature
 * before anything is stored, the basis is stored and read back, and a basis on another kind is refused.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IdentityOperationDecision, type IdentityOperationDecisionPort } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, type AccountRef } from '@intafaced/ledger-client';
import { TradingControls } from '../controls/trading-controls.js';
import { type OwnerFeeSchedule } from '../spot/fee-schedule.js';
import { TradeService } from '../spot/trade-service.js';
import {
  PUBLISHED_TEST_FEE_SCHEDULE,
  READY_MARKET_LIFECYCLE,
  StubEmailProof,
  StubMatching,
  StubPerks,
  principalFor,
} from '../spot/testing.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { ALGO_VOLUME_IMMATURE_CODE } from './algo-policy.js';

const ALICE = 'a1111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-08-24T16:00:00.000Z');

class FlakyLedger extends MemoryLedger {
  failBalance = false;
  override async balance(ref: AccountRef) {
    if (this.failBalance) throw new Error('balance unread');
    return super.balance(ref);
  }
}

describe('POV participation basis at create (isolated PostgreSQL)', () => {
  let db: TestDatabase;
  let ledger: FlakyLedger;
  let matching: StubMatching;
  let perks: StubPerks;
  let trade: TradeService;
  let marketId: string;

  function build(options: { feeSchedule?: OwnerFeeSchedule; algoMarkPolicy?: { maxAgeSeconds: number } } = {}) {
    const identityRows = new Map<string, IdentityOperationDecision>();
    const identity: IdentityOperationDecisionPort = {
      async decide({ mode, intent }) {
        const key = intent.operation.userId + ':' + intent.businessId;
        const old = identityRows.get(key);
        if (old) return old;
        const result: IdentityOperationDecision =
          mode === 'grant'
            ? { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() }
            : { status: 'cancelled', intent, code: 'admission.cancelled', decidedAt: new Date().toISOString() };
        identityRows.set(key, result);
        return result;
      },
    };
    const controls = new TradingControls(db.sql, { check: async () => 'enabled' }, identity);
    return new TradeService(db.sql, ledger, matching, perks, new MemoryEventBus('svc-trade'), {
      emailProof: new StubEmailProof(),
      accountAdmission: controls,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      // CB-bots-10: the bot verification gate now fails closed when omitted; this suite tests other gates.
      botVerification: { mode: 'off' },
      feeSchedule: options.feeSchedule === undefined ? PUBLISHED_TEST_FEE_SCHEDULE : options.feeSchedule,
      marketSlippageCapBps: 100,
      algoMarkPolicy: options.algoMarkPolicy,
      now: () => NOW,
    });
  }

  beforeAll(async () => {
    const directory = new URL('../../drizzle/', import.meta.url);
    const migrations = readdirSync(directory)
      .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, directory), 'utf8'));
    db = await createTestDatabase({ service: 'trade', migrations });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    // order_events refuses TRUNCATE. Same reset as the copy SQL suites.
    await truncateTradeExceptOrderEvents(db.sql);
    ledger = new FlakyLedger();
    matching = new StubMatching();
    perks = new StubPerks();
    matching.bids = [['59990', '10']];
    matching.asks = [['60000', '10']];
    trade = build();
    const market = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.001'),
      minQty: amt('0.001'),
      maxQty: amt('10000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    marketId = market.id;
  });

  async function fund(userId: string, assetId: string, amount: string) {
    await ledger.post(recipes.deposit({ userId, assetId, amount: amt(amount), rail: 'test', railRef: randomUUID() }));
  }

  async function available(userId: string, assetId: string) {
    return formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  }

  async function counts() {
    const parents = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.algo_parents`;
    const intents = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operation_intents`;
    return { parents: parents[0]?.n ?? '0', intents: intents[0]?.n ?? '0' };
  }

  function schedule(overrides: Record<string, unknown> = {}) {
    return {
      marketId,
      side: 'buy' as const,
      totalQty: amt('0.01'),
      durationMs: 60_000,
      sliceIntervalMs: 60_000,
      limitPrice: amt('60000'),
      clientAlgoId: randomUUID().slice(0, 12),
      ...overrides,
    };
  }

  it('refuses POV on opposite-side liquidity when the opposite book is empty, and stores nothing', async () => {
    await fund(ALICE, 'USDT', '100000');
    matching.asks = [];
    const before = await counts();
    await expect(
      trade.createTwap(principalFor(ALICE), schedule({ kind: 'pov', participationBps: 1_000, povBasis: 'opposite_liquidity' })),
    ).rejects.toMatchObject({ code: ALGO_VOLUME_IMMATURE_CODE, message: expect.stringContaining('opposite-side book is empty') });
    expect(await counts()).toEqual(before);
    expect(await available(ALICE, 'USDT')).toBe('100000');
  });

  it('a sell reads the bid side: an empty bid side refuses the same way', async () => {
    await fund(ALICE, 'BTC', '1');
    matching.bids = [];
    const before = await counts();
    await expect(
      trade.createTwap(
        principalFor(ALICE),
        schedule({ side: 'sell', limitPrice: amt('59000'), kind: 'pov', participationBps: 1_000, povBasis: 'opposite_liquidity' }),
      ),
    ).rejects.toMatchObject({ code: ALGO_VOLUME_IMMATURE_CODE });
    expect(await counts()).toEqual(before);
  });

  it('starts POV on a resting opposite book with no tape, and stores the basis', async () => {
    await fund(ALICE, 'USDT', '100000');
    matching.asks = [
      ['60000', '0.4'],
      ['60010', '0.6'],
    ];
    const parent = await trade.createTwap(
      principalFor(ALICE),
      schedule({ kind: 'pov', participationBps: 1_000, povBasis: 'opposite_liquidity', clientAlgoId: 'pov-book' }),
    );
    expect(parent.status).toBe('active');
    expect(parent.povBasis).toBe('opposite_liquidity');
    const rows = await db.sql<Array<{ pov_basis: string | null }>>`SELECT pov_basis FROM trade.algo_parents WHERE id = ${parent.id}`;
    expect(rows[0]?.pov_basis).toBe('opposite_liquidity');
    expect(await available(ALICE, 'USDT')).toBe('100000');
  });

  it('a buy limit below every ask has nothing it could reach: refused as immature, and stores nothing', async () => {
    await fund(ALICE, 'USDT', '100000');
    matching.asks = [['60010', '5']];
    const before = await counts();
    await expect(
      trade.createTwap(principalFor(ALICE), schedule({ kind: 'pov', participationBps: 1_000, povBasis: 'opposite_liquidity' })),
    ).rejects.toMatchObject({ code: ALGO_VOLUME_IMMATURE_CODE, message: expect.stringContaining('within the limit') });
    expect(await counts()).toEqual(before);
    expect(await available(ALICE, 'USDT')).toBe('100000');
  });

  it('a traded-volume POV with no tape is still refused as immature', async () => {
    await fund(ALICE, 'USDT', '100000');
    await expect(
      trade.createTwap(principalFor(ALICE), schedule({ kind: 'pov', participationBps: 1_000, povBasis: 'traded_volume' })),
    ).rejects.toMatchObject({ code: ALGO_VOLUME_IMMATURE_CODE });
  });

  it('refuses a participation basis on TWAP and stores nothing', async () => {
    await fund(ALICE, 'USDT', '100000');
    const before = await counts();
    await expect(trade.createTwap(principalFor(ALICE), schedule({ kind: 'twap', povBasis: 'opposite_liquidity' }))).rejects.toMatchObject({
      code: 'trade.algo_invalid_schedule',
    });
    expect(await counts()).toEqual(before);
  });

  it('the table refuses a basis on another kind or an unknown basis', async () => {
    await fund(ALICE, 'USDT', '100000');
    const parent = await trade.createTwap(principalFor(ALICE), schedule({ kind: 'twap', clientAlgoId: 'plain' }));
    await expect(db.sql`UPDATE trade.algo_parents SET pov_basis = 'opposite_liquidity' WHERE id = ${parent.id}`).rejects.toThrow(
      /algo_parents_pov_basis_ck/,
    );
    await expect(
      db.sql`UPDATE trade.algo_parents SET kind = 'pov', participation_bps = 100, pov_basis = 'book' WHERE id = ${parent.id}`,
    ).rejects.toThrow(/algo_parents_pov_basis_ck/);
  });
});
