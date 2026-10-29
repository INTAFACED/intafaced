/**
 * `GET /streams` lists every channel the doors' parsers accept, each exactly
 * once, and nothing they refuse. The multiplexed door is listed either way,
 * mounted or down with the code the service logs at start.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { DepthHub } from './depth/hub.js';
import type { DepthSource } from './depth/source.js';
import { DROP_COPY_STREAM_PATH, parseDropCopyChannel } from './drop-copy/gateway.js';
import type { CandleHub } from './mux/candle-hub.js';
import type { MuxGateway } from './mux/gateway.js';
import { MUX_IDLE_UNSET } from './mux/idle.js';
import { parseChannel as parseMuxChannel } from './mux/protocol.js';
import type { TickerHub } from './mux/ticker-hub.js';
import { PRIVATE_STREAM_PATH, parsePrivateChannel } from './private/gateway.js';
import { PrivateOrderHub } from './private/hub.js';
import { registerRoutes } from './routes.js';
import { streamInventory, type StreamEntry } from './stream-inventory.js';
import { TradeHub } from './trade/hub.js';
import { STREAM_PATH, parseChannel } from './ws/gateway.js';

const MARKET = 'BTC-USDT';

/** Whether the door's own parser serves this channel. */
function served(entry: Pick<StreamEntry, 'door' | 'channel'>): boolean {
  switch (entry.door) {
    case 'market':
      return parseChannel(entry.channel) === entry.channel;
    case 'private':
      return parsePrivateChannel(entry.channel) === entry.channel;
    case 'drop-copy':
      return parseDropCopyChannel(entry.channel) === entry.channel;
    case 'mux': {
      const parsed = entry.channel.endsWith('.')
        ? parseMuxChannel(`${entry.channel}${MARKET}`)
        : parseMuxChannel({ ch: entry.channel, market: MARKET, interval: '1m' });
      return parsed.ok;
    }
  }
}

async function streamsFrom(withMux: boolean): Promise<readonly StreamEntry[]> {
  const source: DepthSource = {
    snapshot: async () => {
      throw new Error('not read');
    },
    markets: async () => [MARKET],
  };
  const hub = new DepthHub(source, { depthLimit: 10, highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 4, marketsRefreshMs: 0 });
  const app = Fastify({ logger: false });
  registerRoutes(app, {
    hub,
    tradeHub: new TradeHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 4, recentLimit: 10, ensureKnownMarket: () => true }),
    privateHub: new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 4, maxConnectionsPerUser: 4 }),
    source,
    depthLimit: 10,
    serviceName: 'svc-ws-test',
    upstream: 'http://matching.test',
    enabled: () => true,
    tradesBus: () => false,
    privateBus: () => false,
    // Only its presence is read by `/streams`; no request here reaches it.
    ...(withMux ? { mux: { gateway: {} as MuxGateway, tickerHub: {} as TickerHub, candleHub: {} as CandleHub } } : {}),
  });
  const res = await app.inject({ method: 'GET', url: '/streams' });
  await app.close();
  expect(res.statusCode).toBe(200);
  return (res.json() as { streams: StreamEntry[] }).streams;
}

describe('GET /streams', () => {
  it('lists every door, each channel exactly once, and every listed channel is one its door serves', async () => {
    const streams = await streamsFrom(true);
    const keys = streams.map((entry) => `${entry.door} ${entry.channel}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      'market depth',
      'market trades',
      'mux book',
      'mux trades',
      'mux ticker',
      'mux candles',
      'mux futures.mark.',
      'private orders',
      'private fills',
      'private positions',
      'drop-copy drop_copy',
    ]);
    for (const entry of streams) expect(served(entry), `${entry.door} ${entry.channel}`).toBe(true);
    expect(new Set(streams.map((entry) => `${entry.door} ${entry.path}`))).toEqual(
      new Set([`market ${STREAM_PATH}`, `mux ${STREAM_PATH}`, `private ${PRIVATE_STREAM_PATH}`, `drop-copy ${DROP_COPY_STREAM_PATH}`]),
    );
    expect(streams.filter((entry) => entry.access === 'private').map((entry) => entry.door)).toEqual([
      'private',
      'private',
      'private',
      'drop-copy',
    ]);
    expect(streams.every((entry) => entry.mounted && entry.refusal === undefined)).toBe(true);
  });

  it('lists nothing a door refuses', () => {
    for (const door of ['market', 'mux', 'private', 'drop-copy'] as const) expect(served({ door, channel: 'balance' }), door).toBe(false);
  });

  it('marks the multiplexed door down with ws.mux_idle_unset when it is not mounted, and only that door', async () => {
    const streams = await streamsFrom(false);
    expect(streams.map(({ door, channel }) => ({ door, channel }))).toEqual(
      streamInventory({ muxMounted: true }).map(({ door, channel }) => ({ door, channel })),
    );
    for (const entry of streams)
      expect([entry.door, entry.mounted, entry.refusal]).toEqual(
        entry.door === 'mux' ? ['mux', false, MUX_IDLE_UNSET] : [entry.door, true, undefined],
      );
  });
});
