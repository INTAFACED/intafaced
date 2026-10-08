/**
 * GET /markets/:id/depth/l3 applies the published WS_DEPTH_LIMIT window.
 * Full native queue must not 200 unbounded. Unpublished env is 503, not 50.
 * Empty listed market stays 404 NoBook — never 200 { bids:[], asks:[] }.
 */
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DepthSnapshot } from '@intafaced/market-data';
import { DEPTH_ENGINE_UNAVAILABLE, DepthHub } from './depth/hub.js';
import { DepthNoBookError, type DepthSource, type NativeL3Queue } from './depth/source.js';
import { WS_DEPTH_LIMIT_UNSET } from './depth-limit.js';
import { PrivateOrderHub } from './private/hub.js';
import { registerRoutes } from './routes.js';
import { TradeHub } from './trade/hub.js';

const MARKET = 'BTC-USDT';

function fatQueue(): NativeL3Queue {
  return {
    level: 'L3',
    marketId: MARKET,
    bids: [
      { price: '98', orders: [{ orderId: 'b3', remaining: '1', sequence: 1 }] },
      { price: '100', orders: [{ orderId: 'b1', remaining: '3', sequence: 2 }] },
      { price: '99', orders: [{ orderId: 'b2', remaining: '2', sequence: 3 }] },
    ],
    asks: [
      { price: '103', orders: [{ orderId: 'a3', remaining: '3', sequence: 4 }] },
      { price: '101', orders: [{ orderId: 'a1', remaining: '1', sequence: 5 }] },
      { price: '102', orders: [{ orderId: 'a2', remaining: '2', sequence: 6 }] },
    ],
  };
}

class FakeSource implements DepthSource {
  snapshot = vi.fn(async (marketId: string): Promise<DepthSnapshot> => {
    throw new DepthNoBookError(marketId);
  });
  l3Queue = vi.fn(async (_marketId: string, _limit: number): Promise<NativeL3Queue> => fatQueue());

  constructor(readonly marketList: string[]) {}

  async markets(): Promise<readonly string[]> {
    return this.marketList;
  }
}

async function appFor(opts: {
  depthLimit: number | undefined;
  queue?: NativeL3Queue | 'nobook';
  listing?: 'known' | 'down';
}) {
  const listing = opts.listing ?? 'known';
  const source = new FakeSource(listing === 'known' ? [MARKET] : []);
  if (opts.queue === 'nobook') {
    source.l3Queue = vi.fn(async (marketId: string, _limit: number) => {
      throw new DepthNoBookError(marketId);
    });
  } else if (opts.queue) {
    source.l3Queue = vi.fn(async (_marketId: string, _limit: number) => opts.queue as NativeL3Queue);
  }
  const hub = new DepthHub(source, {
    depthLimit: opts.depthLimit,
    highWaterBytes: 1_000,
    maxLagTicks: 3,
    maxConnections: 100,
    marketsRefreshMs: 0,
    registry:
      listing === 'down'
        ? {
            markets: async () => {
              throw new Error('listing unreachable');
            },
          }
        : { markets: async () => [MARKET] },
  });
  if (listing === 'known') await hub.refreshMarkets();
  const tradeHub = new TradeHub({
    highWaterBytes: 1_000,
    maxLagTicks: 3,
    maxConnections: 100,
    recentLimit: 10,
    ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
  });
  const privateHub = new PrivateOrderHub({
    highWaterBytes: 1_000,
    maxLagTicks: 3,
    maxConnections: 100,
    maxConnectionsPerUser: 100,
  });
  const app = Fastify({ logger: false });
  registerRoutes(app, {
    hub,
    tradeHub,
    privateHub,
    source,
    depthLimit: opts.depthLimit,
    serviceName: 'svc-ws-test',
    upstream: 'http://matching.test',
    enabled: () => true,
    tradesBus: () => false,
    privateBus: () => false,
  });
  return { app, source };
}

describe('GET /markets/:id/depth/l3 native window', () => {
  it('slices a full native queue to the published window', async () => {
    const { app, source } = await appFor({ depthLimit: 2 });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth/l3` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      type: 'snapshot',
      level: 'L3',
      marketId: MARKET,
      bids: [
        { price: '100', orders: [{ orderId: 'b1', remaining: '3', sequence: 2 }] },
        { price: '99', orders: [{ orderId: 'b2', remaining: '2', sequence: 3 }] },
      ],
      asks: [
        { price: '101', orders: [{ orderId: 'a1', remaining: '1', sequence: 5 }] },
        { price: '102', orders: [{ orderId: 'a2', remaining: '2', sequence: 6 }] },
      ],
    });
    expect(source.l3Queue).toHaveBeenCalledTimes(1);
    expect(source.l3Queue).toHaveBeenCalledWith(MARKET, 2);
    expect(source.snapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses unpublished WS_DEPTH_LIMIT with 503 — does not dump the queue', async () => {
    const { app, source } = await appFor({ depthLimit: undefined });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth/l3` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      code: WS_DEPTH_LIMIT_UNSET,
      message: 'WS_DEPTH_LIMIT unpublished',
    });
    expect(res.json()).not.toMatchObject({ type: 'snapshot' });
    expect(source.l3Queue).not.toHaveBeenCalled();
    expect(source.snapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it('listed market with no book is 404 NoBook, not 200 empty arrays', async () => {
    const { app } = await appFor({ depthLimit: 2, queue: 'nobook' });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth/l3` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NoBook' });
    expect(res.json()).not.toMatchObject({ bids: [], asks: [] });
    await app.close();
  });

  it('listed empty native queue is 404 NoBook, not 200 { bids:[], asks:[] }', async () => {
    const { app, source } = await appFor({
      depthLimit: 2,
      queue: { level: 'L3', marketId: MARKET, bids: [], asks: [] },
    });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth/l3` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NoBook' });
    expect(res.json()).not.toMatchObject({ type: 'snapshot' });
    expect(source.snapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it('a rejected market lookup is 502 depth.engine_unavailable, not a generic 500', async () => {
    const { app, source } = await appFor({ depthLimit: 2, listing: 'down' });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth/l3` });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: DEPTH_ENGINE_UNAVAILABLE });
    expect(res.json()).not.toMatchObject({ type: 'snapshot', level: 'L3' });
    expect(source.l3Queue).not.toHaveBeenCalled();
    expect(source.snapshot).not.toHaveBeenCalled();
    await app.close();
  });
});
