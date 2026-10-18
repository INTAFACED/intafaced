/**
 * Futures desk reads against Postgres: funding postings, liquidation rungs,
 * ticker aggregates, and the TEST listing row.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount, recipes } from '@intafaced/ledger-client';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { registerFuturesTickerRest } from './futures-ticker-rest.js';
import { encodeRungPlan } from './liquidation-rungs.js';
import {
  encodeFundingCursor,
  listCallerLiquidations,
  listFundingPayments,
  loadListedMarketRows,
  loadMarketBySymbol,
  readFuturesTickerFacts,
} from './futures-reads.js';
interface FuturesTestSeed {
  evaluateSeedRequest(input: { env: Record<string, string | undefined>; fixturePath?: string | null; fixtureText?: string | null }): {
    listing: Parameters<FuturesTestSeed['insertFuturesTestListing']>[1];
  };
  insertFuturesTestListing(
    sql: unknown,
    listing: {
      symbol: string;
      displayName: string;
      baseAsset: string;
      quoteAsset: string;
      leverageCap: string;
      markFeed: string;
      liquidationPolicy: string | Record<string, unknown>;
      tickSize: string;
      lotSize: string;
      minQty: string;
      minNotional: string;
      makerBps: string;
      takerBps: string;
    },
  ): Promise<unknown>;
}

async function loadFuturesTestSeed(): Promise<FuturesTestSeed> {
  // The script is plain JS outside this package root. The cast is the contract this test calls.
  // @ts-expect-error no declaration file for the local seed script
  return import('../../../../tooling/scripts/seed-futures-test-listing.mjs');
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const fixturePath = join(here, '..', '..', 'fixtures/btc-usdt-swap.TEST.json');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-10-17T12:00:00.000Z');
const SECRET = 'a-trade-futures-reads-public-door-edge-secret';

function adminUrl(): string {
  let raw = process.env.TEST_DATABASE_URL?.trim() ?? '';
  if (raw === '') {
    const text = readFileSync('/Users/Nitro/.codex/context/work/runs/test-db.env', 'utf8');
    raw = text.match(/^TEST_DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? '';
  }
  if (raw === '') throw new Error('TEST_DATABASE_URL is not set; this suite does not start Postgres');
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

function principal(userId: string): Principal {
  return {
    sub: userId,
    userId,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(userId: string): Record<string, string> {
  const raw = encodePrincipal(principal(userId));
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

describe('futures reads money', () => {
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
    sql = db.sql;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets,
        trade.position_funding_applied, trade.funding_period_rates, trade.liquidation_rungs,
        trade.futures_mark_samples
      RESTART IDENTITY CASCADE
    `;
  });

  async function market(id: string, symbol: string) {
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${id}, ${symbol}, 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1',
        10, 20, 'active', ${symbol}, now()
      )
    `;
  }

  async function position(
    id: string,
    userId: string,
    size: string,
    status: string,
    reason: string | null = null,
    side: 'long' | 'short' = 'long',
  ) {
    await sql`
      INSERT INTO trade.positions (
        id, user_id, market_id, side, status, margin_mode, size, entry_price,
        leverage, margin_initial, margin_current, margin_asset, closing_reason
      ) VALUES (
        ${id}, ${userId}, ${MARKET}, ${side}, ${status}, 'isolated', ${size}::numeric, '50000'::numeric,
        '2'::numeric, '100'::numeric, '100'::numeric, 'USDT', ${reason}
      )
    `;
  }

  it('lists the TEST swap only when the seed flag is on', async () => {
    const { evaluateSeedRequest, insertFuturesTestListing } = await loadFuturesTestSeed();
    const decision = evaluateSeedRequest({
      env: { TRADE_DATABASE_URL: 'postgres://127.0.0.1/intafaced_test', NODE_ENV: 'test' },
      fixturePath,
      fixtureText: readFileSync(fixturePath, 'utf8'),
    });
    await insertFuturesTestListing(sql, decision.listing);
    const hidden = await loadListedMarketRows(sql, 50, false);
    expect(hidden.filter((row) => row.kind === 'futures')).toEqual([]);
    expect(await loadMarketBySymbol(sql, 'BTC/USDT:USDT', false)).toBeNull();
    const shown = await loadListedMarketRows(sql, 50, true);
    const swap = shown.find((row) => row.kind === 'futures');
    expect(swap?.display_name).toContain('TEST');
    expect(swap?.test).toBe(true);
    expect(swap?.symbol).toBe('BTC/USDT:USDT');
  });

  it('lists two funding postings that sum to the ledger amounts, including after close', async () => {
    await market(MARKET, 'BTC/USDT:USDT');
    const alice = randomUUID();
    const bob = randomUUID();
    const empty = randomUUID();
    await position(alice, ALICE, '1', 'open');
    await position(bob, BOB, '1', 'open');
    await position(empty, ALICE, '1', 'open', null, 'short');
    const paid = parseAmount('1.25');
    const received = parseAmount('0.5');
    const ledger = new MemoryLedger();
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: 'alice-fund' }));
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: 'bob-fund' }));
    await ledger.post(recipes.futuresMarginLock({ positionId: alice, userId: ALICE, assetId: 'USDT', amount: parseAmount('50') }));
    await ledger.post(recipes.futuresMarginLock({ positionId: bob, userId: BOB, assetId: 'USDT', amount: parseAmount('50') }));
    await ledger.post(
      recipes.futuresFundingPay({
        fundingId: 'period-a',
        payerUserId: ALICE,
        payerPositionId: alice,
        payeeUserId: BOB,
        payeePositionId: bob,
        assetId: 'USDT',
        amount: paid,
      }),
    );
    await ledger.post(
      recipes.futuresFundingPay({
        fundingId: 'period-b',
        payerUserId: BOB,
        payerPositionId: bob,
        payeeUserId: ALICE,
        payeePositionId: alice,
        assetId: 'USDT',
        amount: received,
      }),
    );
    const firstAt = new Date('2026-10-01T00:00:00.000Z');
    const secondAt = new Date('2026-10-02T00:00:00.000Z');
    await sql`
      INSERT INTO trade.funding_period_rates (period_id, rate) VALUES
        ('period-a', '0.0001'),
        ('period-b', '-0.0002')
    `;
    await sql`
      INSERT INTO trade.position_funding_applied (position_id, period_id, paid, applied_at) VALUES
        (${alice}, 'period-a', ${formatAmount(paid)}::numeric, ${firstAt}),
        (${alice}, 'period-b', ${formatAmount(-received)}::numeric, ${secondAt}),
        (${bob}, 'period-a', ${formatAmount(-paid)}::numeric, ${firstAt})
    `;

    const app = Fastify();
    registerPrivateRest(app, restDeps());
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/positions/${alice}/funding-payments`,
      headers: signed(ALICE),
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { payments: { time: string; rate: string; amount: string; direction: string }[]; nextCursor: null };
    expect(body.payments).toHaveLength(2);
    expect(body.payments[0]).toMatchObject({ amount: '1.25', direction: 'paid', rate: '0.0001' });
    expect(body.payments[1]).toMatchObject({ amount: '0.5', direction: 'received', rate: '-0.0002' });
    expect(formatAmount(parseAmount(body.payments[0]!.amount) + parseAmount(body.payments[1]!.amount))).toBe('1.75');
    expect(formatAmount(paid + received)).toBe('1.75');
    const stored = await sql<{ paid: string; period_id: string }[]>`
      SELECT paid::text AS paid, period_id FROM trade.position_funding_applied
       WHERE position_id = ${alice} ORDER BY applied_at
    `;
    expect(stored[0]!.paid.startsWith('-')).toBe(false);
    expect(body.payments[0]!.direction).toBe('paid');
    expect(stored[1]!.paid.startsWith('-')).toBe(true);
    expect(body.payments[1]!.direction).toBe('received');

    await sql`UPDATE trade.positions SET status = 'closed', closed_at = now() WHERE id = ${alice}`;
    const closed = await listFundingPayments(sql, ALICE, alice, undefined);
    expect(closed.payments).toHaveLength(2);

    const none = await listFundingPayments(sql, ALICE, empty, undefined);
    expect(none.payments).toEqual([]);
    expect(none).not.toHaveProperty('error');

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/positions/${bob}/funding-payments`,
      headers: signed(ALICE),
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toBe('trade.position_not_found');

    const cursor = encodeFundingCursor(firstAt, 'period-a');
    const tail = await listFundingPayments(sql, ALICE, alice, cursor);
    expect(tail.payments.map((row) => row.amount)).toEqual(['0.5']);
    await app.close();
  });

  it('lists both rungs of a partial liquidation with their recorded fees and no foreign rows', async () => {
    await market(MARKET, 'BTC/USDT:USDT');
    const alice = randomUUID();
    const bob = randomUUID();
    await position(alice, ALICE, '1', 'open');
    await position(bob, BOB, '1', 'open');
    const planJson = (size: string, price: string, fee: string | null) => sql.json(JSON.parse(JSON.stringify(plan(size, price, fee))));
    const plan = (size: string, price: string, fee: string | null) =>
      encodeRungPlan({
        recipes: [],
        sizeClosed: parseAmount(size),
        marginRemaining: parseAmount('1'),
        marginTaken: parseAmount('1'),
        releaseShort: 0n,
        lossShort: 0n,
        reason: 'partial',
        fromInsurance: 0n,
        marginAsset: 'USDT',
        markPrice: parseAmount(price),
        ...(fee == null ? {} : { fee: parseAmount(fee) }),
      });
    const first = randomUUID();
    const second = randomUUID();
    const foreign = randomUUID();
    const bare = randomUUID();
    await sql`
      INSERT INTO trade.liquidation_rungs (
        rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state, created_at
      ) VALUES
        (${first}, ${alice}, 'liq-alice', 'partial', '1', '100', ${planJson('0.2', '49000', '1.5')}, 'applied', ${new Date('2026-10-03T00:00:00.000Z')}),
        (${second}, ${alice}, 'liq-alice', 'partial', '0.8', '80', ${planJson('0.3', '48000', '0.25')}, 'applied', ${new Date('2026-10-03T01:00:00.000Z')}),
        (${foreign}, ${bob}, 'liq-bob', 'partial', '1', '100', ${planJson('1', '47000', '9')}, 'applied', ${new Date('2026-10-03T02:00:00.000Z')}),
        (${bare}, ${alice}, 'liq-bare', 'partial', '1', '100', ${planJson('0.1', '46000', null)}, 'applied', ${new Date('2026-10-03T03:00:00.000Z')})
    `;
    const app = Fastify();
    registerPrivateRest(app, restDeps());
    const response = await app.inject({ method: 'GET', url: '/api/v1/futures/liquidations', headers: signed(ALICE) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      events: {
        liquidationId: string;
        adlRank: null;
        adlRankReason: string;
        rungs: { fee: string | null; feeReason: string | null; price: string | null; priceReason: string | null; size: string }[];
      }[];
    };
    const partial = body.events.find((event) => event.liquidationId === 'liq-alice');
    expect(partial?.rungs.map((rung) => rung.fee)).toEqual(['1.5', '0.25']);
    expect(partial?.rungs.map((rung) => rung.price)).toEqual(['49000', '48000']);
    expect(partial?.rungs.map((rung) => rung.size)).toEqual(['0.2', '0.3']);
    expect(partial?.adlRank).toBeNull();
    expect(partial?.adlRankReason).toBe('adl_rank_not_published');
    expect(JSON.stringify(body)).not.toContain(BOB);
    expect(JSON.stringify(body)).not.toContain(bob);
    expect(body.events.some((event) => event.liquidationId === 'liq-bob')).toBe(false);
    const unrecorded = body.events.find((event) => event.liquidationId === 'liq-bare')?.rungs[0];
    expect(unrecorded?.fee).toBeNull();
    expect(unrecorded?.feeReason).toBe('liquidation_fee_not_recorded');
    expect(unrecorded?.price).toBe('46000');
    const direct = await listCallerLiquidations(sql, BOB);
    expect(direct.events.map((event) => event.liquidationId)).toEqual(['liq-bob']);
    await app.close();
  });

  it('sums open interest and taker volume, and leaves change null until mark history covers 24 hours', async () => {
    await market(MARKET, 'BTC/USDT:USDT');
    const alice = randomUUID();
    const bob = randomUUID();
    const carol = randomUUID();
    const dave = randomUUID();
    await position(alice, ALICE, '1.5', 'open');
    await position(bob, BOB, '2.25', 'open');
    await position(carol, CAROL, '9', 'closing', 'trade.mark_missing');
    await position(dave, '44444444-4444-4444-8444-444444444444', '8', 'closed');
    await fill('0.1', new Date(NOW.getTime() - 60 * 60 * 1000), 'taker');
    await fill('0.2', new Date(NOW.getTime() - 2 * 60 * 60 * 1000), 'taker');
    await fill('9', new Date(NOW.getTime() - 30 * 60 * 1000), 'maker');
    await fill('4', new Date(NOW.getTime() - 25 * 60 * 60 * 1000), 'taker');
    await sql`
      INSERT INTO trade.futures_mark_samples (market_id, price, observed_at, source)
      VALUES (${MARKET}, '110'::numeric, ${new Date(NOW.getTime() - 60 * 60 * 1000)}, 'venue')
    `;
    const app = Fastify();
    registerFuturesTickerRest(app, {
      marketBySymbol: async () => ({ id: MARKET, symbol: 'BTC/USDT:USDT', kind: 'futures' }),
      markForMarket: async () => ({ price: '110', source: 'venue' }),
      fundingForMarket: () => null,
      factsForMarket: (id, nowMs) => readFuturesTickerFacts(sql, id, new Date(nowMs)),
      now: () => NOW.getTime(),
    });
    const young = await app.inject({ method: 'GET', url: '/api/v1/futures/ticker?symbol=BTC%2FUSDT%3AUSDT' });
    expect(young.statusCode).toBe(200);
    const youngBody = young.json();
    expect(youngBody.openInterest).toBe('3.75');
    expect(youngBody.volume24h).toBe('0.3');
    expect(youngBody.change24h).toBeNull();
    expect(youngBody.changeReason).toBe('mark_history_unavailable');
    const wire = JSON.stringify(youngBody);
    for (const id of [ALICE, BOB, CAROL, alice, bob, carol, dave]) expect(wire).not.toContain(id);

    await sql`
      INSERT INTO trade.futures_mark_samples (market_id, price, observed_at, source)
      VALUES (${MARKET}, '100'::numeric, ${new Date(NOW.getTime() - 25 * 60 * 60 * 1000)}, 'venue')
    `;
    const aged = await app.inject({ method: 'GET', url: '/api/v1/futures/ticker?symbol=BTC%2FUSDT%3AUSDT' });
    expect(aged.json().change24h).toBe('10');
    expect(aged.json().changeReason).toBeNull();
    await app.close();
  });

  let fillSeq = 0;

  async function fill(qty: string, ts: Date, liquidity: 'taker' | 'maker') {
    const orderId = randomUUID();
    const counter = randomUUID();
    fillSeq += 1;
    await sql`
      INSERT INTO trade.orders (
        id, user_id, market_id, side, type, qty, status, tif, hold_asset, hold_amount
      ) VALUES (
        ${orderId}, ${ALICE}, ${MARKET}, 'buy', 'market', ${qty}::numeric, 'filled', 'IOC', 'USDT', '1'::numeric
      )
    `;
    await sql`
      INSERT INTO trade.orders (
        id, user_id, market_id, side, type, price, qty, status, tif, hold_asset, hold_amount
      ) VALUES (
        ${counter}, ${BOB}, ${MARKET}, 'sell', 'limit', '100'::numeric, ${qty}::numeric, 'filled', 'GTC', 'BTC', '1'::numeric
      )
    `;
    const quote = formatAmount((parseAmount('100') * parseAmount(qty)) / 10n ** 18n);
    await sql`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence, ts
      ) VALUES (
        ${randomUUID()}, ${orderId}, ${counter}, ${MARKET}, ${ALICE}, 'buy', ${liquidity},
        '100'::numeric, ${qty}::numeric, ${quote}::numeric, 'USDT', '0'::numeric, 0,
        ${fillSeq}, ${ts}
      )
    `;
  }

  function restDeps(): PrivateRestDeps {
    const unused = async () => {
      throw new Error('unused');
    };
    return {
      edgeSecret: SECRET,
      serviceName: 'svc-trade',
      openOrders: async () => [],
      orderHistory: async () => [],
      getOrder: unused as PrivateRestDeps['getOrder'],
      placeOrder: unused as PrivateRestDeps['placeOrder'],
      cancelOrder: unused as PrivateRestDeps['cancelOrder'],
      cancelAllOrders: async () => [],
      massCancelOrders: async () => [],
      myFills: async () => [],
      marketBySymbol: async () => null,
      marketById: async () => null,
      markets: async () => [],
      userBalances: async () => [],
      listPositions: async () => [],
      listClosedPositions: async () => [],
      getPosition: unused as PrivateRestDeps['getPosition'],
      openPosition: unused as PrivateRestDeps['openPosition'],
      closePosition: unused as PrivateRestDeps['closePosition'],
      setLeverage: unused as PrivateRestDeps['setLeverage'],
      addIsolatedMargin: unused as PrivateRestDeps['addIsolatedMargin'],
      reduceIsolatedMargin: unused as PrivateRestDeps['reduceIsolatedMargin'],
      getOpenMarginCall: async () => null,
      getAdlDisclosure: unused as PrivateRestDeps['getAdlDisclosure'],
      ackAdlDisclosure: unused as PrivateRestDeps['ackAdlDisclosure'],
      listAdlDisclosureEvents: async () => [],
      listFundingPayments: (p, id, cursor) => listFundingPayments(sql, p.userId, id, cursor),
      listLiquidations: (p) => listCallerLiquidations(sql, p.userId),
    };
  }
});
