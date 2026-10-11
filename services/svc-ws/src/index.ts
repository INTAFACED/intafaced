import Fastify from 'fastify';
import { JetStreamEventBus, type Subscription } from '@intafaced/events';
import { JAVA_ENV, sbeCodec } from '@intafaced/sbe-codec';
import { env } from './env.js';
import { createBusLifecycle } from './bus-lifecycle.js';
import { DepthHub } from './depth/hub.js';
import { NativeL3Hub } from './depth/l3-hub.js';
import { DepthPoller } from './depth/poller.js';
import { HttpMarketRegistry, UnionMarketRegistry } from './depth/registry.js';
import { HttpDepthSource } from './depth/source.js';
import { registerRoutes } from './routes.js';
import { TradeHub } from './trade/hub.js';
import { subscribeTradeTape } from './trade/source.js';
import { PrivateOrderHub } from './private/hub.js';
import { tryAttachPrivate, type PrivateAttachments } from './private/source.js';
import { DropCopyHub } from './drop-copy/hub.js';
import { tryAttachDropCopy, type DropCopyAttachments } from './drop-copy/source.js';
import { WS_COPY } from './copy.js';
import { createPrivateWebSocketGateway, redactAccessTokenQuery } from './private/gateway.js';
import { createIdentityAuthorityClient } from './private/authority.js';
import { createDropCopyWebSocketGateway } from './drop-copy/gateway.js';
import { HttpPrivateBookPort } from './private/book.js';
import { leaseRangeFromEnv } from './private/cod.js';
import { HttpTradeCancelPort } from './private/cod-cancel.js';
import { createWebSocketGateway } from './ws/gateway.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { registerTapeLabelDoor } from './tape-label-http.js';

// §9 — register the TracerProvider before the first span is created.
// `@opentelemetry/api` alone is a no-op: without this call every span in
// ./tracing.ts is built, tagged and then discarded before it reaches the
// collector. Tracers grabbed at module scope resolve lazily through the proxy
// provider, so registering here still captures them.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-ws — live public market data (§5.2 ws.gateway).
 *
 * ── Why this is its own service ─────────────────────────────────────────
 *
 * The two other candidates both fail the same test.
 *
 * **svc-matching** has the book, and holds `INTERNAL_SERVICE_SECRET` because it
 * authenticates order writes. Opening a browser-facing socket there would put
 * the public internet on the same port as the engine that takes orders, and
 * would mean adding svc-matching to the edge's route table — a table whose
 * comment says in as many words that svc-matching is deliberately absent.
 *
 * **svc-trade** is already mounted and already consumes `orderFilled`, which is
 * the argument for it. But it cannot build a book from those events —
 * `intafaced.matching.order.accepted` carries no side, price or quantity — so
 * it would have to poll svc-matching exactly as this does, while holding
 * `INTERNAL_SERVICE_SECRET` for both the ledger and the engine and calling
 * `ledger.hold` on the money path. Attaching an unauthenticated public socket
 * to that process trades the entire custodial blast radius for one saved
 * container.
 *
 * No database or principal-signing key. Public depth/tape stay anonymous.
 * Private reads use identity service authentication to obtain bounded live
 * credential snapshots; this process posts no ledger transactions.
 */

const source = new HttpDepthSource({ baseUrl: env.MATCHING_URL });

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: redactAccessTokenQuery(request.url ?? ''),
          host: request.headers.host,
          remoteAddress: request.socket?.remoteAddress,
          remotePort: request.socket?.remotePort,
        };
      },
    },
  },
});

/**
 * WHAT A CLIENT MAY SUBSCRIBE TO — and why it is not the engine's list.
 *
 * Depth still comes from svc-matching and only from svc-matching. This decides
 * a different question: which market IDS are real. The engine's `/markets` is
 * the books it holds, which is neither the listing nor a subset of it once
 * `trade.markets` has been reseeded — on the running fleet the engine's ten
 * journal-replayed ids and svc-trade's sixteen listed ids did not overlap at
 * all, so every id the browser could discover was refused with `unknown
 * market`. `depth/registry.ts` has the full account.
 *
 * The listing service comes first because it is the authority; the engine stays
 * in the union because its ids are provably real and because a listing service
 * that is down must not take the whole public feed with it.
 */
