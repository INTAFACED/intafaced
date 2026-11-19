import Fastify from 'fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { issueAccessToken } from '@intafaced/auth';
import { s2sFromEnv, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { createBusLifecycle } from './bus-lifecycle.js';
import { SVC_WS_OWN_ENV_KEYS } from './env.js';
import { DepthHub } from './depth/hub.js';
import { NativeL3Hub } from './depth/l3-hub.js';
import { HttpMarketRegistry, UnionMarketRegistry } from './depth/registry.js';
import { HttpDepthSource } from './depth/source.js';
import { DropCopyHub } from './drop-copy/hub.js';
import { createDropCopyWebSocketGateway } from './drop-copy/gateway.js';
import { customerOriginsFromEnv } from './customer-origin.js';
import { CandleHub } from './mux/candle-hub.js';
import { createMuxGateway, type MuxGateway } from './mux/gateway.js';
import { resolveMuxIdleMs } from './mux/idle.js';
import { HubMarketResolver } from './mux/resolver.js';
import { HttpMarketDirectory } from './mux/sources.js';
import { TickerHub } from './mux/ticker-hub.js';
import { NewConnectionWindow } from './new-connection-window.js';
import { PerIpGuard } from './per-ip.js';
import { createIdentityAuthorityClient } from './private/authority.js';
import { HttpPrivateBookPort } from './private/book.js';
import { HttpTradeCancelPort } from './private/cod-cancel.js';
import { leaseRangeFromEnv } from './private/cod.js';
import { createPrivateWebSocketGateway } from './private/gateway.js';
import { PrivateOrderHub } from './private/hub.js';
import { PositionsStream } from './private/positions-stream.js';
import { HttpFuturesMarkFeed } from './public/futures-mark.js';
import { registerRoutes } from './routes.js';
import { SBE_STATUS_PATH, SbeConsumers, registerSbeStatusDoor } from './sbe-consumers.js';
import { serviceSbeCodec } from './sbe-runtime.js';
import { registerTapeLabelDoor } from './tape-label-http.js';
import { TradeHub } from './trade/hub.js';
import { createWebSocketGateway } from './ws/gateway.js';

/**
 * The wire replay for svc-ws: every door's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden.json` holds what svc-ws answered (main 2026-11-19, as it is, bugs included) to a matrix of
 * requests on every HTTP door `index.ts` mounts (`/health`, `/ready`, `/policy`, `/streams`, `/markets`, the four
 * per-market reads, the native L3 read, the four tape-claim doors and the SBE consumer list) and to a matrix of
 * upgrades on its three socket doors (`/stream`, `/private/stream`, `/drop-copy/stream`) and an unknown path.
 *
 * The process is put together as `index.ts` puts it together, from the environment `env.ts` reads, in three set-ups:
 * `blank` (every owner value blank, every outside service unreachable), `set` (every owner value set; svc-matching and
 * svc-trade are a fixed stub holding one book with depth, one listed market with an empty book and one whose engine
 * answers 503; identity unreachable), and `off` (`set` with `WS_GATEWAY_ENABLED=false`). The stub is fixed so the
 * recording does not change with the machine. The two pollers and the bus are not started: their timing is not a wire
 * answer, and the doors are read as they answer before the first poll, as at boot.
 *
 * An HTTP answer is its status, content type and body. An upgrade answer is the refusal's status and body, or, when the
 * socket opens, the first frame (or close) within a short window. The stub's port becomes `<stub>`, an ISO time
 * `<time>`. `WIRE_REPLAY_WRITE=1` rewrites the golden file (then `prettier --write` it). Only for a change that is
 * meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden.json', import.meta.url);
/** A port nothing listens on: an outside service that is not there. */
const NOWHERE = 'http://127.0.0.1:1';
const JWT_SECRET = 'a-ws-wire-replay-jwt-secret-long-enough-0123';
const STATUS_SECRET = 'a-ws-wire-replay-status-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://app.intafaced.test';

/** svc-matching and svc-trade's public reads, fixed: BTC-USD has depth, ETH-USD is listed with no book, SOL-USD's engine is down. */
function stubUpstream(): Server {
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://stub.invalid').pathname;
    if (path === '/api/v1/markets') return json(res, 200, [{ id: 'BTC-USD' }, { id: 'ETH-USD' }, { id: 'SOL-USD' }]);
    if (path === '/markets') return json(res, 200, { markets: ['BTC-USD', 'OLD-1'] });
    if (path === '/markets/BTC-USD/depth')
      return json(res, 200, {
        marketId: 'BTC-USD',
        sequence: 10,
        bids: [
          ['100.5', '2'],
          ['100', '1'],
        ],
        asks: [['101', '3']],
      });
    if (path === '/markets/BTC-USD/depth/l3')
      return json(res, 200, {
        level: 'L3',
        bids: [{ price: '100.5', orders: [{ orderId: 'o-1', remaining: '2', sequence: 7 }] }],
        asks: [{ price: '101', orders: [{ orderId: 'o-2', remaining: '3', sequence: 8 }] }],
      });
    if (path === '/markets/ETH-USD/depth') return json(res, 404, { code: 'NoBook' });
    if (path === '/markets/ETH-USD/depth/l3') return json(res, 404, { code: 'NoBook' });
    if (path.startsWith('/markets/SOL-USD/')) return json(res, 503, { code: 'Unavailable' });
    return json(res, 404, { code: 'NotFound' });
  });
}

