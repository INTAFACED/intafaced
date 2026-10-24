import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { fakeMarket } from '../public-rest.js';
import { orderIdFor } from './ids.js';
import { bindStopLimit } from './stop-limit-place.js';
import { stopMarketBody, stopMarketLimit } from './stop-market.js';
import { memoryStopTrigger, type StopTriggerStore } from './stop-trigger-door.js';
import { replacementClientOrderId } from './trade-service/internal.js';
import type { PlaceOrderInput } from './trade-service.js';

/**
 * Stop-market on spot (J-cex-spot-08 #3). It is placed and held as the stop-limit it becomes, at the owner's protection
 * price from its stop; the stored kind turns it back into a stop-market on the wire. A stop's trigger is changed by a
 * replacement whose trigger is stored before the original is cancelled.
 */

const SECRET = 'a-trade-stop-market-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });
const CAP = 50;

function signed(userId: string): Record<string, string> {
  const p = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}

const STOP = { symbol: 'BTC/USDT', type: 'stop', side: 'sell', amount: '1', stopPrice: '100', clientOrderId: 'sm-1' };

async function build(opts: { triggers?: StopTriggerStore | null; cap?: number | null } = {}) {
  const seen: PlaceOrderInput[] = [];
  const capReads: string[] = [];
  const replaced: Array<{ id: string; input: PlaceOrderInput }> = [];
  const stored = new Map<string, ReturnType<typeof fakeOrder>>();
  const triggers = opts.triggers === null ? undefined : (opts.triggers ?? memoryStopTrigger());
  const app = Fastify();
  const deps = {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    stopTriggers: triggers,
    stopMarketCapBps: async (marketId: string) => {
      capReads.push(marketId);
      return opts.cap === undefined ? CAP : opts.cap;
    },
    marketBySymbol: async (symbol: string) => (symbol === 'BTC/USDT' ? market : null),
    marketById: async (id: string) => (id === market.id ? market : null),
    placeOrder: async (p: Principal, input: PlaceOrderInput) => {
      seen.push(bindStopLimit(input));
      const id = orderIdFor(p.userId, market.id, input.clientOrderId as string);
      const order = fakeOrder({ id, userId: p.userId, marketId: market.id, type: 'limit', price: input.price, qty: input.qty });
      stored.set(id, order);
      return order;
    },
    findClientOrder: async (p: Principal, input: { clientOrderId?: string }) =>
      stored.get(orderIdFor(p.userId, market.id, input.clientOrderId as string)) ?? null,
    replaceOrder: async (p: Principal, id: string, input: PlaceOrderInput) => {
      replaced.push({ id, input: bindStopLimit(input) });
      const original = stored.get(id)!;
      const replacementId = orderIdFor(p.userId, market.id, replacementClientOrderId(input.clientOrderId as string));
      const replacement = fakeOrder({
        id: replacementId,
        userId: p.userId,
        marketId: market.id,
        type: 'limit',
        price: input.price,
        qty: input.qty,
      });
      stored.delete(id);
      stored.set(replacementId, replacement);
      return {
        accepted: true,
        idempotent: false,
        code: 'REPLACED',
        reasonCode: null,
        reconciliationRequired: false,
        original,
        replacement,
      };
    },
    getOrder: async (_p: Principal, id: string) => stored.get(id)!,
    openOrders: async () => [...stored.values()],
    orderHistory: async () => [...stored.values()],
  } as unknown as PrivateRestDeps;
  registerPrivateRest(app, deps);
  await app.ready();
  return { app, seen, replaced, triggers, stored, capReads };
}

const post = (app: Awaited<ReturnType<typeof build>>['app'], payload: Record<string, unknown>, url = '/api/v1/orders') =>
  app.inject({ method: 'POST', url, headers: signed(ALICE), payload });