const registry = new UnionMarketRegistry(
  [
    { name: 'svc-trade', registry: new HttpMarketRegistry({ baseUrl: env.TRADE_URL, marketsLimit: env.WS_MARKETS_LIST_LIMIT }) },
    { name: 'svc-matching', registry: source },
  ],
  app.log,
);

const privateOrderHub = new PrivateOrderHub(
  {
    highWaterBytes: env.WS_HIGH_WATER_BYTES,
    maxLagTicks: env.WS_MAX_LAG_TICKS,
    maxConnections: env.WS_MAX_CONNECTIONS,
    maxConnectionsPerUser: env.WS_PRIVATE_MAX_CONNECTIONS_PER_USER,
  },
  app.log,
);

const dropCopyHub = new DropCopyHub(
  {
    highWaterBytes: env.WS_HIGH_WATER_BYTES,
    maxLagTicks: env.WS_MAX_LAG_TICKS,
    maxConnections: env.WS_MAX_CONNECTIONS,
    maxConnectionsPerUser: env.WS_PRIVATE_MAX_CONNECTIONS_PER_USER,
    recentLimit: env.WS_DROP_COPY_RECENT_LIMIT,
  },
  app.log,
);

const hub = new DepthHub(
  source,
  {
    depthLimit: env.WS_DEPTH_LIMIT,
    highWaterBytes: env.WS_HIGH_WATER_BYTES,
    maxLagTicks: env.WS_MAX_LAG_TICKS,
    maxConnections: env.WS_MAX_CONNECTIONS,
    marketsRefreshMs: env.WS_MARKETS_REFRESH_MS,
    registry,
    onMatchingAvailabilityChange: (available) => {
      if (available) privateOrderHub.noteEngineUp();
      else privateOrderHub.markEngineUnavailable();
    },
    onMatchingTradingChange: (marketId, code) => {
      privateOrderHub.noteMatchingTrading(marketId, code);
    },
  },
  app.log,
);

const l3Hub = new NativeL3Hub(
  source,
  {
    depthLimit: env.WS_DEPTH_LIMIT,
    highWaterBytes: env.WS_HIGH_WATER_BYTES,
    maxLagTicks: env.WS_MAX_LAG_TICKS,
    maxConnections: env.WS_MAX_CONNECTIONS,
    ensureKnownMarket: (marketId) => hub.ensureKnownMarket(marketId),
  },
  app.log,
);

const tradeHub = new TradeHub(
  {
    highWaterBytes: env.WS_HIGH_WATER_BYTES,
    maxLagTicks: env.WS_MAX_LAG_TICKS,
    maxConnections: env.WS_MAX_CONNECTIONS,
    recentLimit: env.WS_TRADE_RECENT_LIMIT,
    ensureKnownMarket: (marketId) => hub.ensureKnownMarket(marketId),
  },
  app.log,
);

const privateTokens =
  env.JWT_ACCESS_SECRET === undefined
    ? null
    : {
        secret: env.JWT_ACCESS_SECRET,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        accessTtlSeconds: 900,
      };

// Private authority is mandatory; missing configuration leaves public feeds live.
const identityUrl = env.IDENTITY_URL;
const identityOwnershipSecret = env.IDENTITY_OWNERSHIP_SECRET;
const authority = (() => {
  if (!identityUrl || !identityOwnershipSecret) return null;
  try {
    return createIdentityAuthorityClient({ baseUrl: identityUrl, secret: identityOwnershipSecret });
  } catch {
    return null;
  }
})();

let enabled = env.WS_GATEWAY_ENABLED;
const isEnabled = () => enabled;

