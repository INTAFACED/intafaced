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
import type { PlaceOrderRequest } from '@intafaced/venue-contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { composeGuards, FRESH } from '../seams/guards.js';
import { createW5HaltsGuards } from '../seams/slots/w5-halts.js';
import { createRegistryReader } from '../registries/read-api.js';
import { createConversionInventory } from './inventory.js';
import { ConversionService, conversionClientOrderId, type ConversionServiceDeps } from './service.js';
import { ConversionError } from './errors.js';
import { createMemoryConversionVenue, type ConversionVenue, type MemoryFill } from './venue.js';

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

  function memory(fill?: (request: PlaceOrderRequest) => MemoryFill, expiresInMs = 60_000, commission: Amount = 0n) {
    return createMemoryConversionVenue({
      bid: RATE,
      ask: RATE,
      commission,
      expiresAt: (now) => new Date(now.getTime() + expiresInMs),
      fill,
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
    const svc = service(venue, { ledger });
    const quote = await svc.quote(who.caller, {
      merchantId: who.merchantId,
      settlementId: who.settlementId,
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: '100',
    });
    const requestId = randomUUID();
    const [first, second] = await Promise.all([
      svc.execute(who.caller, { requestId, quoteId: quote.quoteId }),
      svc.execute(who.caller, { requestId, quoteId: quote.quoteId }),
    ]);
    expect(venue.placeCount()).toBe(1);
    expect([first.status, second.status].filter((status) => status === 'filled').length).toBeGreaterThan(0);
    expect(await db.sql`SELECT id FROM pay.conversion_orders WHERE settlement_id = ${who.settlementId}`).toHaveLength(1);
  });

  it('a timed-out place is not sent again while the venue still reports a miss', async () => {
    const who = await merchant();
    const ledger = new MemoryLedger();
    await fund(ledger, who.merchantId);
    let now = new Date();
    const venue = memory(() => full);
    venue.armLag(2);
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
});