type SetUp = 'blank' | 'set' | 'off';

/** The environment each set-up reads. Every key svc-ws reads is named, so the machine's own environment leaks nowhere. */
function envOf(setUp: SetUp, stub: string): Record<string, string | undefined> {
  const blank: Record<string, string | undefined> = {
    MATCHING_URL: NOWHERE,
    TRADE_URL: NOWHERE,
    NATS_URL: 'nats://127.0.0.1:1',
    LOG_LEVEL: 'error',
    OTEL_ENABLED: 'false',
    S2S_AUTH_MODE: undefined,
  };
  if (setUp === 'blank') return blank;
  return {
    ...blank,
    MATCHING_URL: stub,
    TRADE_URL: stub,
    IDENTITY_URL: NOWHERE,
    IDENTITY_OWNERSHIP_SECRET: 'a-ws-wire-replay-identity-secret-long-enough',
    EDGE_ALLOWED_ORIGINS: ORIGIN,
    WS_DEPTH_LIMIT: '20',
    WS_MARKETS_LIST_LIMIT: '100',
    WS_HIGH_WATER_BYTES: '65536',
    WS_MAX_LAG_TICKS: '8',
    WS_MAX_CONNECTIONS: '100',
    WS_MAX_NEW_CONNECTIONS_PER_MINUTE: '1000',
    WS_PER_IP_MAX_CONNECTIONS: '100',
    WS_PER_IP_STORMS_BEFORE_BAN: '50',
    WS_PER_IP_BAN_SECONDS: '60',
    WS_PRIVATE_MAX_CONNECTIONS_PER_USER: '5',
    WS_TRADE_RECENT_LIMIT: '50',
    WS_STATUS_READ_SECRET: STATUS_SECRET,
    JWT_ACCESS_SECRET: JWT_SECRET,
    WS_DROP_COPY_RECENT_LIMIT: '50',
    WS_MUX_MAX_SUBSCRIPTIONS: '10',
    WS_MUX_MAX_OPS_PER_SECOND: '20',
    WS_MUX_MAX_SEATS: '50',
    WS_MUX_IDLE_MS: '60000',
    WS_MARK_FRESHNESS_SECONDS: '30',
    WS_COD_MIN_LEASE_MS: '1000',
    WS_COD_MAX_LEASE_MS: '60000',
    WS_GATEWAY_ENABLED: setUp === 'off' ? 'false' : 'true',
  };
}

