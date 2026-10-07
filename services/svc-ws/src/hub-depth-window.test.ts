/**
 * GET /markets/:id/depth hub book applies the published WS_DEPTH_LIMIT window.
 * Full hub book must not 200 unbounded. Unpublished env is 503, not 50.
 * Empty listed market stays 404 NoBook — never 200 { bids:[], asks:[] }.
 */
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DepthSnapshot } from '@intafaced/market-data';
import { DepthHub } from './depth/hub.js';
import { DepthNoBookError, type DepthSource } from './depth/source.js';
import { WS_DEPTH_LIMIT_UNSET } from './depth-limit.js';
import { PrivateOrderHub } from './private/hub.js';
import { registerRoutes } from './routes.js';
import { TradeHub } from './trade/hub.js';

const MARKET = 'BTC-USDT';

function fatSnapshot(sequence = 7): DepthSnapshot {
  return {
    type: 'snapshot',
    marketId: MARKET,
    sequence,
    bids: [
      ['98', '1'],
      ['100', '3'],
      ['99', '2'],
    ],
    asks: [
      ['103', '3'],
      ['101', '1'],
      ['102', '2'],
    ],
  };
}

class FakeSource implements DepthSource {
  snapshot = vi.fn(async (marketId: string): Promise<DepthSnapshot> => {
    throw new DepthNoBookError(marketId);
  });

  constructor(readonly marketList: string[]) {}

  async markets(): Promise<readonly string[]> {
    return this.marketList;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A hub book exists only while someone is watching. Seed through that
 * subscriber, then forget the seed's source calls so GET is what we measure.
 */
async function plantWatchedBook(hub: DepthHub, source: FakeSource, book: DepthSnapshot, wipeEmpty: boolean): Promise<void> {
  source.snapshot.mockImplementation(async () => book);
  const detach = hub.attach(MARKET, { bufferedBytes: 0, send() {}, close() {} });
  if (!detach) throw new Error('depth attach refused');
  await settle();
  if (wipeEmpty) {
    hub.ingest({ type: 'snapshot', marketId: MARKET, sequence: book.sequence + 1, bids: [], asks: [] });
  }
  source.snapshot.mockImplementation(async (marketId: string) => {
    throw new DepthNoBookError(marketId);
  });
  source.snapshot.mockClear();
}

async function appFor(opts: { depthLimit: number | undefined; ingest?: DepthSnapshot; emptyHubBook?: boolean }) {
  const source = new FakeSource([MARKET]);
  const hub = new DepthHub(source, {
    depthLimit: opts.depthLimit,
    highWaterBytes: 1_000,
    maxLagTicks: 3,
    maxConnections: 100,
    marketsRefreshMs: 0,
    registry: { markets: async () => [MARKET] },
  });
  await hub.refreshMarkets();
  if (opts.depthLimit !== undefined && (opts.ingest || opts.emptyHubBook)) {
    await plantWatchedBook(hub, source, opts.ingest ?? fatSnapshot(1), opts.emptyHubBook === true);
  }
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

describe('GET /markets/:id/depth hub window', () => {
  it('slices a full hub book to the published window', async () => {
    const { app, source } = await appFor({ depthLimit: 2, ingest: fatSnapshot() });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      type: 'snapshot',
      marketId: MARKET,
      bids: [
        ['100', '3'],
        ['99', '2'],
      ],
      asks: [
        ['101', '1'],
        ['102', '2'],
      ],
    });
    expect(source.snapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses unpublished WS_DEPTH_LIMIT with 503 — does not dump the hub book', async () => {
    const { app, source } = await appFor({ depthLimit: undefined, ingest: fatSnapshot() });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      code: WS_DEPTH_LIMIT_UNSET,
      message: 'WS_DEPTH_LIMIT unpublished',
    });
    expect(res.json()).not.toMatchObject({ type: 'snapshot' });
    expect(source.snapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it('listed market with no resting depth is 404 NoBook, not 200 empty arrays', async () => {
    const { app } = await appFor({ depthLimit: 2 });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NoBook' });
    expect(res.json()).not.toMatchObject({ bids: [], asks: [] });
    await app.close();
  });

  it('hub book wiped to empty is 404 NoBook, not 200 { bids:[], asks:[] }', async () => {
    const { app, source } = await appFor({ depthLimit: 2, emptyHubBook: true });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NoBook' });
    expect(res.json()).not.toMatchObject({ type: 'snapshot' });
    expect(source.snapshot).not.toHaveBeenCalled();
    await app.close();
  });
});