/**
 * Bus lifecycle — declared before routes so /ready getters can read status.
 * Connect/subscribe may fail at boot; the lifecycle retries with backoff so
 * an empty tape is temporary, not "until process restart". If the tape lands
 * and private does not, retryPrivate attaches the private half on the same
 * connection — do not tear the public print to recover orders. Drop-copy is a
 * third independent half on its own durable.
 */
const busLifecycle = createBusLifecycle({
  log: app.log,
  attempt: async () => {
    const connected = await JetStreamEventBus.connect({
      servers: env.NATS_URL,
      producer: env.SERVICE_NAME,
      streamPrefix: env.NATS_STREAM_PREFIX,
      ownedStreams: [],
    });
    let tradeSub: Subscription | null = null;
    let privateHalf: PrivateAttachments | null = null;
    let dropHalf: DropCopyAttachments | null = null;
    try {
      // Public tape first and independently. A private-half failure must not
      // tear the trade consumer — empty private is privateBus:false, not a dead tape.
      tradeSub = await subscribeTradeTape({
        bus: connected,
        hub: tradeHub,
        durable: env.WS_TRADES_DURABLE,
        log: app.log,
      });
    } catch (err) {
      await connected.close().catch(() => undefined);
      throw err;
    }

    if (privateTokens) {
      privateHalf = await tryAttachPrivate({
        bus: connected,
        hub: privateOrderHub,
        durable: env.WS_PRIVATE_ORDERS_DURABLE,
        log: app.log,
      });
      if (privateHalf) {
        privateOrderHub.announceBus(true);
      }

      dropHalf = await tryAttachDropCopy({
        bus: connected,
        hub: dropCopyHub,
        durable: env.WS_DROP_COPY_DURABLE,
        log: app.log,
      });
      if (dropHalf) {
        dropCopyHub.announceBus(true);
      }
    }

    return {
      tradesUp: tradeSub !== null,
      privateUp: privateHalf !== null,
      dropCopyUp: dropHalf !== null,
      sessionLost: connected.whenClosed(),
      retryPrivate: privateTokens
        ? async () => {
            privateHalf = await tryAttachPrivate({
              bus: connected,
              hub: privateOrderHub,
              durable: env.WS_PRIVATE_ORDERS_DURABLE,
              log: app.log,
            });
            if (privateHalf) {
              privateOrderHub.announceBus(true);
              return true;
            }
            return false;
          }
        : undefined,
      retryDropCopy: privateTokens
        ? async () => {
            dropHalf = await tryAttachDropCopy({
              bus: connected,
              hub: dropCopyHub,
              durable: env.WS_DROP_COPY_DURABLE,
              log: app.log,
            });
            if (dropHalf) {
              dropCopyHub.announceBus(true);
              return true;
            }
            return false;
          }
        : undefined,
      close: async () => {
        dropCopyHub.announceBus(false);
        await tradeSub?.unsubscribe().catch(() => undefined);
        await privateHalf?.orders.unsubscribe().catch(() => undefined);
        await privateHalf?.fills.unsubscribe().catch(() => undefined);
        await privateHalf?.positions.unsubscribe().catch(() => undefined);
        await dropHalf?.fills.unsubscribe().catch(() => undefined);
        await connected.close().catch(() => undefined);
      },
    };
  },
});

const poller = new DepthPoller(
  source,
  hub,
  {
    intervalMs: env.WS_POLL_INTERVAL_MS,
    depthLimit: env.WS_DEPTH_LIMIT,
    marketsRefreshMs: env.WS_MARKETS_REFRESH_MS,
    probePrivate: {
      connections: () => privateOrderHub.connections,
      markDown: () => privateOrderHub.markEngineUnavailable(),
      markUp: () => privateOrderHub.noteEngineUp(),
      markTrading: (marketId, code) => privateOrderHub.noteMatchingTrading(marketId, code),
    },
    l3Hub,
  },
  app.log,
);