/** svc-ws put together as `index.ts` puts it together, minus telemetry, the pollers and the bus connection. */
async function build(setUp: SetUp, stub: string) {
  // `env.ts` reads the environment once, on import: blank every key it owns, set this set-up's, and import it afresh.
  for (const key of SVC_WS_OWN_ENV_KEYS) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(envOf(setUp, stub))) vi.stubEnv(key, value);
  vi.resetModules();
  const e = (await import('./env.js')).env;

  const source = new HttpDepthSource({ baseUrl: e.MATCHING_URL });
  const sbe = serviceSbeCodec(e.INTAFACED_SBE_JAVA);
  const app = Fastify({ logger: false });
  const registry = new UnionMarketRegistry(
    [
      { name: 'svc-trade', registry: new HttpMarketRegistry({ baseUrl: e.TRADE_URL, marketsLimit: e.WS_MARKETS_LIST_LIMIT }) },
      { name: 'svc-matching', registry: source },
    ],
    app.log,
  );
  const positionsStream = new PositionsStream();
  const privateOrderHub = new PrivateOrderHub(
    {
      highWaterBytes: e.WS_HIGH_WATER_BYTES,
      maxLagTicks: e.WS_MAX_LAG_TICKS,
      maxConnections: e.WS_MAX_CONNECTIONS,
      maxConnectionsPerUser: e.WS_PRIVATE_MAX_CONNECTIONS_PER_USER,
    },
    app.log,
  );
  const dropCopyHub = new DropCopyHub(
    {
      highWaterBytes: e.WS_HIGH_WATER_BYTES,
      maxLagTicks: e.WS_MAX_LAG_TICKS,
      maxConnections: e.WS_MAX_CONNECTIONS,
      maxConnectionsPerUser: e.WS_PRIVATE_MAX_CONNECTIONS_PER_USER,
      recentLimit: e.WS_DROP_COPY_RECENT_LIMIT,
    },
    app.log,
  );
  const hub = new DepthHub(
    source,
    {
      depthLimit: e.WS_DEPTH_LIMIT,
      highWaterBytes: e.WS_HIGH_WATER_BYTES,
      maxLagTicks: e.WS_MAX_LAG_TICKS,
      maxConnections: e.WS_MAX_CONNECTIONS,
      muxMaxConnections: e.WS_MUX_MAX_SEATS,
      marketsRefreshMs: e.WS_MARKETS_REFRESH_MS,
      registry,
      onMatchingAvailabilityChange: (available) => {
        if (available) privateOrderHub.noteEngineUp();
        else privateOrderHub.markEngineUnavailable();
      },
      onMatchingTradingChange: (marketId, code, confirmedOpen) => {
        privateOrderHub.noteMatchingTrading(marketId, code, confirmedOpen);
      },
    },
    app.log,
  );
  const l3Hub = new NativeL3Hub(
    source,
    {
      depthLimit: e.WS_DEPTH_LIMIT,
      highWaterBytes: e.WS_HIGH_WATER_BYTES,
      maxLagTicks: e.WS_MAX_LAG_TICKS,
      maxConnections: e.WS_MAX_CONNECTIONS,
      ensureKnownMarket: (marketId) => hub.ensureKnownMarket(marketId),
    },
    app.log,
  );
  const tradeHub = new TradeHub(
    {
      highWaterBytes: e.WS_HIGH_WATER_BYTES,
      maxLagTicks: e.WS_MAX_LAG_TICKS,
      maxConnections: e.WS_MAX_CONNECTIONS,
      muxMaxConnections: e.WS_MUX_MAX_SEATS,
      recentLimit: e.WS_TRADE_RECENT_LIMIT,
      ensureKnownMarket: (marketId) => hub.ensureKnownMarket(marketId),
    },
    app.log,
  );
  const marketDirectory = new HttpMarketDirectory({
    baseUrl: e.TRADE_URL,
    marketsLimit: e.WS_MARKETS_LIST_LIMIT,
    ttlMs: e.WS_MARKETS_REFRESH_MS,
    log: app.log,
  });
  // Feed hubs with no poller behind them: a demand is a no-op here, as before the first poll.
  const tickerHub = new TickerHub(
    {
      highWaterBytes: e.WS_HIGH_WATER_BYTES,
      maxLagTicks: e.WS_MAX_LAG_TICKS,
      maxConnections: e.WS_MUX_MAX_SEATS,
      throttleMs: e.WS_TICKER_THROTTLE_MS,
      onDemand: () => undefined,
    },
    app.log,
  );
  const candleHub = new CandleHub(
    {
      highWaterBytes: e.WS_HIGH_WATER_BYTES,
      maxLagTicks: e.WS_MAX_LAG_TICKS,
      maxConnections: e.WS_MUX_MAX_SEATS,
      retainMs: e.WS_CANDLE_POLL_MS,
      onDemand: () => undefined,
    },
    app.log,
  );
  const muxIdleMs = resolveMuxIdleMs(e.WS_MUX_IDLE_MS, undefined);
  let muxGateway: MuxGateway | null = null;
  if (muxIdleMs !== undefined) {
    muxGateway = createMuxGateway({
      session: {
        depth: hub,
        trades: tradeHub,
        tickers: tickerHub,
        candles: candleHub,
        resolver: new HubMarketResolver(hub, marketDirectory),
        maxSubscriptions: e.WS_MUX_MAX_SUBSCRIPTIONS,
        maxOpsPerSecond: e.WS_MUX_MAX_OPS_PER_SECOND,
        highWaterBytes: e.WS_HIGH_WATER_BYTES,
        idleMs: muxIdleMs,
        log: app.log,
        markFeed: new HttpFuturesMarkFeed({ baseUrl: e.TRADE_URL }),
        markFreshnessSeconds: e.WS_MARK_FRESHNESS_SECONDS,
      },
      maxConnections: e.WS_MAX_CONNECTIONS,
      heartbeatMs: e.WS_HEARTBEAT_MS,
      log: app.log,
    });
  }
  const privateTokens =
    e.JWT_ACCESS_SECRET === undefined
      ? null
      : { secret: e.JWT_ACCESS_SECRET, issuer: e.JWT_ISSUER, audience: e.JWT_AUDIENCE, accessTtlSeconds: 900 };
  const s2s = s2sFromEnv(e, 'svc-ws');
  const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
  const authority = (() => {
    if (!e.IDENTITY_URL || !e.IDENTITY_OWNERSHIP_SECRET) return null;
    try {
      return createIdentityAuthorityClient({
        baseUrl: e.IDENTITY_URL,
        secret: e.IDENTITY_OWNERSHIP_SECRET,
        ...(s2sKey ? { s2s: s2sKey } : {}),
      });
    } catch {
      return null;
    }
  })();
  const enabled = e.WS_GATEWAY_ENABLED;
  const isEnabled = () => enabled;
  // Never started: the bus is down, as when NATS is not reachable yet.
  const busLifecycle = createBusLifecycle({
    log: app.log,
    attempt: async () => {
      throw new Error('the wire replay starts no bus');
    },
  });
  const perIp = new PerIpGuard({
    maxConnections: e.WS_PER_IP_MAX_CONNECTIONS,
    stormsBeforeBan: e.WS_PER_IP_STORMS_BEFORE_BAN,
    banSeconds: e.WS_PER_IP_BAN_SECONDS,
  });
  registerRoutes(app, {
    perIpPolicy: () => perIp.view(),
    hub,
    l3Hub,
    tradeHub,
    privateHub: privateOrderHub,
    dropCopyHub,
    ...(muxGateway ? { mux: { gateway: muxGateway, tickerHub, candleHub } } : {}),
    source,
    depthLimit: e.WS_DEPTH_LIMIT,
    serviceName: e.SERVICE_NAME,
    upstream: e.MATCHING_URL,
    enabled: isEnabled,
    tradesBus: busLifecycle.tradesBus,
    privateBus: busLifecycle.privateBus,
    privateAuthorityConfigured: () => authority !== null,
    dropCopyBus: busLifecycle.dropCopyBus,
    pollMs: e.WS_POLL_INTERVAL_MS,
    timing: { heartbeatMs: e.WS_HEARTBEAT_MS, muxIdleMs },
    sbe,
  });
  registerTapeLabelDoor(app);
  const sbeConsumers = new SbeConsumers();
  registerSbeStatusDoor(app, {
    consumers: sbeConsumers,
    secret: e.WS_STATUS_READ_SECRET,
    verifier: s2s.serviceVerifier,
    mode: s2s.s2sMode,
    codecLinked: () => sbe.linked,
    now: () => new Date('2026-11-19T00:00:00Z'),
  });
  await hub.refreshMarkets().catch(() => undefined);
  await app.listen({ host: '127.0.0.1', port: 0 });

  const newConnections = new NewConnectionWindow(e.WS_MAX_NEW_CONNECTIONS_PER_MINUTE);
  const gateway = createWebSocketGateway({
    server: app.server,
    hub,
    tradeHub,
    l3Hub,
    ...(muxGateway ? { mux: muxGateway } : {}),
    heartbeatMs: e.WS_HEARTBEAT_MS,
    log: app.log,
    enabled: isEnabled,
    admitNewConnection: () => newConnections.admit(),
    admitAddress: (address) => perIp.admit(address),
    sbeConsumers,
    sbe,
  });
  const customerOrigins = customerOriginsFromEnv(e);
  const privateGateway = createPrivateWebSocketGateway({
    server: app.server,
    hub: privateOrderHub,
    heartbeatMs: e.WS_HEARTBEAT_MS,
    log: app.log,
    enabled: isEnabled,
    tokens: privateTokens,
    busAttached: busLifecycle.privateBus,
    book: new HttpPrivateBookPort({ baseUrl: e.TRADE_URL }),
    codRange: leaseRangeFromEnv(e.WS_COD_MIN_LEASE_MS, e.WS_COD_MAX_LEASE_MS),
    tradeCancel: new HttpTradeCancelPort({ baseUrl: e.TRADE_URL }),
    authority,
    customerOrigins,
    positions: positionsStream,
  });
  const dropCopyGateway = createDropCopyWebSocketGateway({
    server: app.server,
    hub: dropCopyHub,
    heartbeatMs: e.WS_HEARTBEAT_MS,
    log: app.log,
    enabled: isEnabled,
    tokens: privateTokens,
    authority,
    customerOrigins,
  });
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    base: `127.0.0.1:${port}`,
    close: async () => {
      await gateway.close('replay over');
      await privateGateway.close('replay over');
      await dropCopyGateway.close('replay over');
      await app.close();
    },
  };
}

