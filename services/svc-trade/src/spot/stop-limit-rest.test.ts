import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { fakeMarket } from '../public-rest.js';
import { orderIdFor } from './ids.js';
import { bindStopLimit } from './stop-limit-place.js';
import { memoryStopTrigger, type StopTriggerStore } from './stop-trigger-door.js';
import type { PlaceOrderInput } from './trade-service.js';

/**
 * Stop-limit on spot. The order is held and rests as the limit it becomes; its trigger is stored under the
 * deterministic order id before the hold, so a crash after the hold never leaves a live order without a trigger.
 */

const SECRET = 'a-trade-stop-limit-edge-secret-long-enough-x';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '33333333-3333-4333-8333-333333333333';
const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });

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

const STOP = { symbol: 'BTC/USDT', type: 'stop_limit', side: 'sell', amount: '1', price: '95', stopPrice: '100', clientOrderId: 'stop-1' };

async function build(opts: { triggers?: StopTriggerStore | null; failPlace?: () => boolean } = {}) {
  const seen: PlaceOrderInput[] = [];
  const stored = new Map<string, ReturnType<typeof fakeOrder>>();
  const triggers = opts.triggers === null ? undefined : (opts.triggers ?? memoryStopTrigger());
  const app = Fastify();
  const deps = {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    stopTriggers: triggers,
    marketBySymbol: async (symbol: string) => (symbol === 'BTC/USDT' ? market : null),
    marketById: async (id: string) => (id === market.id ? market : null),
    placeOrder: async (p: Principal, input: PlaceOrderInput) => {
      seen.push(bindStopLimit(input));
      if (opts.failPlace?.()) throw new Error('crash after the hold');
      const id = orderIdFor(p.userId, market.id, input.clientOrderId as string);
      const order = fakeOrder({ id, userId: p.userId, marketId: market.id, type: 'limit', price: input.price, qty: input.qty });
      stored.set(id, order);
      return order;
    },
    findClientOrder: async (p: Principal, input: { clientOrderId?: string }) =>
      stored.get(orderIdFor(p.userId, market.id, input.clientOrderId as string)) ?? null,
    replaceOrder: async () => {
      throw new Error('replace must not be reached');
    },
    getOrder: async (_p: Principal, id: string) => stored.get(id)!,
    openOrders: async () => [...stored.values()],
    orderHistory: async () => [...stored.values()],
  } as unknown as PrivateRestDeps;
  registerPrivateRest(app, deps);
  await app.ready();
  return { app, seen, triggers, stored };
}

const post = (app: Awaited<ReturnType<typeof build>>['app'], who: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(who), payload });