registerRoutes(app, {
  hub,
  l3Hub,
  tradeHub,
  privateHub: privateOrderHub,
  dropCopyHub,
  source,
  depthLimit: env.WS_DEPTH_LIMIT,
  serviceName: env.SERVICE_NAME,
  upstream: env.MATCHING_URL,
  enabled: isEnabled,
  // Mutable getters: lifecycle flips these when reconnect lands.
  tradesBus: busLifecycle.tradesBus,
  privateBus: busLifecycle.privateBus,
  privateAuthorityConfigured: () => authority !== null,
  dropCopyBus: busLifecycle.dropCopyBus,
  pollMs: env.WS_POLL_INTERVAL_MS,
});
registerTapeLabelDoor(app);

/**
 * The market list is fetched before the port opens, not lazily on the first
 * connection. A subscription is refused unless the market is on it, so a
 * gateway that has never fetched it would refuse every client and look like a
 * bug in the terminal rather than a boot ordering problem.
 *
 * A failure here is not fatal: an upstream may simply be starting, and the
 * union only throws when EVERY source failed. The list refreshes on a timer and
 * a connection that misses triggers one refetch.
 */
await hub.refreshMarkets().catch((err: unknown) => {
  app.log.warn(
    { err: String(err), listing: env.TRADE_URL, engine: env.MATCHING_URL },
    'svc-ws: could not read the market list at boot — will retry on the timer',
  );
});

/**
 * Trade tape + private fan-out: start bus lifecycle (non-blocking). Depth
 * serves immediately; tape attaches when NATS is reachable, including after a
 * boot-time outage. `ownedStreams: []` — matching owns the stream.
 */
busLifecycle.start();

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });

const gateway = createWebSocketGateway({
  server: app.server,
  hub,
  tradeHub,
  l3Hub,
  heartbeatMs: env.WS_HEARTBEAT_MS,
  log: app.log,
  enabled: isEnabled,
});

const privateGateway = createPrivateWebSocketGateway({
  server: app.server,
  hub: privateOrderHub,
  heartbeatMs: env.WS_HEARTBEAT_MS,
  log: app.log,
  enabled: isEnabled,
  tokens: privateTokens,
  busAttached: busLifecycle.privateBus,
  book: new HttpPrivateBookPort({ baseUrl: env.TRADE_URL }),
  codRange: leaseRangeFromEnv(env.WS_COD_MIN_LEASE_MS, env.WS_COD_MAX_LEASE_MS),
  tradeCancel: new HttpTradeCancelPort({ baseUrl: env.TRADE_URL }),
  authority,
});

const dropCopyGateway = createDropCopyWebSocketGateway({
  server: app.server,
  hub: dropCopyHub,
  heartbeatMs: env.WS_HEARTBEAT_MS,
  log: app.log,
  enabled: isEnabled,
  tokens: privateTokens,
  authority,
});

poller.start();

app.log.info(
  {
    port: env.HTTP_PORT,
    upstream: env.MATCHING_URL,
    listing: env.TRADE_URL,
    markets: hub.knownMarkets.length,
    depthLimit: env.WS_DEPTH_LIMIT,
    pollMs: env.WS_POLL_INTERVAL_MS,
    trades: busLifecycle.tradesBus(),
    privateOrders: busLifecycle.privateBus() && privateTokens !== null && authority !== null,
    privatePositions: busLifecycle.privateBus() && privateTokens !== null && authority !== null,
    dropCopy: busLifecycle.dropCopyBus() && privateTokens !== null && authority !== null,
    enabled,
    sbeLinked: sbeCodec.linked,
    sbeJava: process.env[JAVA_ENV] ?? null,
  },
  'svc-ws ready — depth + trade tape + private orders/fills/positions + drop-copy',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      // Stop producing before closing sockets, so nothing is written to a
      // socket that is mid-close, and tell every client why it is going.
      enabled = false;
      poller.stop();
      await busLifecycle.stop();
      await gateway.close(WS_COPY.shuttingDown);
      await privateGateway.close(WS_COPY.shuttingDown);
      await dropCopyGateway.close(WS_COPY.shuttingDown);
      await app.close();
      process.exit(0);
    })();
  });
}