/** Every HTTP door, each with the inputs that reach its different answers. */
const MARKETS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'NOPE-1', 'bad id!'];
const FEED_QUERIES = ['', '?format=sbe', '?level=l3', '?level=4&format=sbe', '?transport=push', '?channel=queue_probability'];
const HTTP: ReadonlyArray<{
  name: string;
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
  status?: 'none' | 'edge' | 'trade' | 'bad';
}> = [
  { name: 'health', method: 'GET', url: '/health' },
  { name: 'ready', method: 'GET', url: '/ready' },
  { name: 'policy', method: 'GET', url: '/policy' },
  { name: 'streams', method: 'GET', url: '/streams' },
  { name: 'markets', method: 'GET', url: '/markets' },
  { name: 'unknown', method: 'GET', url: '/nope' },
  ...MARKETS.flatMap((m) =>
    FEED_QUERIES.map((q) => ({ name: `depth ${m}${q}`, method: 'GET' as const, url: `/markets/${encodeURIComponent(m)}/depth${q}` })),
  ),
  ...MARKETS.flatMap((m) =>
    ['', '?format=sbe', '?channel=queue_probability'].map((q) => ({
      name: `l3 ${m}${q}`,
      method: 'GET' as const,
      url: `/markets/${encodeURIComponent(m)}/depth/l3${q}`,
    })),
  ),
  ...MARKETS.flatMap((m) =>
    ['', '?format=sbe', '?level=l3'].map((q) => ({
      name: `trades ${m}${q}`,
      method: 'GET' as const,
      url: `/markets/${encodeURIComponent(m)}/trades${q}`,
    })),
  ),
  ...MARKETS.map((m) => ({ name: `orders ${m}`, method: 'GET' as const, url: `/markets/${encodeURIComponent(m)}/orders` })),
  ...MARKETS.map((m) => ({ name: `positions ${m}`, method: 'GET' as const, url: `/markets/${encodeURIComponent(m)}/positions` })),
  ...['/ws/tape/label-claim', '/ws/tape/origin-claim', '/ws/tape/connected-claim', '/ws/tape/instrument-map'].flatMap((url) => [
    { name: `${url} absent`, method: 'POST' as const, url },
    { name: `${url} empty`, method: 'POST' as const, url, body: {} },
    { name: `${url} wrong-type`, method: 'POST' as const, url, body: 7 },
    {
      name: `${url} claims`,
      method: 'POST' as const,
      url,
      body: {
        tradesBus: true,
        privateBus: true,
        listedMarketId: 'BTC-USD',
        adapterMarketId: 'BTCUSDT',
        remap: true,
        book: 'L3',
        as: 'maker',
        channel: 'trades',
      },
    },
    { name: `${url} plain`, method: 'POST' as const, url, body: { listedMarketId: 'BTC-USD' } },
  ]),
  { name: 'sbe-status unsigned', method: 'GET', url: SBE_STATUS_PATH, status: 'none' },
  { name: 'sbe-status edge', method: 'GET', url: SBE_STATUS_PATH, status: 'edge' },
  { name: 'sbe-status trade', method: 'GET', url: SBE_STATUS_PATH, status: 'trade' },
  { name: 'sbe-status wrong-key', method: 'GET', url: SBE_STATUS_PATH, status: 'bad' },
];