describe('stop-market protection price', () => {
  it('bounds a buy at most the cap above its stop and a sell at least the cap below, on the tick', () => {
    const tick = { symbol: 'BTC/USDT', tickSize: parseAmount('0.01') };
    expect(stopMarketLimit(tick, 'buy', parseAmount('100'), 50)).toBe(parseAmount('100.5'));
    expect(stopMarketLimit(tick, 'sell', parseAmount('100'), 50)).toBe(parseAmount('99.5'));
    // Off the grid: the buy rounds down and the sell rounds up, so neither leaves the cap.
    expect(stopMarketLimit(tick, 'buy', parseAmount('100.03'), 33)).toBe(parseAmount('100.36'));
    expect(stopMarketLimit(tick, 'sell', parseAmount('100.03'), 33)).toBe(parseAmount('99.7'));
  });

  it('refuses a blank or out-of-range cap', () => {
    const tick = { symbol: 'BTC/USDT', tickSize: parseAmount('0.01') };
    for (const cap of [null, undefined, 0, 5001, 1.5]) {
      expect(() => stopMarketLimit(tick, 'sell', parseAmount('100'), cap)).toThrow(
        expect.objectContaining({ code: 'trade.protection_unset' }),
      );
    }
    expect(stopMarketLimit(tick, 'sell', parseAmount('0.02'), 5000)).toBe(parseAmount('0.01'));
  });

  it('refuses a stop where the cap is under one price step: it would rest at its own trigger and never trade', () => {
    const tick = { symbol: 'BTC/USDT', tickSize: parseAmount('0.01') };
    for (const side of ['buy', 'sell'] as const) {
      expect(() => stopMarketLimit(tick, side, parseAmount('1'), 50)).toThrow(expect.objectContaining({ code: 'trade.invalid_price' }));
    }
    expect(() => stopMarketLimit({ symbol: 'X', tickSize: parseAmount('1') }, 'sell', parseAmount('1'), 5000)).toThrow(
      expect.objectContaining({ code: 'trade.invalid_price' }),
    );
  });

  it('leaves every other body untouched', () => {
    const limit = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100' };
    expect(stopMarketBody(limit, market, CAP)).toEqual({ body: limit, kind: null });
    expect(stopMarketBody(null, market, CAP)).toEqual({ body: null, kind: null });
  });
});