describe('stop-limit placement', () => {
  it('places the limit it becomes, with the trigger on the engine request, and answers as a stop-limit', async () => {
    const { app, seen, triggers } = await build();
    const res = await post(app, ALICE, STOP);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: 'stop_limit', stopPrice: '100', price: '95' });
    expect(seen[0]?.type).toBe('limit');
    expect((seen[0] as { stopPx?: bigint }).stopPx).toBe(parseAmount('100'));
    expect(await triggers!.read(orderIdFor(ALICE, market.id, 'stop-1'))).toBe('100');
    await app.close();
  });

  it('refuses a stop-limit with no price or no trigger, and a trigger off the tick grid', async () => {
    const { app, seen } = await build();
    expect((await post(app, ALICE, { ...STOP, stopPrice: undefined })).statusCode).toBe(400);
    expect((await post(app, ALICE, { ...STOP, price: undefined })).statusCode).toBe(400);
    const off = await post(app, ALICE, { ...STOP, stopPrice: '100.005' });
    expect(off.statusCode).toBe(400);
    expect(off.json().intafacedCode).toBe('trade.stop_trigger_invalid');
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('refuses closed when no trigger store is wired', async () => {
    const { app, seen } = await build({ triggers: null });
    const res = await post(app, ALICE, STOP);
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.order_type_unsupported');
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('keeps the trigger across a crash after the hold, and a retry with the same trigger lands once', async () => {
    let crash = true;
    const { app, triggers } = await build({ failPlace: () => crash });
    const first = await post(app, ALICE, STOP);
    expect(first.statusCode).toBeGreaterThanOrEqual(500);
    expect(await triggers!.read(orderIdFor(ALICE, market.id, 'stop-1'))).toBe('100');
    crash = false;
    const retry = await post(app, ALICE, STOP);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().stopPrice).toBe('100');
    await app.close();
  });

  it('refuses a reused clientOrderId with a different trigger before any hold', async () => {
    const { app, seen, triggers } = await build();
    expect((await post(app, ALICE, STOP)).statusCode).toBe(201);
    const again = await post(app, ALICE, { ...STOP, stopPrice: '101' });
    expect(again.statusCode).toBe(400);
    expect(again.json().intafacedCode).toBe('trade.stop_trigger_invalid');
    expect(seen).toHaveLength(1);
    expect(await triggers!.read(orderIdFor(ALICE, market.id, 'stop-1'))).toBe('100');
    await app.close();
  });

  it('keeps two callers with the same clientOrderId apart', async () => {
    const { app, triggers } = await build();
    await post(app, ALICE, STOP);
    await post(app, BOB, { ...STOP, stopPrice: '102' });
    expect(await triggers!.read(orderIdFor(ALICE, market.id, 'stop-1'))).toBe('100');
    expect(await triggers!.read(orderIdFor(BOB, market.id, 'stop-1'))).toBe('102');
    await app.close();
  });

  it('refuses a bare stopPx on a limit, an iceberg stop, and a market stop-limit-less trigger', async () => {
    const { app, seen } = await build();
    const bare = await post(app, ALICE, {
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'buy',
      amount: '1',
      price: '100',
      stopPx: '90',
      clientOrderId: 'bare',
    });
    expect(bare.json().intafacedCode).toBe('trade.stop_trigger_invalid');
    const ice = await post(app, ALICE, { ...STOP, clientOrderId: 'ice', displayQty: '0.5' });
    expect(ice.statusCode).toBe(400);
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('does not let a plain order reuse a stop id, or a stop relabel a live plain order', async () => {
    const { app, seen, triggers } = await build();
    expect((await post(app, ALICE, STOP)).statusCode).toBe(201);
    const plain = await post(app, ALICE, { ...STOP, type: 'limit', stopPrice: undefined });
    expect(plain.json().intafacedCode).toBe('trade.stop_trigger_invalid');
    expect(seen).toHaveLength(1);

    const limit = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100', clientOrderId: 'plain-1' };
    expect((await post(app, BOB, limit)).statusCode).toBe(201);
    const relabel = await post(app, BOB, { ...STOP, clientOrderId: 'plain-1' });
    expect(relabel.json().intafacedCode).toBe('trade.stop_trigger_invalid');
    expect(await triggers!.read(orderIdFor(BOB, market.id, 'plain-1'))).toBeNull();
    await app.close();
  });

  it('refuses a raw stopPx on an order replacement', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/o-1/replace',
      headers: signed(ALICE),
      payload: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100', stopPx: '90', clientOrderId: 'rep-1' },
    });
    expect(res.json().intafacedCode).toBe('trade.stop_trigger_invalid');
    await app.close();
  });

  it('reads back as a stop-limit by id, in open orders and in closed orders', async () => {
    const { app } = await build();
    const placed = (await post(app, ALICE, STOP)).json();
    const get = await app.inject({ method: 'GET', url: `/api/v1/orders/${placed.id}`, headers: signed(ALICE) });
    expect(get.json()).toMatchObject({ type: 'stop_limit', stopPrice: '100' });
    const open = await app.inject({ method: 'GET', url: '/api/v1/orders/open?limit=10', headers: signed(ALICE) });
    expect(open.json()[0]).toMatchObject({ type: 'stop_limit', stopPrice: '100' });
    const closed = await app.inject({ method: 'GET', url: '/api/v1/orders/closed?limit=10', headers: signed(ALICE) });
    expect(closed.json()[0]).toMatchObject({ type: 'stop_limit', stopPrice: '100' });
    await app.close();
  });

  it('says when the stop fired and the price that reached it, and null while it waits', async () => {
    const { app, triggers } = await build();
    await post(app, ALICE, STOP);
    const id = orderIdFor(ALICE, market.id, 'stop-1');
    const waiting = await app.inject({ method: 'GET', url: `/api/v1/orders/${id}`, headers: signed(ALICE) });
    expect(waiting.json()).toMatchObject({ type: 'stop_limit', stopPrice: '100', triggered: null });

    const fired = { at: '2026-10-23T03:00:00.000Z', by: 'last' as const, referencePrice: '99.5', sequence: 41 };
    expect(await triggers!.recordFired(id, fired)).toBe(true);
    // A redelivery (or a later event) never moves the first record.
    expect(await triggers!.recordFired(id, { ...fired, referencePrice: '90', sequence: 99 })).toBe(true);
    const read = await app.inject({ method: 'GET', url: `/api/v1/orders/${id}`, headers: signed(ALICE) });
    expect(read.json().triggered).toEqual({ at: fired.at, by: 'last', referencePrice: '99.5' });

    // A price the table would refuse is not recorded (and so never retried forever).
    const other = orderIdFor(ALICE, market.id, 'stop-2');
    await post(app, ALICE, { ...STOP, clientOrderId: 'stop-2' });
    expect(await triggers!.recordFired(other, { ...fired, referencePrice: '0' })).toBe(false);
    // An order with no stop here (a futures stop, the house) is not recorded.
    expect(await triggers!.recordFired('44444444-4444-4444-8444-444444444444', fired)).toBe(false);
    await app.close();
  });
});