function statusHeaders(who: 'none' | 'edge' | 'trade' | 'bad' | undefined): Record<string, string> {
  if (who === undefined || who === 'none') return {};
  if (who === 'edge') return serviceAuthHeadersForBody('svc-edge', STATUS_SECRET, '');
  if (who === 'trade') return serviceAuthHeadersForBody('svc-trade', STATUS_SECRET, '');
  return serviceAuthHeadersForBody('svc-edge', 'w'.repeat(40), '');
}

type Answer = { status: number; type?: string; body: string };

function scrub(text: string, stub: string): string {
  return text.replaceAll(stub, '<stub>').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>');
}

/** The upgrades: each socket door, with the asks that reach its different answers. */
async function token(): Promise<string> {
  const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'] }, {
    secret: JWT_SECRET,
    issuer: 'intafaced',
    audience: 'intafaced.api',
    accessTtlSeconds: 900,
  } as never);
  return token;
}

const UPGRADES: ReadonlyArray<{ name: string; path: string; origin?: boolean; bearer?: boolean }> = [
  { name: 'unknown path', path: '/nope' },
  { name: 'stream mux', path: '/stream' },
  { name: 'stream empty market', path: '/stream?market=' },
  { name: 'stream bad market', path: '/stream?market=bad%20id!' },
  { name: 'stream unlisted', path: '/stream?market=NOPE-1' },
  { name: 'stream BTC depth', path: '/stream?market=BTC-USD' },
  { name: 'stream ETH depth', path: '/stream?market=ETH-USD' },
  { name: 'stream BTC trades', path: '/stream?market=BTC-USD&channel=trades' },
  { name: 'stream BTC unknown channel', path: '/stream?market=BTC-USD&channel=nope' },
  { name: 'stream BTC sbe', path: '/stream?market=BTC-USD&format=sbe' },
  { name: 'stream BTC l3', path: '/stream?market=BTC-USD&level=l3' },
  { name: 'stream BTC push', path: '/stream?market=BTC-USD&transport=push' },
  { name: 'stream BTC queue-probability', path: '/stream?market=BTC-USD&channel=queue_probability' },
  { name: 'private no token', path: '/private/stream', origin: true },
  { name: 'private foreign origin', path: '/private/stream' },
  { name: 'private token', path: '/private/stream', origin: true, bearer: true },
  { name: 'private sbe', path: '/private/stream?format=sbe', origin: true, bearer: true },
  { name: 'drop-copy no token', path: '/drop-copy/stream', origin: true },
  { name: 'drop-copy token', path: '/drop-copy/stream', origin: true, bearer: true },
  { name: 'drop-copy orders', path: '/drop-copy/stream?channel=orders', origin: true, bearer: true },
];