describe('stop-market placement', () => {
  it('places the stop-limit at the sell floor, stores the trigger as a stop-market, and answers as one', async () => {
    const { app, seen, triggers, capReads } = await build();
    const res = await post(app, STOP);
    expect(res.statusCode).toBe(201);
    // The cap is the one in force on this market (the operator's, else the env cap), read per placement.
    expect(capReads).toEqual([market.id]);
    expect(res.json()).toMatchObject({ type: 'stop', stopPrice: '100', price: '99.5', triggered: null });
    expect(seen[0]).toMatchObject({ type: 'limit', price: parseAmount('99.5'), tif: 'GTC' });
    expect((seen[0] as { stopPx?: bigint }).stopPx).toBe(parseAmount('100'));
    const id = orderIdFor(ALICE, market.id, 'sm-1');
    expect(await triggers!.read(id)).toBe('100');
    expect(await triggers!.readStopMarkets([id])).toEqual(new Set([id]));
    await app.close();
  });

  it('holds a buy at the cap above its stop', async () => {
    const { app, seen } = await build();
    const res = await post(app, { ...STOP, side: 'buy', clientOrderId: 'sm-buy' });
    expect(res.json()).toMatchObject({ type: 'stop', stopPrice: '100', price: '100.5' });
    expect(seen[0]?.price).toBe(parseAmount('100.5'));
    await app.close();
  });

  it('refuses a price, an immediate time in force, a blank cap and a missing trigger, before any trigger or hold', async () => {
    const { app, seen, triggers } = await build();
    const priced = await post(app, { ...STOP, price: '99' });
    expect(priced.json().intafacedCode).toBe('trade.invalid_price');
    const ioc = await post(app, { ...STOP, timeInForce: 'IOC' });
    expect(ioc.json().intafacedCode).toBe('trade.invalid_tif');
    expect((await post(app, { ...STOP, stopPrice: undefined })).statusCode).toBe(400);
    expect(seen).toHaveLength(0);
    expect(await triggers!.read(orderIdFor(ALICE, market.id, 'sm-1'))).toBeNull();
    await app.close();

    const blank = await build({ cap: null });
    const res = await post(blank.app, STOP);
    // An unpublished owner setting is the venue's gap, not the caller's mistake: the usual 503 for it.
    expect(res.statusCode).toBe(503);
    expect(res.json().intafacedCode).toBe('trade.protection_unset');
    expect(blank.seen).toHaveLength(0);
    expect(await blank.triggers!.read(orderIdFor(ALICE, market.id, 'sm-1'))).toBeNull();
    await blank.app.close();
  });

  it('refuses closed when no trigger store is wired', async () => {
    const { app, seen } = await build({ triggers: null });
    const res = await post(app, STOP);
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.order_type_unsupported');
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('a replay lands once, and the same id as a stop-limit is refused', async () => {
    const { app, seen } = await build();
    expect((await post(app, STOP)).statusCode).toBe(201);
    expect((await post(app, STOP)).json()).toMatchObject({ type: 'stop', stopPrice: '100' });
    const asLimit = await post(app, { ...STOP, type: 'stop_limit', price: '99.5' });
    expect(asLimit.json().intafacedCode).toBe('trade.stop_trigger_invalid');
    expect(seen).toHaveLength(2);
    await app.close();
  });

  it('reads back as a stop-market by id and in open orders, beside a stop-limit that stays one', async () => {
    const { app } = await build();
    const placed = (await post(app, STOP)).json();
    await post(app, { ...STOP, type: 'stop_limit', price: '95', clientOrderId: 'sl-1' });
    const get = await app.inject({ method: 'GET', url: `/api/v1/orders/${placed.id}`, headers: signed(ALICE) });
    expect(get.json()).toMatchObject({ type: 'stop', stopPrice: '100', price: '99.5' });
    const open = (await app.inject({ method: 'GET', url: '/api/v1/orders/open?limit=10', headers: signed(ALICE) })).json();
    expect(open.map((o: { type: string }) => o.type).sort()).toEqual(['stop', 'stop_limit']);
    await app.close();
  });
});

describe('changing a stop trigger by replacement', () => {
  it('stores the new trigger for the replacement before the original is cancelled, at the new protection price', async () => {
    const { app, replaced, triggers } = await build();
    const placed = (await post(app, STOP)).json();
    const res = await post(app, { ...STOP, stopPrice: '90', clientOrderId: 'sm-1-r1' }, `/api/v1/orders/${placed.id}/replace`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: 'REPLACED' });
    expect(replaced[0]?.id).toBe(placed.id);
    expect(replaced[0]?.input).toMatchObject({ type: 'limit', price: parseAmount('89.55') });
    expect((replaced[0]?.input as { stopPx?: bigint }).stopPx).toBe(parseAmount('90'));
    const replacementId = orderIdFor(ALICE, market.id, replacementClientOrderId('sm-1-r1'));
    expect(await triggers!.read(replacementId)).toBe('90');
    expect(await triggers!.readStopMarkets([replacementId])).toEqual(new Set([replacementId]));
    const get = await app.inject({ method: 'GET', url: `/api/v1/orders/${replacementId}`, headers: signed(ALICE) });
    expect(get.json()).toMatchObject({ type: 'stop', stopPrice: '90' });
    // The replace answer names both as the stops they are, not as bare limits at their protection prices.
    expect(res.json().replacement).toMatchObject({ id: replacementId, type: 'stop', stopPrice: '90', triggered: null });
    expect(res.json().original).toMatchObject({ id: placed.id, type: 'stop', stopPrice: '100' });
    await app.close();
  });

  it('keeps a stop-limit replacement a stop-limit at its own limit', async () => {
    const { app, replaced, triggers } = await build();
    const placed = (await post(app, { ...STOP, type: 'stop_limit', price: '95', clientOrderId: 'sl-1' })).json();
    const res = await post(
      app,
      { ...STOP, type: 'stop_limit', price: '94', stopPrice: '96', clientOrderId: 'sl-1-r1' },
      `/api/v1/orders/${placed.id}/replace`,
    );
    expect(res.json()).toMatchObject({ code: 'REPLACED' });
    expect(replaced[0]?.input).toMatchObject({ type: 'limit', price: parseAmount('94') });
    const replacementId = orderIdFor(ALICE, market.id, replacementClientOrderId('sl-1-r1'));
    expect(await triggers!.read(replacementId)).toBe('96');
    expect(await triggers!.readStopMarkets([replacementId])).toEqual(new Set());
    await app.close();
  });

  it('refuses a replacement key reused with another trigger before the original is touched', async () => {
    const { app, replaced } = await build();
    const placed = (await post(app, STOP)).json();
    await post(app, { ...STOP, stopPrice: '90', clientOrderId: 'sm-1-r1' }, `/api/v1/orders/${placed.id}/replace`);
    const again = await post(app, { ...STOP, stopPrice: '91', clientOrderId: 'sm-1-r1' }, `/api/v1/orders/${placed.id}/replace`);
    expect(again.json().intafacedCode).toBe('trade.stop_trigger_invalid');
    expect(replaced).toHaveLength(1);
    await app.close();
  });

  it('replaces only a stop by the same kind of stop, before anything is touched', async () => {
    const { app, replaced } = await build();
    const limit = (
      await post(app, { symbol: 'BTC/USDT', type: 'limit', side: 'sell', amount: '1', price: '120', clientOrderId: 'l-1' })
    ).json();
    const stopMarket = (await post(app, STOP)).json();
    const stopLimit = (await post(app, { ...STOP, type: 'stop_limit', price: '95', clientOrderId: 'sl-1' })).json();
    const cases: Array<[string, Record<string, unknown>]> = [
      // A resting limit swapped for a dormant stop.
      [limit.id, { ...STOP, clientOrderId: 'l-1-r1' }],
      // A stop swapped for a live limit at its protection price.
      [stopMarket.id, { symbol: 'BTC/USDT', type: 'limit', side: 'sell', amount: '1', price: '99.5', clientOrderId: 'sm-1-r1' }],
      // One stop kind swapped for the other.
      [stopMarket.id, { ...STOP, type: 'stop_limit', price: '89', stopPrice: '90', clientOrderId: 'sm-1-r2' }],
      [stopLimit.id, { ...STOP, stopPrice: '96', clientOrderId: 'sl-1-r1' }],
    ];
    for (const [id, body] of cases) {
      const res = await post(app, body, `/api/v1/orders/${id}/replace`);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().intafacedCode).toBe('trade.stop_trigger_invalid');
    }
    expect(replaced).toHaveLength(0);
    await app.close();
  });
});
