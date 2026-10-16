import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import {
  MemoryLedger,
  conversionInventory,
  houseFees,
  merchantClearing,
  parseAmount,
  recipes,
  userAvailable,
  venueBoundary,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { VenueUnavailableError, type PlaceOrderRequest, type VenueOrder } from '@intafaced/venue-contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { composeGuards, FRESH } from '../seams/guards.js';
import { createW5HaltsGuards } from '../seams/slots/w5-halts.js';
import { createRegistryReader } from '../registries/read-api.js';
import { createConversionInventory } from './inventory.js';
import {
  ConversionService,
  CONVERSION_ABSENT_FLOOR_MS,
  CONVERSION_VENUE_WINDOW_LEAD_MS,
  CONVERSION_VENUE_WINDOW_TAIL_MS,
  conversionClientOrderId,
  type ConversionServiceDeps,
} from './service.js';
import { ConversionError } from './errors.js';
import { PayHaltStore } from '../halts/store.js';
import { createMemoryConversionVenue, type ConversionVenue, type MemoryFill } from './venue.js';
import {
  CONVERSION_LATE_FILL_HORIZON_MS,
  CONVERSION_LATE_FILL_VENUE_CALLS_PER_TICK,
  HOLD_SWEEP_LOCK_A,
  HOLD_SWEEP_LOCK_B,
  LATE_FILL_SWEEP_LOCK_A,
  LATE_FILL_SWEEP_LOCK_B,
} from './late-fill-schedule.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const RATE = parseAmount('1');
const HUNDRED = parseAmount('100');

function asUser(userId: string): Principal {
  return {
    userId,
    sub: userId,
    sid: randomUUID(),
    scopes: ['pay:read', 'pay:write', 'pay:payout'],
    mfa: true,
    tier: 'full',
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

describe('W6 USD to USDT conversion', () => {
  let db: TestDatabase;
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is unset; conversion tests need the assigned Postgres');

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'pay', url, migrations });
    await db.sql`
      INSERT INTO pay.venue_registry (venue_id, display_name, mode, priority, enabled, min_order, max_order, supported_pairs, updated_by)
      VALUES ('binance-spot', 'Binance testnet', 'testnet', 0, true, '0.01', '1000000', '["USD/USDT"]'::jsonb, 'w6-test')
    `;
    await db.sql`
      INSERT INTO pay.control_pricing_rules (layer, scope_id, asset_code, bands, spread_bps, rounding_beneficiary, version, created_by)
      VALUES ('global', '', 'USD', '[{"fromAmount":"0","feeBps":0,"flatFee":null}]'::jsonb, NULL, 'merchant', 1, 'w6-test')
    `;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  afterEach(async () => {
    await db.sql`UPDATE pay.halts SET halted = false WHERE halted`;
    await db.sql`DELETE FROM pay.conversion_late_fill_books`;
    await db.sql`DELETE FROM pay.conversion_late_fill_acks`;
    await db.sql`DELETE FROM pay.conversion_resolve_proposals`;
    await db.sql`DELETE FROM pay.conversion_audit`;
    await db.sql`DELETE FROM pay.conversion_orders`;
    await db.sql`DELETE FROM pay.conversion_quotes`;
  });

  async function merchant(): Promise<{ userId: string; merchantId: string; settlementId: string; caller: Principal }> {
    const userId = randomUUID();
    const rows = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, status, pricing) VALUES (${userId}, 'active', '{"feeBps":0}'::jsonb) RETURNING id
    `;
    const merchantId = rows[0]!.id;
    const settlements = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
      VALUES (${merchantId}, ${randomUUID()}, 'USD', 100, 0, 100, 'posted') RETURNING id
    `;
    return { userId, merchantId, settlementId: settlements[0]!.id, caller: asUser(userId) };
  }

  async function fund(ledger: LedgerClient, merchantId: string, amount: Amount = HUNDRED): Promise<void> {
    await ledger.post(
      recipes.paymentCapture({
        paymentId: randomUUID(),
        merchantId,
        assetId: 'USD',
        amount,
        rail: 'card-sandbox',
        railRef: randomUUID(),
      }),
    );
  }

  function guards(env: Record<string, string> = {}) {
    return composeGuards(
      createW5HaltsGuards({
        sql: db.sql,
        env,
        conversionInventory: createConversionInventory(db.sql),
      }),
    );
  }

  function service(venue: ConversionVenue, extra: Partial<ConversionServiceDeps> = {}): ConversionService {
    return new ConversionService({
      sql: db.sql,
      ledger: extra.ledger ?? new MemoryLedger(),
      guards: extra.guards ?? guards(),
      venue,
      registries: createRegistryReader(db.sql),
      slippageBps: extra.slippageBps === undefined ? 0 : extra.slippageBps,
      placingMaxAgeMs: extra.placingMaxAgeMs === undefined ? null : extra.placingMaxAgeMs,
      now: extra.now,
      afterPlace: extra.afterPlace,
    });
  }

  function memory(
    fill?: (request: PlaceOrderRequest) => MemoryFill,
    expiresInMs = 60_000,
    commission: Amount = 0n,
    extra: Partial<Parameters<typeof createMemoryConversionVenue>[0]> = {},
  ) {
    return createMemoryConversionVenue({
      bid: RATE,
      ask: RATE,
      commission,
      expiresAt: (now) => new Date(now.getTime() + expiresInMs),
      fill,
      ...extra,
    });
  }

  const full: MemoryFill = { status: 'filled', filled: HUNDRED, averagePrice: RATE };

  it('books one full fill, balances the ledger, and a retry does not place again', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const requestId = randomUUID();
    const booked = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(booked.status).toBe('filled');
    expect(booked.filledFromAmount).toBe('100');
    expect(booked.filledToAmount).toBe('100');
    expect(venue.placeCount()).toBe(1);
    const stored = await db.sql<Array<{ client_order_id: string }>>`
      SELECT client_order_id FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    const clientId = conversionClientOrderId(who.settlementId, 1);
    expect(stored[0]!.client_order_id).toBe(clientId);
    expect(clientId.length).toBeLessThanOrEqual(36);
    expect(venue.lastPlace()).toMatchObject({ type: 'limit', timeInForce: 'IOC', price: RATE, clientOrderId: clientId });
    expect(await svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).toMatchObject({ status: 'filled' });
    expect(venue.placeCount()).toBe(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(0n);
    expect((await ledger.balance(userAvailable(who.userId, 'USDT'))).amount).toBe(HUNDRED);
    expect((await ledger.balance(venueBoundary('binance-spot', 'USD'))).amount).toBe(HUNDRED);
    expect((await ledger.balance(venueBoundary('binance-spot', 'USDT'))).amount).toBe(-HUNDRED);
  });

  it('a crash after the venue accepts does not place a second order on restart', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    let crash = true;
    const svc = service(venue, {
      ledger,
      afterPlace: async () => {
        if (crash) throw new Error('crash between order and db write');
      },
    });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/crash between order and db write/);
    expect(venue.placeCount()).toBe(1);
    const stuck = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE request_id = ${requestId}`;
    expect(stuck[0]!.status).toBe('placing');
    crash = false;
    const booked = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(booked.status).toBe('filled');
    expect(venue.placeCount()).toBe(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses an expired quote and does not call the venue', async () => {
    const who = await merchant();
    const venue = memory(() => full, 1_000);
    let now = new Date('2026-10-16T00:00:00.000Z');
    const svc = service(venue, { now: () => now });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    now = new Date(new Date(quote.expiresAt).getTime() + 1);
    const order = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(order.status).toBe('expired');
    expect(order.failureCode).toBe('pay.conversion_quote_expired');
    expect(venue.placeCount()).toBe(0);
  });

  it('pro-rates the minimum so a half fill at the same price is kept', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => ({ status: 'partially_filled', filled: parseAmount('50'), averagePrice: RATE, feePaid: 0n }));
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const order = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(order.status).toBe('partially_filled');
    expect(order.filledFromAmount).toBe('50');
    expect(order.filledToAmount).toBe('50');
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(parseAmount('50'));
    expect((await ledger.balance(userAvailable(who.userId, 'USDT'))).amount).toBe(parseAmount('50'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('books a fill under the pro-rated minimum to house inventory and leaves the venue legs', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => ({
      status: 'partially_filled',
      filled: parseAmount('50'),
      averagePrice: RATE,
      feePaid: parseAmount('1'),
      feeAsset: 'USDT',
    }));
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const order = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(order.status).toBe('reversed');
    expect(order.failureCode).toBe('pay.conversion_below_minimum');
    expect(venue.placeCount()).toBe(1);
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(HUNDRED);
    expect((await ledger.balance(userAvailable(who.userId, 'USDT'))).amount).toBe(0n);
    expect((await ledger.balance(houseFees('pay', 'USDT'))).amount).toBe(0n);
    expect((await ledger.balance(venueBoundary('binance-spot', 'USD'))).amount).toBe(parseAmount('50'));
    expect((await ledger.balance(venueBoundary('binance-spot', 'USDT'))).amount).toBe(parseAmount('-49'));
    expect((await ledger.balance(conversionInventory('USD'))).amount).toBe(parseAmount('-50'));
    expect((await ledger.balance(conversionInventory('USDT'))).amount).toBe(parseAmount('49'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('books a partial that still meets the minimum and cancels the remainder once', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => ({ status: 'partially_filled', filled: parseAmount('50'), averagePrice: parseAmount('2') }));
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const requestId = randomUUID();
    const order = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(order.status).toBe('partially_filled');
    expect(order.filledFromAmount).toBe('50');
    expect(order.filledToAmount).toBe('100');
    expect(venue.orders.get(conversionClientOrderId(who.settlementId, 1))?.status).toBe('canceled');
    expect(venue.placeCount()).toBe(1);
    await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(venue.placeCount()).toBe(1);
    expect((await ledger.balance(userAvailable(who.userId, 'USDT'))).amount).toBe(HUNDRED);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a halt before the intent commits places nothing', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    await db.sql`
      INSERT INTO pay.halts (scope, target, halted, reason, source, actor_user_id, version)
      VALUES ('conversion', 'global', true, 'drill', 'operator', ${who.userId}::uuid, 1)
      ON CONFLICT (scope, target) DO UPDATE SET halted = true, reason = 'drill', version = pay.halts.version + 1
    `;
    const venue = memory(() => full);
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    await expect(svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId })).rejects.toMatchObject({
      code: 'pay.guard_halted',
    });
    expect(venue.placeCount()).toBe(0);
    expect(await db.sql`SELECT id FROM pay.conversion_orders`).toHaveLength(0);
  });

  it('a halt that lands after the intent is committed does not place, and the intent stays', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const inner = memory(() => full);
    let armed = false;
    const venue: ConversionVenue = {
      venueId: inner.venueId,
      quote: (input) => inner.quote(input),
      placeOrder: (request) => inner.placeOrder(request),
      cancelOrder: (symbol, clientOrderId) => inner.cancelOrder(symbol, clientOrderId),
      fetchClosedOrder: (symbol, clientOrderId) => inner.fetchClosedOrder(symbol, clientOrderId),
      commissionRate: (symbol) => inner.commissionRate(symbol),
      symbolFilters: (symbol) => inner.symbolFilters(symbol),
      fetchOrder: async (symbol, clientOrderId) => {
        if (!armed) {
          armed = true;
          await db.sql`
            INSERT INTO pay.halts (scope, target, halted, reason, source, actor_user_id, version)
            VALUES ('conversion', 'global', true, 'drill', 'operator', ${who.userId}::uuid, 1)
            ON CONFLICT (scope, target) DO UPDATE SET halted = true, reason = 'drill', version = pay.halts.version + 1
          `;
        }
        return inner.fetchOrder(symbol, clientOrderId);
      },
    };
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toMatchObject({ code: 'pay.guard_halted' });
    expect(inner.placeCount()).toBe(0);
    const row = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE request_id = ${requestId}`;
    expect(row[0]!.status).toBe('intent_committed');
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toMatchObject({ code: 'pay.guard_halted' });
    expect(inner.placeCount()).toBe(0);
  });

  it('counts open inventory against the exposure cap and refuses one minor unit over', async () => {
    const who = await merchant();
    const limitGuards = guards({
      PAY_TREASURY_LIMITS: 'required',
      PAY_TREASURY_EXPOSURE_LIMITS: JSON.stringify({ USD: '100' }),
    });
    await expect(
      limitGuards.beforeConversion({
        sql: db.sql,
        tx: db.sql,
        merchantId: who.merchantId,
        settlementId: who.settlementId,
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: HUNDRED,
        replay: FRESH,
      }),
    ).resolves.toBeUndefined();

    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => ({ status: 'open', filled: 0n, averagePrice: null }));
    const svc = service(venue, { ledger, guards: limitGuards });
    const first = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const resting = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: first.quoteId });
    expect(resting.status).toBe('placed');
    expect(venue.placeCount()).toBe(1);

    const extra = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
      VALUES (${who.merchantId}, ${randomUUID()}, 'USD', 1, 0, 1, 'posted') RETURNING id
    `;
    const second = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: extra[0]!.id,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '0.01',
    });
    await expect(svc.execute(who.caller, { requestId: randomUUID(), quoteId: second.quoteId })).rejects.toMatchObject({
      code: 'pay.guard_treasury_exposure_exceeded',
    });
    expect(venue.placeCount()).toBe(1);
  });

  it('does not place when clearing cannot cover the order', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    const venue = memory(() => full);
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const order = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(order.status).toBe('failed');
    expect(order.failureCode).toBe('pay.conversion_unfunded');
    expect(venue.placeCount()).toBe(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('does not place when the venue lookup is not a confirmed miss', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    let places = 0;
    const venue: ConversionVenue = {
      venueId: 'binance-spot',
      quote: async (input) => ({
        rateScaled: RATE,
        targetAmount: input.fromAmount,
        quotedAt: input.now,
        expiresAt: new Date(input.now.getTime() + 60_000),
      }),
      placeOrder: async () => {
        places += 1;
        throw new Error('must not place');
      },
      commissionRate: async () => 0n,
      symbolFilters: async () => ({ tickSize: parseAmount('0.00000001'), stepSize: parseAmount('0.00000001'), minNotional: 0n }),
      fetchOrder: async () => {
        throw new ConversionError('pay.conversion_venue_unknown', 'SERVICE_UNAVAILABLE');
      },
      fetchClosedOrder: async () => {
        throw new Error('must not read history');
      },
      cancelOrder: async () => {
        throw new Error('must not cancel');
      },
    };
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toMatchObject({
      code: 'pay.conversion_venue_unknown',
    });
    expect(places).toBe(0);
    const row = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE request_id = ${requestId}`;
    expect(row[0]!.status).toBe('intent_committed');
  });

  it('a stranger and a missing merchant get the same refusal; a team member can list', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    const svc = service(venue, { ledger });
    const stranger = asUser(randomUUID());
    const missing = randomUUID();
    const body = {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD' as const,
      toAsset: 'USDT' as const,
      fromAmount: '100',
    };
    const foreign = await svc.quote(stranger, body).then(
      () => null,
      (error: unknown) => error,
    );
    const absent = await svc.quote(stranger, { ...body, merchantId: missing }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(foreign).toBeInstanceOf(ConversionError);
    expect(absent).toMatchObject({ code: 'pay.merchant_not_found', trpc: 'NOT_FOUND' });
    expect(foreign).toMatchObject({ code: 'pay.merchant_not_found', trpc: 'NOT_FOUND' });

    const quote = await svc.quote(who.caller, body);
    await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    const memberId = randomUUID();
    await db.sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by)
      VALUES (${who.merchantId}, ${memberId}, 'finance', 'active', ${who.userId})
    `;
    const listed = await svc.list(asUser(memberId), { merchantId: who.merchantId, limit: 10 });
    expect(listed).toHaveLength(1);
    expect((await ledger.balance(userAvailable(memberId, 'USDT'))).amount).toBe(0n);
    expect((await ledger.balance(userAvailable(who.userId, 'USDT'))).amount).toBe(HUNDRED);
    await expect(svc.list(stranger, { merchantId: who.merchantId, limit: 10 })).rejects.toMatchObject({
      code: 'pay.merchant_not_found',
    });
    await expect(svc.get(stranger, listed[0]!.conversionId)).rejects.toMatchObject({ code: 'pay.conversion_not_found' });
  });

  it('refuses to quote when the venue has no credentials', async () => {
    const who = await merchant();
    const venue: ConversionVenue = {
      venueId: 'binance-spot',
      commissionRate: async () => {
        throw new ConversionError('pay.conversion_credentials_unconfigured', 'PRECONDITION_FAILED');
      },
      symbolFilters: async () => {
        throw new ConversionError('pay.conversion_credentials_unconfigured', 'PRECONDITION_FAILED');
      },
      quote: async () => {
        throw new ConversionError('pay.conversion_credentials_unconfigured', 'PRECONDITION_FAILED');
      },
      placeOrder: async () => {
        throw new Error('must not place');
      },
      fetchOrder: async () => null,
      fetchClosedOrder: async () => null,
      cancelOrder: async () => {
        throw new Error('must not cancel');
      },
    };
    const svc = service(venue);
    await expect(
      svc.quote(who.caller, {
        merchantId: who.merchantId,
        settlementId: who.settlementId,
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: '100',
      }),
    ).rejects.toMatchObject({ code: 'pay.conversion_credentials_unconfigured' });
  });

  it('two executes of one request place one order', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    const svc = service(venue, { ledger, placingMaxAgeMs: null });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    let releasePlace: () => void = () => undefined;
    const placeHeld = new Promise<void>((resolve) => {
      releasePlace = resolve;
    });
    let markEntered: () => void = () => undefined;
    const placeEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const innerPlace = venue.placeOrder.bind(venue);
    venue.placeOrder = async (request) => {
      markEntered();
      await placeHeld;
      return innerPlace(request);
    };
    const requestId = randomUUID();
    const winner = svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    await placeEntered;
    const loser = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(loser.status).toBe('placing');
    expect(loser.failureCode).toBeNull();
    expect(venue.placeCount()).toBe(0);
    releasePlace();
    const won = await winner;
    expect(won.status).toBe('filled');
    expect(won.conversionId).toBe(loser.conversionId);
    expect(venue.placeCount()).toBe(1);
    expect(await db.sql`SELECT id FROM pay.conversion_orders WHERE settlement_id = ${who.settlementId}`).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a timed-out place is not sent again while the venue still reports a miss', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    let now = new Date();
    const venue = memory(() => full);
    venue.armLag(4);
    const svc = service(venue, { ledger, now: () => now, placingMaxAgeMs: null });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    expect(venue.placeCount()).toBe(1);
    const waiting = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(waiting.status).toBe('placing');
    expect(waiting.failureCode).toBeNull();
    const claimed = await db.sql<Array<{ placing_at: Date; status: string }>>`
      SELECT placing_at, status FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    expect(claimed[0]!.status).toBe('placing');
    now = new Date(new Date(claimed[0]!.placing_at).getTime() + CONVERSION_ABSENT_FLOOR_MS);
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toMatchObject({
      code: 'pay.conversion_placing_retry_unconfigured',
    });
    expect(venue.placeCount()).toBe(1);
    const row = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE request_id = ${requestId}`;
    expect(row[0]!.status).toBe('placing');
  });

  it('after the configured age a miss is reconciled from history and still not placed again', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    let now = new Date();
    const venue = memory(() => full);
    venue.armLag(2);
    const svc = service(venue, { ledger, now: () => now, placingMaxAgeMs: 60_000 });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    const waiting = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(waiting.status).toBe('placing');
    expect(venue.placeCount()).toBe(1);
    now = new Date(now.getTime() + 120_000);
    const booked = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(booked.status).toBe('filled');
    expect(venue.placeCount()).toBe(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('books an expired order that still has a fill, which realtime does not list', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => ({ status: 'expired', filled: parseAmount('40'), averagePrice: RATE, feePaid: 0n }));
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const order = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(order.status).toBe('partially_filled');
    expect(order.filledFromAmount).toBe('40');
    expect(order.filledToAmount).toBe('40');
    const clientId = conversionClientOrderId(who.settlementId, 1);
    expect(await venue.fetchOrder('USD/USDT', clientId)).toBeNull();
    expect((await venue.fetchClosedOrder('USD/USDT', clientId))?.filled).toBe(parseAmount('40'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('subtracts a known venue commission from the booked USDT', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => ({ status: 'filled', filled: HUNDRED, averagePrice: RATE, feePaid: parseAmount('0.5'), feeAsset: 'USDT' }));
    const svc = service(venue, { ledger, slippageBps: 100 });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    expect(quote.minimumOutput).toBe('99');
    const order = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(order.status).toBe('filled');
    expect(order.filledToAmount).toBe('99.5');
    expect((await ledger.balance(userAvailable(who.userId, 'USDT'))).amount).toBe(parseAmount('99.5'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses to book when the venue does not report a commission', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => ({ status: 'filled', filled: HUNDRED, averagePrice: RATE, feePaid: null }));
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toMatchObject({
      code: 'pay.conversion_commission_unknown',
    });
    expect(venue.placeCount()).toBe(1);
    const row = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE request_id = ${requestId}`;
    expect(row[0]!.status).toBe('placing');
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toMatchObject({
      code: 'pay.conversion_commission_unknown',
    });
    expect(venue.placeCount()).toBe(1);
  });

  it('refuses a quote when slippage is not configured and when the amount exceeds settlement net', async () => {
    const who = await merchant();
    const venue = memory(() => full);
    const unset = service(venue, { slippageBps: null });
    const body = {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD' as const,
      toAsset: 'USDT' as const,
      fromAmount: '100',
    };
    await expect(unset.quote(who.caller, body)).rejects.toMatchObject({ code: 'pay.conversion_slippage_unconfigured' });
    const svc = service(venue);
    await expect(svc.quote(who.caller, { ...body, fromAmount: '100.01' })).rejects.toMatchObject({
      code: 'pay.conversion_exceeds_settlement',
    });
    expect(venue.placeCount()).toBe(0);
  });

  it('refuses a second live conversion on the same settlement', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId, parseAmount('200'));
    const venue = memory(() => ({ status: 'open', filled: 0n, averagePrice: null, feePaid: 0n }));
    const svc = service(venue, { ledger });
    const body = {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD' as const,
      toAsset: 'USDT' as const,
      fromAmount: '100',
    };
    const first = await svc.quote(who.caller, body);
    expect((await svc.execute(who.caller, { requestId: randomUUID(), quoteId: first.quoteId })).status).toBe('placed');
    const second = await svc.quote(who.caller, body);
    await expect(svc.execute(who.caller, { requestId: randomUUID(), quoteId: second.quoteId })).rejects.toMatchObject({
      code: 'pay.conversion_settlement_live',
    });
    expect(venue.placeCount()).toBe(1);
  });

  it('quote requires a write scope; execute requires the payout approver role', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    const svc = service(venue, { ledger });
    const body = {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD' as const,
      toAsset: 'USDT' as const,
      fromAmount: '100',
    };
    const reader = { ...who.caller, scopes: ['pay:read'] } as Principal;
    await expect(svc.quote(reader, body)).rejects.toMatchObject({ code: 'pay.conversion_forbidden' });
    const quote = await svc.quote(who.caller, body);
    const viewerId = randomUUID();
    const financeId = randomUUID();
    await db.sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by)
      VALUES
        (${who.merchantId}, ${viewerId}, 'viewer', 'active', ${who.userId}),
        (${who.merchantId}, ${financeId}, 'finance', 'active', ${who.userId})
    `;
    await expect(svc.execute(asUser(viewerId), { requestId: randomUUID(), quoteId: quote.quoteId })).rejects.toMatchObject({
      code: 'pay.team_role_forbidden',
    });
    expect(venue.placeCount()).toBe(0);
    const booked = await svc.execute(asUser(financeId), { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(booked.status).toBe('filled');
    expect((await ledger.balance(userAvailable(who.userId, 'USDT'))).amount).toBe(HUNDRED);
    expect((await ledger.balance(userAvailable(financeId, 'USDT'))).amount).toBe(0n);
  });

  const bodyOf = (who: { merchantId: string; settlementId: string }, fromAmount: string) => ({
    merchantId: who.merchantId,
    settlementId: who.settlementId,
    fromAsset: 'USD' as const,
    toAsset: 'USDT' as const,
    fromAmount,
  });

  it('raises the limit to the next tick so a fill still clears the floor after a known commission', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(undefined, 60_000, 0n, {
      commissionRate: parseAmount('0.01'),
      filters: { tickSize: parseAmount('0.01'), stepSize: parseAmount('0.00000001'), minNotional: 0n },
    });
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(venue.lastPlace()?.price).toBe(parseAmount('1.02'));
  });

  it('refuses a quote when the venue does not report a commission rate', async () => {
    const who = await merchant();
    const venue = memory(undefined, 60_000, 0n, { commissionRate: null });
    const svc = service(venue, { ledger: new MemoryLedger() });
    await expect(svc.quote(who.caller, bodyOf(who, '100'))).rejects.toMatchObject({
      code: 'pay.conversion_commission_rate_unknown',
    });
  });

  it('returns a pre-send failure to intent_committed and fails a definite rejection', async () => {
    const cases: Array<{ error: Error; status: string; code: string }> = [
      {
        error: new VenueUnavailableError('binance-spot', 'rate_limited', 'local window full (retry in 1000ms)', false),
        status: 'intent_committed',
        code: 'pay.conversion_not_sent',
      },
      {
        error: new VenueUnavailableError('binance-spot', 'malformed', 'limit order requires price', false),
        status: 'intent_committed',
        code: 'pay.conversion_not_sent',
      },
      {
        error: new VenueUnavailableError('binance-spot', 'not_ready', 'HTTP POST port is not wired', false),
        status: 'intent_committed',
        code: 'pay.conversion_not_sent',
      },
      {
        error: new VenueUnavailableError('binance-spot', 'no_depth', 'book is not payout-grade', false),
        status: 'intent_committed',
        code: 'pay.conversion_not_sent',
      },
      {
        error: new VenueUnavailableError('binance-spot', 'unreachable', 'placeOrder code -1121 (Invalid symbol)', false),
        status: 'intent_committed',
        code: 'pay.conversion_not_sent',
      },
      {
        error: new VenueUnavailableError('binance-spot', 'unreachable', 'placeOrder code -2010 (insufficient balance)', true),
        status: 'failed',
        code: 'pay.conversion_venue_rejected',
      },
      {
        error: new VenueUnavailableError('binance-spot', 'unreachable', 'placeOrder code -1013 (Filter failure: MIN_NOTIONAL)', true),
        status: 'failed',
        code: 'pay.conversion_venue_rejected',
      },
      {
        error: new VenueUnavailableError('bybit-spot', 'unreachable', 'placeOrder retCode 170131 (Insufficient balance)', true),
        status: 'failed',
        code: 'pay.conversion_venue_rejected',
      },
      {
        error: new VenueUnavailableError('bybit-spot', 'unreachable', 'placeOrder retCode 170140 (Order value exceeded lower limit)', true),
        status: 'failed',
        code: 'pay.conversion_venue_rejected',
      },
    ];
    for (const item of cases) {
      const who = await merchant();
      const ledger = new MemoryLedger();
      await fund(ledger, who.merchantId);
      const venue = memory(() => full);
      venue.refuseNext(item.error);
      const svc = service(venue, { ledger });
      const quote = await svc.quote(who.caller, bodyOf(who, '100'));
      const requestId = randomUUID();
      if (item.status === 'failed') {
        const order = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
        expect(order.status, item.error.message).toBe('failed');
        expect(order.failureCode).toBe(item.code);
        expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(HUNDRED);
      } else {
        await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toMatchObject({ code: item.code });
        const row = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE request_id = ${requestId}`;
        expect(row[0]!.status, item.error.message).toBe('intent_committed');
        expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(0n);
      }
      expect(venue.placeCount()).toBe(1);
    }
  });

  it('keeps a timed-out place in placing and does not send it again', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    venue.refuseNext(new Error('venue timeout'));
    const svc = service(venue, { ledger, placingMaxAgeMs: null });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    const row = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE request_id = ${requestId}`;
    expect(row[0]!.status).toBe('placing');
    const again = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(again.status).toBe('placing');
    expect(again.failureCode).toBeNull();
    expect(venue.placeCount()).toBe(1);
  });

  it('fails an order the venue grid cannot accept and leaves an unknown symbol unsent', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const tooSmall = memory(undefined, 60_000, 0n, {
      filters: { tickSize: parseAmount('0.01'), stepSize: parseAmount('0.01'), minNotional: parseAmount('1000') },
    });
    const svc = service(tooSmall, { ledger });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    const failed = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(failed.status).toBe('failed');
    expect(failed.failureCode).toBe('pay.conversion_below_min_notional');
    expect(tooSmall.placeCount()).toBe(0);
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(HUNDRED);

    const unknown = memory(undefined, 60_000, 0n, { filters: null });
    const again = service(unknown, { ledger });
    const second = await again.quote(who.caller, bodyOf(who, '10'));
    await expect(again.execute(who.caller, { requestId: randomUUID(), quoteId: second.quoteId })).rejects.toMatchObject({
      code: 'pay.conversion_symbol_unknown',
    });
    expect(unknown.placeCount()).toBe(0);
  });

  it('sends a quantity rounded down to the step and releases the dust', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory((request) => ({ status: 'filled', filled: request.amount, averagePrice: RATE, feePaid: 0n }), 60_000, 0n, {
      filters: { tickSize: parseAmount('0.01'), stepSize: parseAmount('30'), minNotional: 0n },
    });
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    const order = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(venue.lastPlace()?.amount).toBe(parseAmount('90'));
    expect(order.status).toBe('filled');
    expect(order.filledFromAmount).toBe('90');
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(parseAmount('10'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('treats a ledger timeout that already posted as the same hold', async () => {
    const who = await merchant();
    const inner = new MemoryLedger();
    await fund(inner, who.merchantId);
    let thrown = false;
    const ledger: LedgerClient = {
      async post(request) {
        const tx = await inner.post(request);
        if (!thrown && request.idempotencyKey.startsWith('pay.conversion.hold:')) {
          thrown = true;
          throw new Error('ledger timeout');
        }
        return tx;
      },
      balance: (ref) => inner.balance(ref),
      balances: (ownerType, ownerId) => inner.balances(ownerType, ownerId),
      getTx: (txId) => inner.getTx(txId),
      getTxByKey: (key) => inner.getTxByKey(key),
    };
    const venue = memory(() => full);
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    const order = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(order.status).toBe('filled');
    expect(thrown).toBe(true);
    const stored = await db.sql<Array<{ id: string }>>`
      SELECT id FROM pay.conversion_orders WHERE filled_from_amount > 0 ORDER BY created_at DESC LIMIT 1
    `;
    expect(await inner.getTxByKey(`pay.conversion.hold:${stored[0]!.id}`)).toMatchObject({ reason: 'pay.conversion.held' });
    expect(inner.reconcile()).toEqual({ ok: true });
  });

  it('leaves the row unplaced when the hold timeout did not post, then a retry places once', async () => {
    const who = await merchant();
    const inner = new MemoryLedger();
    await fund(inner, who.merchantId);
    let failNext = true;
    const ledger: LedgerClient = {
      async post(request) {
        if (failNext && request.idempotencyKey.startsWith('pay.conversion.hold:')) {
          failNext = false;
          throw new Error('ledger timeout');
        }
        return inner.post(request);
      },
      balance: (ref) => inner.balance(ref),
      balances: (ownerType, ownerId) => inner.balances(ownerType, ownerId),
      getTx: (txId) => inner.getTx(txId),
      getTxByKey: (key) => inner.getTxByKey(key),
    };
    const venue = memory(() => full);
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/ledger timeout/);
    const waiting = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE request_id = ${requestId}`;
    expect(waiting[0]!.status).toBe('intent_committed');
    expect(venue.placeCount()).toBe(0);
    const booked = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(booked.status).toBe('filled');
    expect(venue.placeCount()).toBe(1);
  });

  it('sweeps holds whose rows are failed or absent and leaves a placing hold', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId, parseAmount('200'));
    const venue = memory(() => full);
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, bodyOf(who, '40'));
    venue.refuseNext(new Error('venue timeout'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    await db.sql`UPDATE pay.conversion_orders SET status = 'failed', failure_code = 'pay.conversion_venue_rejected' WHERE request_id = ${requestId}`;
    const orphan = randomUUID();
    await ledger.post(
      recipes.fxConversionHold({ conversionId: orphan, merchantId: who.merchantId, fromAsset: 'USD', amount: parseAmount('15') }),
    );
    const live = await svc.quote(who.caller, bodyOf(who, '10'));
    venue.refuseNext(new Error('venue timeout'));
    await expect(svc.execute(who.caller, { requestId: randomUUID(), quoteId: live.quoteId })).rejects.toThrow(/venue timeout/);
    const sweeper = randomUUID();
    expect(await svc.sweepOrphanHolds(sweeper)).toEqual({ released: 2, failures: [], busy: false });
    expect(await svc.sweepOrphanHolds(sweeper)).toEqual({ released: 0, failures: [], busy: false });
    const actors = await db.sql<Array<{ actor_id: string }>>`
      SELECT actor_id FROM pay.conversion_audit WHERE action = 'hold_swept'
    `;
    expect(actors.every((entry) => entry.actor_id === sweeper)).toBe(true);
    const holds = await ledger.balances('module', `pay:clearing:${who.merchantId}`);
    const open = holds.filter((row) => row.account.kind === 'hold' && row.amount > 0n);
    expect(open).toHaveLength(1);
    expect(open[0]!.amount).toBe(parseAmount('10'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('books or releases a placing row from venue evidence under two founders', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    venue.armLag(0);
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    const row = await db.sql<Array<{ id: string; status: string }>>`
      SELECT id, status FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    expect(row[0]!.status).toBe('placing');
    const founderA = randomUUID();
    const founderB = randomUUID();
    const proposed = await svc.proposeResolve(founderA, { requestId: randomUUID(), conversionId: row[0]!.id, reason: 'venue evidence' });
    expect(proposed.status).toBe('pending');
    expect(proposed.changeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const same = await svc.confirmResolve(founderA, {
      requestId: proposed.requestId,
      decision: 'confirm',
      reason: 'same person',
      expectedChangeHash: proposed.changeHash!,
    });
    expect(same.status).toBe('same_founder');
    const wrong = await svc.confirmResolve(founderB, {
      requestId: proposed.requestId,
      decision: 'confirm',
      reason: 'wrong hash',
      expectedChangeHash: `sha256:${'b'.repeat(64)}`,
    });
    expect(wrong.status).toBe('hash_mismatch');
    const confirmed = await svc.confirmResolve(founderB, {
      requestId: proposed.requestId,
      decision: 'confirm',
      reason: 'second founder',
      expectedChangeHash: proposed.changeHash!,
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.order?.status).toBe('filled');
    expect(venue.placeCount()).toBe(1);
    const audit = await db.sql<Array<{ action: string; approver_id: string | null }>>`
      SELECT action, approver_id FROM pay.conversion_audit WHERE conversion_id = ${row[0]!.id}
    `;
    expect(audit.map((entry) => entry.action).sort()).toEqual(['resolve_confirmed', 'resolve_proposed']);
    expect(audit.find((entry) => entry.action === 'resolve_confirmed')!.approver_id).toBe(founderB);
    expect(ledger.reconcile()).toEqual({ ok: true });

    const absentWho = await merchant();
    const absentLedger = new MemoryLedger();
    await fund(absentLedger, absentWho.merchantId);
    const absentVenue = memory(() => full);
    const absent = service(absentVenue, { ledger: absentLedger });
    const absentQuote = await absent.quote(absentWho.caller, bodyOf(absentWho, '100'));
    absentVenue.refuseNext(new Error('socket hang up'));
    const absentRequest = randomUUID();
    await expect(absent.execute(absentWho.caller, { requestId: absentRequest, quoteId: absentQuote.quoteId })).rejects.toThrow(
      /socket hang up/,
    );
    const stuck = await db.sql<Array<{ id: string }>>`SELECT id FROM pay.conversion_orders WHERE request_id = ${absentRequest}`;
    const proposal = await absent.proposeResolve(founderA, { requestId: randomUUID(), conversionId: stuck[0]!.id, reason: 'no order' });
    await expect(
      absent.confirmResolve(founderB, {
        requestId: proposal.requestId,
        decision: 'confirm',
        reason: 'second founder',
        expectedChangeHash: proposal.changeHash!,
      }),
    ).rejects.toMatchObject({ code: 'pay.conversion_resolve_absent_unproven' });
    const still = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE id = ${stuck[0]!.id}`;
    expect(still[0]!.status).toBe('placing');
    expect((await absentLedger.balance(merchantClearing(absentWho.merchantId, 'USD'))).amount).toBe(0n);
  });

  it('refuses a new conversion while fx inventory is short and counts that short as exposure', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => ({
      status: 'partially_filled',
      filled: parseAmount('50'),
      averagePrice: RATE,
      feePaid: parseAmount('1'),
      feeAsset: 'USDT',
    }));
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    const reversed = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(reversed.status).toBe('reversed');
    expect((await ledger.balance(conversionInventory('USD'))).amount).toBe(parseAmount('-50'));
    await expect(svc.quote(who.caller, bodyOf(who, '1'))).rejects.toMatchObject({ code: 'pay.conversion_inventory_short' });
    const inventory = createConversionInventory(db.sql, ledger);
    expect(await inventory.openInventory(db.sql, 'USD')).toBe(parseAmount('50'));
    const capped = composeGuards(
      createW5HaltsGuards({
        sql: db.sql,
        env: { PAY_TREASURY_LIMITS: 'required', PAY_TREASURY_EXPOSURE_LIMITS: JSON.stringify({ USD: '60' }) },
        conversionInventory: inventory,
      }),
    );
    await expect(
      capped.beforeConversion!({
        sql: db.sql,
        tx: db.sql,
        merchantId: who.merchantId,
        settlementId: who.settlementId,
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: parseAmount('10'),
        replay: FRESH,
      }),
    ).resolves.toBeUndefined();
    await expect(
      capped.beforeConversion!({
        sql: db.sql,
        tx: db.sql,
        merchantId: who.merchantId,
        settlementId: who.settlementId,
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: parseAmount('10') + 1n,
        replay: FRESH,
      }),
    ).rejects.toMatchObject({ code: 'pay.guard_treasury_exposure_exceeded' });
  });

  it('refuses a repeat conversion whose filled amount plus the new amount exceeds the settlement', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory((request) => ({ status: 'filled', filled: request.amount, averagePrice: RATE, feePaid: 0n }));
    const svc = service(venue, { ledger });
    const first = await svc.quote(who.caller, bodyOf(who, '60'));
    const booked = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: first.quoteId });
    expect(booked.status).toBe('filled');
    const over = await svc.quote(who.caller, bodyOf(who, '50'));
    await expect(svc.execute(who.caller, { requestId: randomUUID(), quoteId: over.quoteId })).rejects.toMatchObject({
      code: 'pay.conversion_exceeds_settlement',
    });
    const rest = await svc.quote(who.caller, bodyOf(who, '40'));
    const second = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: rest.quoteId });
    expect(second.status).toBe('filled');
    expect(second.filledFromAmount).toBe('40');
    expect(venue.placeCount()).toBe(2);
  });

  it('keeps an untagged place error in placing', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    venue.refuseNext(new VenueUnavailableError('binance-spot', 'rate_limited', 'local window full (retry in 1000ms)'));
    const svc = service(venue, { ledger, placingMaxAgeMs: 60_000 });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toMatchObject({ reason: 'rate_limited' });
    const row = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE request_id = ${requestId}`;
    expect(row[0]!.status).toBe('placing');
    expect(venue.placeCount()).toBe(1);
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(0n);
  });

  it('stamps a reconcile code without moving updated_at, so the proposal hash still matches', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    let nowMs = Date.now();
    const svc = service(venue, { ledger, placingMaxAgeMs: 60_000, now: () => new Date(nowMs) });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    venue.refuseNext(new Error('venue timeout'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    const before = await db.sql<Array<{ id: string; updated_at: Date; placing_at: Date }>>`
      SELECT id, updated_at, placing_at FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    const claim = new Date(before[0]!.placing_at).getTime();
    nowMs = claim + CONVERSION_ABSENT_FLOOR_MS;
    const waiting = await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    expect(waiting.status).toBe('placing');
    expect(waiting.failureCode).toBe('pay.conversion_reconcile');
    const mid = await db.sql<Array<{ updated_at: Date; failure_code: string }>>`
      SELECT updated_at, failure_code FROM pay.conversion_orders WHERE id = ${before[0]!.id}
    `;
    expect(mid[0]!.failure_code).toBe('pay.conversion_reconcile');
    expect(new Date(mid[0]!.updated_at).toISOString()).toBe(new Date(before[0]!.updated_at).toISOString());
    await svc.execute(who.caller, { requestId, quoteId: quote.quoteId });
    const after = await db.sql<Array<{ updated_at: Date }>>`
      SELECT updated_at FROM pay.conversion_orders WHERE id = ${before[0]!.id}
    `;
    expect(new Date(after[0]!.updated_at).toISOString()).toBe(new Date(before[0]!.updated_at).toISOString());
    const founderA = randomUUID();
    const founderB = randomUUID();
    const proposal = await svc.proposeResolve(founderA, { requestId: randomUUID(), conversionId: before[0]!.id, reason: 'aged miss' });
    await expect(
      svc.confirmResolve(founderB, {
        requestId: proposal.requestId,
        decision: 'confirm',
        reason: 'too soon',
        expectedChangeHash: proposal.changeHash!,
      }),
    ).rejects.toMatchObject({ code: 'pay.conversion_resolve_absent_unproven' });
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(0n);
    // The pre-claim lookup has no placing_at yet, so it is anchored on created_at.
    // Reconcile and confirm are the ones that must sit on placing_at, not on now.
    const onClaim = venue
      .closedWindows()
      .filter((window) => Math.abs((window?.startTimeMs ?? 0) - (claim - CONVERSION_VENUE_WINDOW_LEAD_MS)) <= 5);
    expect(onClaim.length).toBeGreaterThan(0);
    for (const window of venue.closedWindows()) {
      expect(window?.orderId ?? null).toBeNull();
      expect(window!.endTimeMs - window!.startTimeMs).toBe(CONVERSION_VENUE_WINDOW_LEAD_MS + CONVERSION_VENUE_WINDOW_TAIL_MS);
      expect(window!.endTimeMs).toBeLessThan(nowMs);
    }
  });

  it('releases an absent resolve only after the age floor and a second miss', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    let nowMs = Date.now();
    const svc = service(venue, { ledger, placingMaxAgeMs: 60_000, now: () => new Date(nowMs) });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    venue.refuseNext(new Error('venue timeout'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    const claimed = await db.sql<Array<{ id: string; placing_at: Date }>>`
      SELECT id, placing_at FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    const claim = new Date(claimed[0]!.placing_at).getTime();
    nowMs = claim + 15 * 60 * 1000;
    const founderA = randomUUID();
    const founderB = randomUUID();
    const proposal = await svc.proposeResolve(founderA, { requestId: randomUUID(), conversionId: claimed[0]!.id, reason: 'no order' });
    await expect(
      svc.confirmResolve(founderB, {
        requestId: proposal.requestId,
        decision: 'confirm',
        reason: 'gap too short',
        expectedChangeHash: proposal.changeHash!,
      }),
    ).rejects.toMatchObject({ code: 'pay.conversion_resolve_absent_unproven' });
    const still = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE id = ${claimed[0]!.id}`;
    expect(still[0]!.status).toBe('placing');
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(0n);

    nowMs = claim + 20 * 60 * 1000 + 1000;
    const released = await svc.confirmResolve(founderB, {
      requestId: proposal.requestId,
      decision: 'confirm',
      reason: 'second miss',
      expectedChangeHash: proposal.changeHash!,
    });
    expect(released.status).toBe('confirmed');
    expect(released.order?.status).toBe('failed');
    expect(released.order?.failureCode).toBe('pay.conversion_resolve_absent');
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(HUNDRED);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('does not release when the row moves between the hash check and the write', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    let nowMs = Date.now();
    let closedLooks = 0;
    let requestId = '';
    const innerClosed = venue.fetchClosedOrder.bind(venue);
    venue.fetchClosedOrder = async (symbol, clientOrderId, window) => {
      closedLooks += 1;
      if (closedLooks === 3) {
        await db.sql`
          UPDATE pay.conversion_orders
             SET updated_at = updated_at + interval '1 second'
           WHERE request_id = ${requestId}
        `;
      }
      return innerClosed(symbol, clientOrderId, window);
    };
    const svc = service(venue, { ledger, placingMaxAgeMs: 60_000, now: () => new Date(nowMs) });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    venue.refuseNext(new Error('venue timeout'));
    requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    const claimed = await db.sql<Array<{ id: string; placing_at: Date }>>`
      SELECT id, placing_at FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    const claim = new Date(claimed[0]!.placing_at).getTime();
    nowMs = claim + 15 * 60 * 1000;
    const founderA = randomUUID();
    const founderB = randomUUID();
    const proposal = await svc.proposeResolve(founderA, { requestId: randomUUID(), conversionId: claimed[0]!.id, reason: 'no order' });
    nowMs = claim + 21 * 60 * 1000;
    const outcome = await svc.confirmResolve(founderB, {
      requestId: proposal.requestId,
      decision: 'confirm',
      reason: 'stale row',
      expectedChangeHash: proposal.changeHash!,
    });
    expect(outcome.status).toBe('not_placing');
    const still = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.conversion_orders WHERE id = ${claimed[0]!.id}`;
    expect(still[0]!.status).toBe('placing');
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(0n);
  });

  it('refuses an absent confirm when propose saw the order', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    let nowMs = Date.now();
    let liveLooks = 0;
    const seen: VenueOrder = {
      venueId: 'binance-spot',
      venueOrderId: 'mem-seen',
      clientOrderId: 'seen',
      symbol: 'USD/USDT',
      side: 'sell',
      type: 'limit',
      price: RATE,
      amount: HUNDRED,
      filled: 0n,
      remaining: HUNDRED,
      averagePrice: null,
      status: 'open',
      feePaid: 0n,
      feeAsset: null,
      createdAt: new Date(),
      observedAt: new Date(),
    };
    venue.fetchOrder = async () => {
      liveLooks += 1;
      return liveLooks === 2 ? seen : null;
    };
    const svc = service(venue, { ledger, placingMaxAgeMs: 60_000, now: () => new Date(nowMs) });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    venue.refuseNext(new Error('venue timeout'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    const claimed = await db.sql<Array<{ id: string; placing_at: Date }>>`
      SELECT id, placing_at FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    nowMs = new Date(claimed[0]!.placing_at).getTime() + 20 * 60 * 1000;
    const founderA = randomUUID();
    const founderB = randomUUID();
    const proposal = await svc.proposeResolve(founderA, { requestId: randomUUID(), conversionId: claimed[0]!.id, reason: 'saw it' });
    await expect(
      svc.confirmResolve(founderB, {
        requestId: proposal.requestId,
        decision: 'confirm',
        reason: 'gone now',
        expectedChangeHash: proposal.changeHash!,
      }),
    ).rejects.toMatchObject({ code: 'pay.conversion_resolve_absent_unproven' });
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(0n);
  });

  it('blocks quotes on an unacknowledged late fill, and clearing another halt does not lift it', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    let nowMs = Date.now();
    let planted: VenueOrder | null = null;
    let claimMs = 0;
    const innerOrder = venue.fetchOrder.bind(venue);
    const innerClosed = venue.fetchClosedOrder.bind(venue);
    venue.fetchOrder = async (symbol, clientOrderId) => (planted ? null : innerOrder(symbol, clientOrderId));
    venue.fetchClosedOrder = async (symbol, clientOrderId, window) => {
      const recorded = await innerClosed(symbol, clientOrderId, window);
      if (!planted) return recorded;
      const matches =
        window?.startTimeMs === claimMs - CONVERSION_VENUE_WINDOW_LEAD_MS && window.endTimeMs === claimMs + CONVERSION_VENUE_WINDOW_TAIL_MS;
      return matches ? planted : null;
    };
    const svc = service(venue, { ledger, placingMaxAgeMs: 60_000, now: () => new Date(nowMs) });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    venue.refuseNext(new Error('venue timeout'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    const claimed = await db.sql<Array<{ id: string; placing_at: Date; client_order_id: string }>>`
      SELECT id, placing_at, client_order_id FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    claimMs = new Date(claimed[0]!.placing_at).getTime();
    nowMs = claimMs + 20 * 60 * 1000;
    const founderA = randomUUID();
    const founderB = randomUUID();
    const proposal = await svc.proposeResolve(founderA, { requestId: randomUUID(), conversionId: claimed[0]!.id, reason: 'no order' });
    nowMs = claimMs + 26 * 60 * 1000;
    const released = await svc.confirmResolve(founderB, {
      requestId: proposal.requestId,
      decision: 'confirm',
      reason: 'second miss',
      expectedChangeHash: proposal.changeHash!,
    });
    expect(released.order?.failureCode).toBe('pay.conversion_resolve_absent');
    planted = {
      venueId: 'binance-spot',
      venueOrderId: 'late-1',
      clientOrderId: claimed[0]!.client_order_id,
      symbol: 'USD/USDT',
      side: 'sell',
      type: 'limit',
      price: RATE,
      amount: HUNDRED,
      filled: HUNDRED,
      remaining: 0n,
      averagePrice: RATE,
      status: 'filled',
      feePaid: 0n,
      feeAsset: null,
      createdAt: new Date(claimMs),
      observedAt: new Date(nowMs),
    };
    const beforeSweep = await svc.quote(who.caller, bodyOf(who, '1'));
    expect(beforeSweep.quoteId).toEqual(expect.any(String));
    const store = new PayHaltStore(db.sql, { failures: null, railFailures: null });
    const beforeHalt = (await store.operatorStatus()).states.find(
      (state) => state.scope === 'conversion' && state.target.level === 'global',
    )!;
    expect(
      (
        await store.set(founderA, {
          requestId: randomUUID(),
          scope: 'conversion',
          target: { level: 'global' },
          halted: true,
          reason: 'maintenance',
          expectedVersion: beforeHalt.version,
        })
      ).outcome,
    ).toBe('changed');
    expect(await svc.sweepLateFills('late-fill-sweep')).toMatchObject({ checked: 1, found: 1, errors: [] });
    const stillMaintenance = await db.sql<Array<{ halted: boolean; reason: string }>>`
      SELECT halted, reason FROM pay.halts WHERE scope = 'conversion' AND target = 'global'
    `;
    expect(stillMaintenance[0]).toMatchObject({ halted: true, reason: 'maintenance' });
    const audit = await db.sql<Array<{ id: string }>>`
      SELECT id FROM pay.conversion_audit WHERE conversion_id = ${claimed[0]!.id} AND action = 'pay.conversion_late_fill'
    `;
    expect(audit).toHaveLength(1);
    await expect(svc.quote(who.caller, bodyOf(who, '1'))).rejects.toMatchObject({ code: 'pay.conversion_late_fill_halt' });
    await expect(svc.execute(who.caller, { requestId: randomUUID(), quoteId: randomUUID() })).rejects.toMatchObject({
      code: 'pay.conversion_late_fill_halt',
    });
    const version = (await store.operatorStatus()).states.find(
      (state) => state.scope === 'conversion' && state.target.level === 'global',
    )!.version;
    const clear = {
      requestId: randomUUID(),
      scope: 'conversion' as const,
      target: { level: 'global' as const },
      halted: false,
      reason: 'maintenance over',
      expectedVersion: version,
    };
    expect((await store.set(founderA, clear)).outcome).toBe('pending_confirmation');
    expect((await store.set(founderB, clear)).outcome).toBe('changed');
    await expect(svc.quote(who.caller, bodyOf(who, '1'))).rejects.toMatchObject({ code: 'pay.conversion_late_fill_halt' });
    const settlement = 'customer made whole outside the book';
    const ack = await svc.proposeLateFillAck(founderA, {
      requestId: randomUUID(),
      auditId: audit[0]!.id,
      settlement,
      reason: 'fill arrived after the release',
    });
    expect(ack.status).toBe('pending');
    await expect(
      svc.confirmLateFillAck(founderA, {
        requestId: ack.requestId,
        decision: 'confirm',
        reason: 'same person',
        expectedChangeHash: ack.changeHash!,
      }),
    ).resolves.toMatchObject({ status: 'same_founder' });
    await expect(
      svc.confirmLateFillAck(founderB, {
        requestId: ack.requestId,
        decision: 'confirm',
        reason: 'wrong hash',
        expectedChangeHash: `sha256:${'ab'.repeat(32)}`,
      }),
    ).resolves.toMatchObject({ status: 'hash_mismatch' });
    expect(
      (
        await svc.confirmLateFillAck(founderB, {
          requestId: ack.requestId,
          decision: 'reject',
          reason: 'not yet',
          expectedChangeHash: ack.changeHash!,
        })
      ).status,
    ).toBe('rejected');
    await expect(svc.quote(who.caller, bodyOf(who, '1'))).rejects.toMatchObject({ code: 'pay.conversion_late_fill_halt' });
    const again = await svc.proposeLateFillAck(founderA, {
      requestId: randomUUID(),
      auditId: audit[0]!.id,
      settlement,
      reason: 'fill arrived after the release',
    });
    const confirmed = await svc.confirmLateFillAck(founderB, {
      requestId: again.requestId,
      decision: 'confirm',
      reason: 'second founder',
      expectedChangeHash: again.changeHash!,
    });
    expect(confirmed).toMatchObject({ status: 'confirmed', settlement });
    const recorded = await db.sql<Array<{ settlement: string; status: string }>>`
      SELECT settlement, status FROM pay.conversion_late_fill_acks WHERE request_id = ${again.requestId}
    `;
    expect(recorded[0]).toEqual({ settlement, status: 'confirmed' });
    const noted = await db.sql<Array<{ detail: { settlement?: string } }>>`
      SELECT detail FROM pay.conversion_audit
       WHERE conversion_id = ${claimed[0]!.id} AND action = 'pay.conversion_late_fill_acknowledged'
    `;
    expect(noted[0]?.detail.settlement).toBe(settlement);
    expect((await ledger.balance(userAvailable(who.userId, 'USDT'))).amount).toBe(0n);
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(HUNDRED);
    const resumed = await svc.quote(who.caller, bodyOf(who, '100'));
    const placed = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: resumed.quoteId });
    expect(placed.status).toBe('filled');
    expect((await ledger.balance(userAvailable(who.userId, 'USDT'))).amount).toBe(HUNDRED);
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(0n);
    const sweepWindows = venue
      .closedWindows()
      .filter((window) => Math.abs((window?.startTimeMs ?? 0) - (claimMs - CONVERSION_VENUE_WINDOW_LEAD_MS)) <= 5);
    expect(sweepWindows.length).toBeGreaterThan(0);
    expect(
      sweepWindows.every(
        (window) => window!.endTimeMs - window!.startTimeMs === CONVERSION_VENUE_WINDOW_LEAD_MS + CONVERSION_VENUE_WINDOW_TAIL_MS,
      ),
    ).toBe(true);
  });

  it('a venue error during late-fill detection does not block quotes and retries next tick', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    let nowMs = Date.now();
    let failLookup = false;
    let planted: VenueOrder | null = null;
    const seen: Array<{ startTimeMs: number; endTimeMs: number; orderId?: string | null }> = [];
    const innerClosed = venue.fetchClosedOrder.bind(venue);
    venue.fetchClosedOrder = async (symbol, clientOrderId, window) => {
      if (window) seen.push(window);
      if (failLookup) throw Object.assign(new Error('rate limited'), { code: 'rate_limited' });
      if (planted) return planted;
      return innerClosed(symbol, clientOrderId, window);
    };
    const svc = service(venue, { ledger, placingMaxAgeMs: 60_000, now: () => new Date(nowMs) });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    venue.refuseNext(new Error('venue timeout'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    const claimed = await db.sql<Array<{ id: string; placing_at: Date; client_order_id: string }>>`
      SELECT id, placing_at, client_order_id FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    const claim = new Date(claimed[0]!.placing_at).getTime();
    nowMs = claim + 20 * 60 * 1000;
    const founderA = randomUUID();
    const founderB = randomUUID();
    const proposal = await svc.proposeResolve(founderA, { requestId: randomUUID(), conversionId: claimed[0]!.id, reason: 'no order' });
    nowMs = claim + 26 * 60 * 1000;
    const released = await svc.confirmResolve(founderB, {
      requestId: proposal.requestId,
      decision: 'confirm',
      reason: 'second miss',
      expectedChangeHash: proposal.changeHash!,
    });
    expect(released.order?.failureCode).toBe('pay.conversion_resolve_absent');
    failLookup = true;
    const failed = await svc.sweepLateFills('late-fill-sweep');
    expect(failed).toMatchObject({ checked: 0, found: 0, errors: [{ conversionId: claimed[0]!.id, code: 'rate_limited' }] });
    const unstamped = await db.sql<Array<{ last_checked_at: Date | null }>>`
      SELECT last_checked_at FROM pay.conversion_orders WHERE id = ${claimed[0]!.id}
    `;
    expect(unstamped[0]!.last_checked_at).toBeNull();
    const stillOpen = await svc.quote(who.caller, bodyOf(who, '1'));
    expect(stillOpen.quoteId).toEqual(expect.any(String));
    failLookup = false;
    const missed = await svc.sweepLateFills('late-fill-sweep');
    expect(missed).toMatchObject({ checked: 1, found: 0, errors: [] });
    const stamped = await db.sql<Array<{ last_checked_at: Date | null }>>`
      SELECT last_checked_at FROM pay.conversion_orders WHERE id = ${claimed[0]!.id}
    `;
    expect(stamped[0]!.last_checked_at).not.toBeNull();
    expect(await svc.sweepLateFills('late-fill-sweep')).toMatchObject({ checked: 0, found: 0, errors: [] });
    planted = {
      venueId: 'binance-spot',
      venueOrderId: 'late-2',
      clientOrderId: claimed[0]!.client_order_id,
      symbol: 'USD/USDT',
      side: 'sell',
      type: 'limit',
      price: RATE,
      amount: HUNDRED,
      filled: HUNDRED,
      remaining: 0n,
      averagePrice: RATE,
      status: 'filled',
      feePaid: 0n,
      feeAsset: null,
      createdAt: new Date(claim),
      observedAt: new Date(nowMs),
    };
    expect(await svc.sweepLateFills(founderA, { force: true })).toMatchObject({ checked: 1, found: 1, errors: [] });
    await expect(svc.quote(who.caller, bodyOf(who, '1'))).rejects.toMatchObject({ code: 'pay.conversion_late_fill_halt' });
    const lastWindow = seen.at(-1);
    expect(lastWindow?.orderId ?? null).toBeNull();
    expect(lastWindow!.endTimeMs - lastWindow!.startTimeMs).toBe(CONVERSION_VENUE_WINDOW_LEAD_MS + CONVERSION_VENUE_WINDOW_TAIL_MS);
    expect(Math.abs(lastWindow!.startTimeMs - (claim - CONVERSION_VENUE_WINDOW_LEAD_MS))).toBeLessThanOrEqual(5);
  });

  it('follows the live row when min notional loses the intent_committed race', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(undefined, 60_000, 0n, {
      filters: { tickSize: parseAmount('0.01'), stepSize: parseAmount('0.01'), minNotional: parseAmount('1000') },
    });
    const readFilters = venue.symbolFilters.bind(venue);
    venue.symbolFilters = async (symbol) => {
      await db.sql`
        UPDATE pay.conversion_orders
           SET status = 'placing', placing_at = COALESCE(placing_at, now()), updated_at = now()
         WHERE status = 'intent_committed'
      `;
      return readFilters(symbol);
    };
    const svc = service(venue, { ledger, placingMaxAgeMs: 3_600_000 });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    const order = await svc.execute(who.caller, { requestId: randomUUID(), quoteId: quote.quoteId });
    expect(order.status).toBe('placing');
    expect(order.failureCode).toBeNull();
    expect(venue.placeCount()).toBe(0);
    expect((await ledger.balance(merchantClearing(who.merchantId, 'USD'))).amount).toBe(0n);
  });

  it('records the sweeper and continues after one hold conflicts', async () => {
    const who = await merchant();
    const inner = new MemoryLedger();
    await fund(inner, who.merchantId, parseAmount('40'));
    const stuck = randomUUID();
    const other = randomUUID();
    await inner.post(
      recipes.fxConversionHold({ conversionId: stuck, merchantId: who.merchantId, fromAsset: 'USD', amount: parseAmount('10') }),
    );
    await inner.post(
      recipes.fxConversionHold({ conversionId: other, merchantId: who.merchantId, fromAsset: 'USD', amount: parseAmount('10') }),
    );
    const ledger: LedgerClient = {
      async post(request) {
        if (request.idempotencyKey === `pay.conversion.release:${stuck}:0`) {
          throw Object.assign(new Error('conflict'), { code: 'ledger.idempotency_conflict' });
        }
        return inner.post(request);
      },
      balance: (ref) => inner.balance(ref),
      balances: (ownerType, ownerId) => inner.balances(ownerType, ownerId),
      getTx: (txId) => inner.getTx(txId),
      getTxByKey: (key) => inner.getTxByKey(key),
    };
    const svc = service(
      memory(() => full),
      { ledger },
    );
    const sweeper = randomUUID();
    const result = await svc.sweepOrphanHolds(sweeper);
    expect(result.released).toBe(1);
    expect(result.busy).toBe(false);
    expect(result.failures).toEqual([{ conversionId: stuck, code: 'ledger.idempotency_conflict' }]);
    const actors = await db.sql<Array<{ actor_id: string }>>`SELECT actor_id FROM pay.conversion_audit WHERE action = 'hold_swept'`;
    expect(actors.map((entry) => entry.actor_id)).toEqual([sweeper]);
    await expect(svc.sweepOrphanHolds('   ')).rejects.toMatchObject({ code: 'pay.conversion_unauthenticated' });
  });

  async function absentResolved(): Promise<{
    who: { userId: string; merchantId: string; settlementId: string; caller: Principal };
    ledger: MemoryLedger;
    svc: ConversionService;
    orderId: string;
    clientOrderId: string;
    claimMs: number;
    setNow: (ms: number) => void;
    nowMs: () => number;
    calls: { n: number };
    plant: (order: VenueOrder | null) => void;
  }> {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    const venue = memory(() => full);
    let nowMs = Date.now();
    let planted: VenueOrder | null = null;
    const calls = { n: 0 };
    const innerOrder = venue.fetchOrder.bind(venue);
    const innerClosed = venue.fetchClosedOrder.bind(venue);
    venue.fetchOrder = async (symbol, clientOrderId) => {
      calls.n += 1;
      return planted ? null : innerOrder(symbol, clientOrderId);
    };
    venue.fetchClosedOrder = async (symbol, clientOrderId, window) => {
      calls.n += 1;
      if (planted) return planted;
      return innerClosed(symbol, clientOrderId, window);
    };
    const svc = service(venue, { ledger, placingMaxAgeMs: 60_000, now: () => new Date(nowMs) });
    const quote = await svc.quote(who.caller, bodyOf(who, '100'));
    venue.refuseNext(new Error('venue timeout'));
    const requestId = randomUUID();
    await expect(svc.execute(who.caller, { requestId, quoteId: quote.quoteId })).rejects.toThrow(/venue timeout/);
    const claimed = await db.sql<Array<{ id: string; placing_at: Date; client_order_id: string }>>`
      SELECT id, placing_at, client_order_id FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    const claimMs = new Date(claimed[0]!.placing_at).getTime();
    nowMs = claimMs + 20 * 60 * 1000;
    const proposal = await svc.proposeResolve(randomUUID(), {
      requestId: randomUUID(),
      conversionId: claimed[0]!.id,
      reason: 'no order',
    });
    nowMs = claimMs + 26 * 60 * 1000;
    const released = await svc.confirmResolve(randomUUID(), {
      requestId: proposal.requestId,
      decision: 'confirm',
      reason: 'second miss',
      expectedChangeHash: proposal.changeHash!,
    });
    expect(released.order?.failureCode).toBe('pay.conversion_resolve_absent');
    calls.n = 0;
    return {
      who,
      ledger,
      svc,
      orderId: claimed[0]!.id,
      clientOrderId: claimed[0]!.client_order_id,
      claimMs,
      setNow: (ms) => {
        nowMs = ms;
      },
      nowMs: () => nowMs,
      calls,
      plant: (order) => {
        planted = order;
      },
    };
  }

  function plantedFill(clientOrderId: string, claimMs: number, filled: Amount = HUNDRED): VenueOrder {
    return {
      venueId: 'binance-spot',
      venueOrderId: 'late-book',
      clientOrderId,
      symbol: 'USD/USDT',
      side: 'sell',
      type: 'limit',
      price: RATE,
      amount: HUNDRED,
      filled,
      remaining: 0n,
      averagePrice: RATE,
      status: 'filled',
      feePaid: 0n,
      feeAsset: null,
      createdAt: new Date(claimMs),
      observedAt: new Date(claimMs),
    };
  }

  it('bounds late-fill rechecks: lock, backoff, tick cap, and the 7-day horizon', async () => {
    const absent = await absentResolved();
    const held = await db.sql.reserve();
    try {
      await held`SELECT pg_advisory_lock(${LATE_FILL_SWEEP_LOCK_A}, ${LATE_FILL_SWEEP_LOCK_B})`;
      expect(await absent.svc.sweepLateFills('late-fill-sweep')).toMatchObject({ checked: 0, found: 0, busy: true });
      expect(absent.calls.n).toBe(0);
    } finally {
      await held`SELECT pg_advisory_unlock(${LATE_FILL_SWEEP_LOCK_A}, ${LATE_FILL_SWEEP_LOCK_B})`;
      held.release();
    }
    expect(await absent.svc.sweepLateFills('late-fill-sweep')).toMatchObject({ checked: 1, found: 0, busy: false, finalized: 0 });
    expect(await absent.svc.sweepLateFills('late-fill-sweep')).toMatchObject({ checked: 0, found: 0, busy: false });
    absent.setNow(absent.nowMs() + 61_000);
    expect(await absent.svc.sweepLateFills('late-fill-sweep')).toMatchObject({ checked: 1, found: 0 });
    absent.setNow(absent.nowMs() + 61_000);
    expect(await absent.svc.sweepLateFills('late-fill-sweep')).toMatchObject({ checked: 0, found: 0 });

    const quote = await db.sql<Array<{ quote_id: string }>>`SELECT quote_id FROM pay.conversion_orders WHERE id = ${absent.orderId}`;
    for (let i = 0; i < CONVERSION_LATE_FILL_VENUE_CALLS_PER_TICK + 1; i++) {
      const quoteId = randomUUID();
      const orderId = randomUUID();
      const attempt = i + 2;
      await db.sql`
        INSERT INTO pay.conversion_quotes (
          id, merchant_id, settlement_id, from_asset, to_asset, from_amount, rate, fee_amount, spread_amount,
          minimum_output, expected_output, gross_output, commission_rate, venue_id, symbol, expires_at
        )
        SELECT ${quoteId}, merchant_id, settlement_id, from_asset, to_asset, from_amount, rate, fee_amount, spread_amount,
               minimum_output, expected_output, gross_output, commission_rate, venue_id, symbol, expires_at
          FROM pay.conversion_quotes WHERE id = ${quote[0]!.quote_id}
      `;
      await db.sql`
        INSERT INTO pay.conversion_orders (
          id, request_id, quote_id, merchant_id, settlement_id, attempt, client_order_id, venue_id, symbol,
          status, from_asset, to_asset, from_amount, filled_from_amount, filled_to_amount,
          fee_amount, spread_amount, minimum_output, failure_code, placing_at
        )
        SELECT ${orderId}, ${randomUUID()}, ${quoteId}, merchant_id, settlement_id, ${attempt},
               ${conversionClientOrderId(absent.who.settlementId, attempt)}, venue_id, symbol,
               status, from_asset, to_asset, from_amount, 0, 0,
               fee_amount, spread_amount, minimum_output, failure_code, placing_at
          FROM pay.conversion_orders WHERE id = ${absent.orderId}
      `;
    }
    const capped = await absent.svc.sweepLateFills('late-fill-sweep', { force: true });
    expect(capped.checked).toBe(CONVERSION_LATE_FILL_VENUE_CALLS_PER_TICK);
    const unchecked = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.conversion_orders
       WHERE failure_code = 'pay.conversion_resolve_absent' AND last_checked_at IS NULL
    `;
    expect(unchecked[0]!.n).toBeGreaterThan(0);

    absent.setNow(absent.claimMs + CONVERSION_LATE_FILL_HORIZON_MS + 1_000);
    const closed = await absent.svc.sweepLateFills('late-fill-sweep', { force: true });
    expect(closed.checked).toBe(0);
    expect(closed.finalized).toBeGreaterThan(0);
    const finals = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.conversion_orders
       WHERE failure_code = 'pay.conversion_resolve_absent' AND late_fill_check_final_at IS NOT NULL
    `;
    expect(finals[0]!.n).toBe(CONVERSION_LATE_FILL_VENUE_CALLS_PER_TICK + 2);
    const callsAfterHorizon = absent.calls.n;
    expect(await absent.svc.sweepLateFills(randomUUID(), { force: true })).toMatchObject({ checked: 0, finalized: 0 });
    expect(absent.calls.n).toBe(callsAfterHorizon);

    const holdLock = await db.sql.reserve();
    try {
      await holdLock`SELECT pg_advisory_lock(${HOLD_SWEEP_LOCK_A}, ${HOLD_SWEEP_LOCK_B})`;
      expect(await absent.svc.sweepOrphanHolds(randomUUID())).toEqual({ released: 0, failures: [], busy: true });
    } finally {
      await holdLock`SELECT pg_advisory_unlock(${HOLD_SWEEP_LOCK_A}, ${HOLD_SWEEP_LOCK_B})`;
      holdLock.release();
    }
  });

  it('books a late fill from venue evidence, and inventory when clearing cannot cover', async () => {
    const absent = await absentResolved();
    absent.plant(plantedFill(absent.clientOrderId, absent.claimMs));
    expect(await absent.svc.sweepLateFills('late-fill-sweep')).toMatchObject({ found: 1 });
    const audit = await db.sql<Array<{ id: string }>>`
      SELECT id FROM pay.conversion_audit WHERE conversion_id = ${absent.orderId} AND action = 'pay.conversion_late_fill'
    `;
    await db.sql`
      UPDATE pay.conversion_orders
         SET minimum_output = 1000
       WHERE id = ${absent.orderId}
    `;
    const founderA = randomUUID();
    const founderB = randomUUID();
    const tooSmall = await absent.svc.proposeLateFillBook(founderA, {
      requestId: randomUUID(),
      auditId: audit[0]!.id,
      reason: 'fill is under the floor',
    });
    expect(tooSmall.status).toBe('below_minimum');
    await db.sql`UPDATE pay.conversion_orders SET fee_amount = 2, spread_amount = 1, minimum_output = 90 WHERE id = ${absent.orderId}`;
    const proposed = await absent.svc.proposeLateFillBook(founderA, {
      requestId: randomUUID(),
      auditId: audit[0]!.id,
      reason: 'venue filled after the release',
    });
    expect(proposed.status).toBe('pending');
    await expect(
      absent.svc.confirmLateFillBook(founderA, {
        requestId: proposed.requestId,
        decision: 'confirm',
        reason: 'same person',
        expectedChangeHash: proposed.changeHash!,
      }),
    ).resolves.toMatchObject({ status: 'same_founder' });
    await expect(
      absent.svc.confirmLateFillBook(founderB, {
        requestId: proposed.requestId,
        decision: 'confirm',
        reason: 'wrong hash',
        expectedChangeHash: `sha256:${'ab'.repeat(32)}`,
      }),
    ).resolves.toMatchObject({ status: 'hash_mismatch' });
    absent.plant(plantedFill(absent.clientOrderId, absent.claimMs, parseAmount('50')));
    await expect(
      absent.svc.confirmLateFillBook(founderB, {
        requestId: proposed.requestId,
        decision: 'confirm',
        reason: 'evidence moved',
        expectedChangeHash: proposed.changeHash!,
      }),
    ).resolves.toMatchObject({ status: 'evidence_changed', order: null });
    expect((await absent.ledger.balance(merchantClearing(absent.who.merchantId, 'USD'))).amount).toBe(HUNDRED);
    expect((await absent.ledger.balance(userAvailable(absent.who.userId, 'USDT'))).amount).toBe(0n);

    absent.plant(plantedFill(absent.clientOrderId, absent.claimMs));
    const booked = await absent.svc.confirmLateFillBook(founderB, {
      requestId: proposed.requestId,
      decision: 'confirm',
      reason: 'second founder',
      expectedChangeHash: proposed.changeHash!,
    });
    expect(booked).toMatchObject({ status: 'confirmed', funding: 'merchant' });
    expect(booked.order?.status).toBe('filled');
    expect((await absent.ledger.balance(merchantClearing(absent.who.merchantId, 'USD'))).amount).toBe(0n);
    expect((await absent.ledger.balance(userAvailable(absent.who.userId, 'USDT'))).amount).toBe(parseAmount('97'));
    expect((await absent.ledger.balance(houseFees('pay', 'USDT'))).amount).toBe(parseAmount('3'));
    expect((await absent.ledger.balance(conversionInventory('USD'))).amount).toBe(0n);
    expect(absent.ledger.reconcile()).toEqual({ ok: true });
    const again = await absent.svc.confirmLateFillBook(founderB, {
      requestId: proposed.requestId,
      decision: 'confirm',
      reason: 'retry',
      expectedChangeHash: proposed.changeHash!,
    });
    expect(again.status).toBe('confirmed');
    expect((await absent.ledger.balance(userAvailable(absent.who.userId, 'USDT'))).amount).toBe(parseAmount('97'));
    expect(
      await absent.svc.proposeLateFillBook(founderA, { requestId: randomUUID(), auditId: audit[0]!.id, reason: 'again' }),
    ).toMatchObject({ status: 'already_booked' });
    await expect(absent.svc.quote(absent.who.caller, bodyOf(absent.who, '1'))).rejects.toMatchObject({
      code: 'pay.conversion_late_fill_halt',
    });
    // Booking does not lift the quote halt. The sentence ack does, so the next merchant can quote.
    const ack = await absent.svc.proposeLateFillAck(founderA, {
      requestId: randomUUID(),
      auditId: audit[0]!.id,
      settlement: 'booked on the ledger; this sentence only lifts the quote halt',
      reason: 'acknowledge the recorded fill',
    });
    expect(
      (
        await absent.svc.confirmLateFillAck(founderB, {
          requestId: ack.requestId,
          decision: 'confirm',
          reason: 'second founder',
          expectedChangeHash: ack.changeHash!,
        })
      ).status,
    ).toBe('confirmed');

    const short = await absentResolved();
    short.plant(plantedFill(short.clientOrderId, short.claimMs));
    expect(await short.svc.sweepLateFills('late-fill-sweep')).toMatchObject({ found: 1 });
    await short.ledger.post(
      recipes.fxConversionHold({
        conversionId: randomUUID(),
        merchantId: short.who.merchantId,
        fromAsset: 'USD',
        amount: parseAmount('60'),
      }),
    );
    expect((await short.ledger.balance(merchantClearing(short.who.merchantId, 'USD'))).amount).toBe(parseAmount('40'));
    const shortAudit = await db.sql<Array<{ id: string }>>`
      SELECT id FROM pay.conversion_audit WHERE conversion_id = ${short.orderId} AND action = 'pay.conversion_late_fill'
    `;
    const shortProposal = await short.svc.proposeLateFillBook(founderA, {
      requestId: randomUUID(),
      auditId: shortAudit[0]!.id,
      reason: 'clearing was spent',
    });
    const covered = await short.svc.confirmLateFillBook(founderB, {
      requestId: shortProposal.requestId,
      decision: 'confirm',
      reason: 'inventory covers',
      expectedChangeHash: shortProposal.changeHash!,
    });
    expect(covered).toMatchObject({ status: 'confirmed', funding: 'inventory' });
    expect((await short.ledger.balance(merchantClearing(short.who.merchantId, 'USD'))).amount).toBe(parseAmount('40'));
    expect((await short.ledger.balance(conversionInventory('USD'))).amount).toBe(-HUNDRED);
    expect((await short.ledger.balance(userAvailable(short.who.userId, 'USDT'))).amount).toBe(HUNDRED);
    const shortfall = await db.sql<Array<{ detail: { fromAmount?: string; clearingAmount?: string } }>>`
      SELECT detail FROM pay.conversion_audit
       WHERE conversion_id = ${short.orderId} AND action = 'pay.conversion_late_fill_shortfall'
    `;
    expect(shortfall).toHaveLength(1);
    expect(shortfall[0]!.detail.fromAmount).toBe('100');
    expect(shortfall[0]!.detail.clearingAmount).toBe('40');
    await short.svc.confirmLateFillBook(founderB, {
      requestId: shortProposal.requestId,
      decision: 'confirm',
      reason: 'retry',
      expectedChangeHash: shortProposal.changeHash!,
    });
    expect((await short.ledger.balance(conversionInventory('USD'))).amount).toBe(-HUNDRED);
    expect(short.ledger.reconcile()).toEqual({ ok: true });
  });
});