function upgrade(base: string, u: (typeof UPGRADES)[number], bearer: string): Promise<Answer> {
  // oxlint-disable-next-line garden/no-real-clock-wait-in-tests -- an open socket that sends nothing is itself the recorded answer: the window proves no first frame
  return new Promise((resolve) => {
    const headers: Record<string, string> = { origin: u.origin ? ORIGIN : 'https://elsewhere.test' };
    if (u.bearer) headers.authorization = `Bearer ${bearer}`;
    const ws = new WebSocket(`ws://${base}${u.path}`, { headers });
    let done = false;
    const finish = (a: Answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.terminate();
      resolve(a);
    };
    const timer = setTimeout(() => finish({ status: 101, body: '<no frame within the window>' }), 1_500);
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => finish({ status: res.statusCode ?? 0, body }));
      res.on('error', () => finish({ status: res.statusCode ?? 0, body }));
    });
    ws.on('message', (data, isBinary) =>
      finish({ status: 101, body: isBinary ? `<binary ${Buffer.from(data as Buffer).toString('hex')}>` : data.toString() }),
    );
    ws.on('close', (code, reason) => finish({ status: 101, body: `<close ${code} ${reason.toString()}>` }));
    ws.on('error', (err) => finish({ status: 0, body: `<error ${err.message}>` }));
  });
}

async function replay(stubUrl: string): Promise<Record<string, Answer>> {
  const answers: Record<string, Answer> = {};
  const bearer = await token();
  for (const setUp of ['blank', 'set', 'off'] as const) {
    const svc = await build(setUp, stubUrl);
    try {
      for (const r of HTTP) {
        const res = await svc.app.inject({
          method: r.method,
          url: r.url,
          headers: { ...statusHeaders(r.status), ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
        });
        const type = res.headers['content-type'];
        answers[`${setUp} http ${r.name}`] = {
          status: res.statusCode,
          ...(typeof type === 'string' ? { type } : {}),
          body: type === 'application/octet-stream' ? `<binary ${res.rawPayload.toString('hex')}>` : scrub(res.body, stubUrl),
        };
      }
      for (const u of UPGRADES) {
        const a = await upgrade(svc.base, u, bearer);
        answers[`${setUp} socket ${u.name}`] = { ...a, body: scrub(a.body, stubUrl).replaceAll(svc.base, '<self>') };
      }
    } finally {
      await svc.close();
    }
  }
  return answers;
}

let stub: Server;
let stubUrl: string;

beforeAll(async () => {
  stub = stubUpstream();
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

describe('the wire replay: svc-ws answers as main did before anyone moved its doors', () => {
  it('every request and upgrade in the matrix gets the recorded answer, byte for byte', async () => {
    const now = await replay(stubUrl);
    if (process.env.WIRE_REPLAY_WRITE === '1') writeFileSync(GOLDEN, `${JSON.stringify({ answers: now }, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { answers: Record<string, Answer> };
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden.answers).sort());
    const diffs = Object.entries(golden.answers)
      .filter(([key, was]) => JSON.stringify(now[key]) !== JSON.stringify(was))
      .map(([key, was]) => `${key}: ${JSON.stringify(was).slice(0, 200)} != ${JSON.stringify(now[key]).slice(0, 200)}`);
    expect(diffs).toEqual([]);
  }, 180_000);
});
