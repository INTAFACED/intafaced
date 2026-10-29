import type { FastifyInstance, FastifyReply } from 'fastify';
import { sbeCodec, type SbeCodec } from '@intafaced/sbe-codec';
import { DEPTH_ENGINE_UNAVAILABLE, snapshotHasRestingDepth, toSnapshot, type DepthHub } from './depth/hub.js';
import type { NativeL3Hub } from './depth/l3-hub.js';
import { DepthL3UnavailableError, DepthNoBookError, DepthSourceError, type DepthSource } from './depth/source.js';
import type { TradeHub } from './trade/hub.js';
import type { CandleHub } from './mux/candle-hub.js';
import type { MuxGateway } from './mux/gateway.js';
import type { TickerHub } from './mux/ticker-hub.js';
import type { DropCopyHub } from './drop-copy/hub.js';
import type { PrivateOrderHub } from './private/hub.js';
import { withWsSpan } from './tracing.js';
import { streamInventory } from './stream-inventory.js';
import {
  DEPTH_L3_UNAVAILABLE,
  DEPTH_SBE_UNAVAILABLE,
  DEPTH_TRANSPORT_POLL,
  MARKET_DATA_FEED_REFUSE_HTTP,
  TRADES_TRANSPORT_PUSH,
  describeGatewayPolicy,
  isNativeL3Ask,
  isPublicSbeL2Ask,
  marketDataFeedRefuse,
  marketDataFeedRefusePayload,
  sbeL2EntitlementRefuse,
} from './gateway-policy.js';
import { concatenatePayloads, encodeL2Snapshot } from './sbe-l2-tape.js';
import {
  isPublishedDepthLimit,
  nativeL3HasRestingDepth,
  windowDepthSnapshot,
  windowNativeL3Queue,
  WS_DEPTH_LIMIT_UNSET,
} from './depth-limit.js';
import { snapshotIsCrossed } from './depth/crossed.js';
import { isPublishedTradeRecentLimit, WS_TRADE_RECENT_LIMIT_UNSET } from './trade-recent-limit.js';

/**
 * The HTTP half of the gateway.
 *
 * ── Why there is an HTTP snapshot at all ────────────────────────────────────
 *
 * `DepthController` (apps/web) resnapshots on a gap, and it must be able to do
 * that WITHOUT tearing down the socket — a reconnect would lose the deltas that
 * arrive during it, which is the bug the controller's buffer exists to prevent.
 * So the snapshot is a plain GET, served from the same book the deltas are
 * diffed against, and the two therefore cannot disagree.
 *
 * The alternative — a "resnapshot please" verb on the socket — would mean
 * parsing inbound frames on an unauthenticated public port. That is a bigger
 * surface than one GET.
 *
 * ── CORS ────────────────────────────────────────────────────────────────────
 *
 * `Access-Control-Allow-Origin: *` on this route, with no
 * `Allow-Credentials`. The browser reaches this service directly (svc-edge
 * buffers and cannot proxy the socket, so putting the snapshot behind the edge
 * and the stream beside it would split one feed across two origins). A wildcard
 * is correct precisely because the response carries nothing about the caller:
 * there is no cookie, no token, and no per-caller content, so "any origin may
 * read this" is a true statement rather than a relaxation. `*` also makes the
 * browser refuse to send credentials, which is the behaviour we want.
 *
 * ── Bus truth on /ready and /health ─────────────────────────────────────────
 *
 * Depth polls matching and does not need NATS. Trade tape and private streams
 * do. A failed bus subscribe leaves /ready green with `tradesBus` /
 * `privateBus` false while the lifecycle retries with backoff — depth still
 * works and remains the primary product surface for LB rotation.
 */

/** Same bound as the socket's. The hub does the authoritative check. */
const MARKET_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function queryOf(url: string | undefined): URLSearchParams {
  const q = (url ?? '').indexOf('?');
  return q === -1 ? new URLSearchParams() : new URLSearchParams(url!.slice(q + 1));
}

export interface RouteOptions {
  readonly hub: DepthHub;
  readonly l3Hub?: NativeL3Hub;
  readonly tradeHub: TradeHub;
  readonly privateHub: PrivateOrderHub;
  readonly dropCopyHub?: DropCopyHub;
  readonly source: DepthSource;
  readonly depthLimit: number | undefined;
  readonly serviceName: string;
  readonly upstream: string;
  readonly enabled: () => boolean;
  /** Live JetStream subscription for public `orderFilled` tape (`tradeSub !== null`). */
  readonly tradesBus: () => boolean;
  /** Live JetStream subscription for private lifecycle (`privateSub !== null`). */
  readonly privateBus: () => boolean;
  /** Configuration only; every private seat obtains its own live authority. */
  readonly privateAuthorityConfigured?: () => boolean;
  /** Live JetStream subscription for drop-copy executions (independent durable). */
  readonly dropCopyBus?: () => boolean;
  /** Real Logic SBE 1.39.0 adapter. Tests inject; production uses the package singleton. */
  readonly sbe?: SbeCodec;
  /** Matching HTTP poll cadence. Named on /health /ready so poll is not sold as push. */
  readonly pollMs?: number;
  /** The multiplexed door and its two feed hubs. Omit = not mounted; `/health` says nothing about it. */
  readonly mux?: { readonly gateway: MuxGateway; readonly tickerHub: TickerHub; readonly candleHub: CandleHub };
}

function sendL2Sbe(
  reply: FastifyReply,
  codec: SbeCodec,
  snap: {
    marketId: string;
    sequence: number | string;
    bids: readonly (readonly [string, string])[];
    asks: readonly (readonly [string, string])[];
  },
) {
  if (!codec.linked) {
    return reply.code(MARKET_DATA_FEED_REFUSE_HTTP).send(marketDataFeedRefusePayload(DEPTH_SBE_UNAVAILABLE));
  }
  const encoded = encodeL2Snapshot(codec, snap);
  if (!encoded.ok) {
    return reply.code(MARKET_DATA_FEED_REFUSE_HTTP).send({
      type: 'status',
      code: encoded.reason,
      message: encoded.message,
    });
  }
  reply.header('content-type', 'application/octet-stream');
  reply.header('x-intafaced-book', 'L2');
  reply.header('x-intafaced-template', 'DepthLevel');
  return reply.code(200).send(concatenatePayloads(encoded.payloads));
}

export function registerRoutes(app: FastifyInstance, options: RouteOptions): void {
  const {
    hub,
    l3Hub,
    tradeHub,
    privateHub,
    dropCopyHub,
    source,
    depthLimit,
    serviceName,
    upstream,
    enabled,
    tradesBus,
    privateBus,
    dropCopyBus = () => false,
    sbe = sbeCodec,
    pollMs = 250,
    mux,
  } = options;

  app.get('/health', async () => ({
    ok: true,
    service: serviceName,
    enabled: enabled(),
    connections:
      hub.connections + (l3Hub?.connections ?? 0) + tradeHub.connections + privateHub.connections + (dropCopyHub?.connections ?? 0),
    depthConnections: hub.connections,
    l3Connections: l3Hub?.connections ?? 0,
    tradeConnections: tradeHub.connections,
    privateConnections: privateHub.connections,
    dropCopyConnections: dropCopyHub?.connections ?? 0,
    tradesBus: tradesBus(),
    privateBus: privateBus(),
    privateAuthorityConfigured: options.privateAuthorityConfigured?.() ?? false,
    dropCopyBus: dropCopyBus(),
    depthTransport: DEPTH_TRANSPORT_POLL,
    l3Transport: DEPTH_TRANSPORT_POLL,
    tradesTransport: TRADES_TRANSPORT_PUSH,
    privateTransport: TRADES_TRANSPORT_PUSH,
    dropCopyTransport: TRADES_TRANSPORT_PUSH,
    pollMs,
    /**
     * Per-hub ceilings. Summing them is NOT a process-wide cap — each hub
     * refuses at its own max (1013). Occupancy never 503s this probe.
     */
    capacity: {
      // Original-door seats only. Multiplexed seats are a separate pool (`mux` below).
      depth: { connections: hub.connections - hub.muxConnections, maxConnections: hub.maxConnections ?? null },
      trades: { connections: tradeHub.connections - tradeHub.muxConnections, maxConnections: tradeHub.maxConnections ?? null },
      private: {
        connections: privateHub.connections,
        maxConnections: privateHub.maxConnections ?? null,
        maxConnectionsPerUser: privateHub.maxConnectionsPerUser ?? null,
      },
      dropCopy: {
        connections: dropCopyHub?.connections ?? 0,
        maxConnections: dropCopyHub?.maxConnections ?? null,
        maxConnectionsPerUser: dropCopyHub?.maxConnectionsPerUser ?? null,
      },
      ...(mux
        ? {
            mux: {
              connections: mux.gateway.connections,
              maxConnections: mux.gateway.maxConnections ?? null,
              subscriptions: mux.gateway.subscriptions,
              seats: {
                depth: { used: hub.muxConnections, max: hub.muxMaxConnections ?? null },
                trades: { used: tradeHub.muxConnections, max: tradeHub.muxMaxConnections ?? null },
                tickers: { used: mux.tickerHub.connections, max: mux.tickerHub.maxConnections ?? null },
                candles: { used: mux.candleHub.connections, max: mux.candleHub.maxConnections ?? null },
              },
              tickers: mux.tickerHub.stats,
              candles: mux.candleHub.stats,
            },
          }
        : {}),
    },
  }));

  /**
   * Readiness is stricter than liveness, as everywhere else in the fleet: the
   * process can be perfectly alive while the kill-switch is off, and a load
   * balancer should stop sending it connections without anyone paging.
   *
   * Bus down ≠ not ready. Depth is the primary surface and works without NATS.
   * `tradesBus` / `privateBus` tell ops the tape/private fan-out is empty.
   */
  app.get('/ready', async (_req, reply) => {
    if (!enabled()) return reply.code(503).send({ ready: false, reason: 'ws.gateway flag is off' });
    return {
      ready: true,
      upstream,
      depthLimit: depthLimit ?? null,
      markets: hub.knownMarkets,
      depth: hub.stats,
      l3: l3Hub?.stats ?? { connections: 0, code: null },
      trades: tradeHub.stats,
      privateConnections: privateHub.connections,
      private: privateHub.stats,
      dropCopyConnections: dropCopyHub?.connections ?? 0,
      dropCopy: dropCopyHub?.stats ?? {
        connections: 0,
        executions: 0,
        droppedFrames: 0,
        evictions: 0,
        bus: false,
        replayDurable: false as const,
      },
      tradesBus: tradesBus(),
      privateBus: privateBus(),
      privateAuthorityConfigured: options.privateAuthorityConfigured?.() ?? false,
      dropCopyBus: dropCopyBus(),
      depthTransport: DEPTH_TRANSPORT_POLL,
      l3Transport: DEPTH_TRANSPORT_POLL,
      tradesTransport: TRADES_TRANSPORT_PUSH,
      privateTransport: TRADES_TRANSPORT_PUSH,
      dropCopyTransport: TRADES_TRANSPORT_PUSH,
      pollMs,
    };
  });

  app.get('/policy', async () => describeGatewayPolicy());

  /** Every channel this process serves, from the lists its doors parse (`stream-inventory.ts`). */
  app.get('/streams', async () => ({ streams: streamInventory({ muxMounted: options.mux !== undefined }) }));

  async function sendNativeL3(
    marketId: string,
    req: { log: { error(obj: Record<string, unknown>, msg: string): void } },
    reply: FastifyReply,
  ) {
    try {
      // Same door as L2 depth: a thrown lookup is engine-down (502), a false
      // return is an unlisted market (404). Outside this try the rejection
      // escapes as a generic 500.
      if (!(await hub.ensureKnownMarket(marketId))) {
        return reply.code(404).send({ code: 'MarketNotFound', message: `"${marketId}" is not a listed market` });
      }
      if (typeof source.l3Queue !== 'function') {
        return reply.code(MARKET_DATA_FEED_REFUSE_HTTP).send(marketDataFeedRefusePayload(DEPTH_L3_UNAVAILABLE));
      }
      if (!isPublishedDepthLimit(depthLimit)) {
        return reply.code(503).send({
          code: WS_DEPTH_LIMIT_UNSET,
          message: 'WS_DEPTH_LIMIT unpublished',
        });
      }
      const queue = await withWsSpan('ws.depth.l3', { marketId }, () => source.l3Queue!(marketId, depthLimit));
      const windowed = windowNativeL3Queue(queue, depthLimit);
      if (!nativeL3HasRestingDepth(windowed)) {
        return reply.code(404).send({ code: 'NoBook', message: `"${marketId}": matching holds no book` });
      }
      return reply.code(200).send({ ...windowed, type: 'snapshot', transport: DEPTH_TRANSPORT_POLL });
    } catch (err) {
      if (err instanceof DepthL3UnavailableError) {
        return reply.code(MARKET_DATA_FEED_REFUSE_HTTP).send(marketDataFeedRefusePayload(DEPTH_L3_UNAVAILABLE));
      }
      if (err instanceof DepthNoBookError) {
        return reply.code(404).send({ code: 'NoBook', message: err.message });
      }
      const message = err instanceof DepthSourceError ? err.message : 'l3 unavailable';
      req.log.error({ err, marketId }, 'ws: native L3 snapshot failed');
      return reply.code(502).send({ code: DEPTH_ENGINE_UNAVAILABLE, message });
    }
  }

  app.get('/markets/:marketId/depth/l3', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');
    if (!enabled()) return reply.code(503).send({ code: 'Unavailable', message: 'ws.gateway flag is off' });
    const { marketId } = req.params as { marketId: string };
    if (!MARKET_ID.test(marketId)) {
      return reply.code(400).send({ code: 'BadRequest', message: 'market id must be 1-64 chars of [A-Za-z0-9._:-]' });
    }
    const feedRefuse = marketDataFeedRefuse(queryOf(req.url), { allowPublicSbeL2: true, allowNativeL3: true });
    if (feedRefuse) {
      return reply.code(MARKET_DATA_FEED_REFUSE_HTTP).send(marketDataFeedRefusePayload(feedRefuse));
    }
    return sendNativeL3(marketId, req, reply);
  });

  app.get('/markets/:marketId/depth', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');

    if (!enabled()) return reply.code(503).send({ code: 'Unavailable', message: 'ws.gateway flag is off' });

    const query = queryOf(req.url);
    const feedRefuse = marketDataFeedRefuse(query, { allowPublicSbeL2: true, allowNativeL3: true });
    if (feedRefuse) {
      return reply.code(MARKET_DATA_FEED_REFUSE_HTTP).send(marketDataFeedRefusePayload(feedRefuse));
    }
    if (isNativeL3Ask(query)) {
      const { marketId } = req.params as { marketId: string };
      if (!MARKET_ID.test(marketId)) {
        return reply.code(400).send({ code: 'BadRequest', message: 'market id must be 1-64 chars of [A-Za-z0-9._:-]' });
      }
      return sendNativeL3(marketId, req, reply);
    }
    const wantSbe = isPublicSbeL2Ask(query);
    if (wantSbe) {
      const entitlement = sbeL2EntitlementRefuse(query);
      if (entitlement) {
        return reply.code(MARKET_DATA_FEED_REFUSE_HTTP).send(marketDataFeedRefusePayload(entitlement));
      }
    }

    const { marketId } = req.params as { marketId: string };
    if (!MARKET_ID.test(marketId)) {
      return reply.code(400).send({ code: 'BadRequest', message: 'market id must be 1-64 chars of [A-Za-z0-9._:-]' });
    }

    try {
      // Checked against the LISTING before any depth call — not against the
      // engine's book list, which omits every market that has not traded yet
      // (`depth/registry.ts`). Unlisted → 404 MarketNotFound. Listed with no
      // resting depth → 404 NoBook, never a 200 with bids/asks [].
      if (!(await hub.ensureKnownMarket(marketId))) {
        return reply.code(404).send({ code: 'MarketNotFound', message: `"${marketId}" is not a listed market` });
      }

      // Prefer the hub's own book: it is the exact state every delta on the
      // socket is diffed against, so a client that fetches here and then applies
      // deltas cannot land between two versions of the truth.
      const trading = hub.matchingTrading(marketId);
      if (trading) {
        return reply.code(409).send({
          type: 'status',
          code: trading,
          marketId,
          message: `"${marketId}": matching is not taking submits`,
        });
      }

      const book = hub.bookFor(marketId);
      if (book) {
        const snap = toSnapshot(book);
        if (!snapshotHasRestingDepth(snap)) {
          return reply.code(404).send({ code: 'NoBook', message: `"${marketId}": matching holds no book` });
        }
        if (!isPublishedDepthLimit(depthLimit)) {
          return reply.code(503).send({
            code: WS_DEPTH_LIMIT_UNSET,
            message: 'WS_DEPTH_LIMIT unpublished',
          });
        }
        const windowed = windowDepthSnapshot(snap, depthLimit);
        if (snapshotIsCrossed(windowed)) {
          return reply.code(404).send({ code: 'NoBook', message: `"${marketId}": crossed book withheld` });
        }
        if (wantSbe) return sendL2Sbe(reply, sbe, windowed);
        return reply.code(200).send(windowed);
      }

      if (hub.isEngineUnavailable(marketId)) {
        return reply.code(502).send({
          code: DEPTH_ENGINE_UNAVAILABLE,
          message: `"${marketId}": matching engine unavailable`,
        });
      }

      if (!isPublishedDepthLimit(depthLimit)) {
        return reply.code(503).send({
          code: WS_DEPTH_LIMIT_UNSET,
          message: 'WS_DEPTH_LIMIT unpublished',
        });
      }
      const snapshot = await withWsSpan('ws.depth.snapshot', { marketId }, () => source.snapshot(marketId, depthLimit));
      const liveTrading = source.trading?.(marketId) ?? null;
      if (liveTrading) {
        hub.noteMatchingTrading(marketId, liveTrading);
        return reply.code(409).send({
          type: 'status',
          code: liveTrading,
          marketId,
          message: `"${marketId}": matching is not taking submits`,
        });
      }
      if (!snapshotHasRestingDepth(snapshot)) {
        return reply.code(404).send({ code: 'NoBook', message: `"${marketId}": matching holds no book` });
      }
      const windowed = windowDepthSnapshot(snapshot, depthLimit);
      if (snapshotIsCrossed(windowed)) {
        return reply.code(404).send({ code: 'NoBook', message: `"${marketId}": crossed book withheld` });
      }
      if (wantSbe) return sendL2Sbe(reply, sbe, windowed);
      return reply.code(200).send(windowed);
    } catch (err) {
      if (err instanceof DepthNoBookError) {
        return reply.code(404).send({ code: 'NoBook', message: err.message });
      }
      // 502, not 500: this service is fine, svc-matching is not, and a caller
      // needs to tell those apart before deciding whether to retry.
      const message = err instanceof DepthSourceError ? err.message : 'depth unavailable';
      req.log.error({ err, marketId }, 'ws: snapshot failed');
      return reply.code(502).send({ code: DEPTH_ENGINE_UNAVAILABLE, message });
    }
  });

  /**
   * Recent public prints for a listed market. Empty ≠ zero: a listed market
   * with no tape is `404 NoTape`, never `200 { trades: [] }`.
   */
  app.get('/markets/:marketId/trades', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');

    if (!enabled()) return reply.code(503).send({ code: 'Unavailable', message: 'ws.gateway flag is off' });

    const feedRefuse = marketDataFeedRefuse(queryOf(req.url));
    if (feedRefuse) {
      return reply.code(MARKET_DATA_FEED_REFUSE_HTTP).send(marketDataFeedRefusePayload(feedRefuse));
    }

    const { marketId } = req.params as { marketId: string };
    if (!MARKET_ID.test(marketId)) {
      return reply.code(400).send({ code: 'BadRequest', message: 'market id must be 1-64 chars of [A-Za-z0-9._:-]' });
    }

    try {
      if (!(await hub.ensureKnownMarket(marketId))) {
        return reply.code(404).send({ code: 'MarketNotFound', message: `"${marketId}" is not a listed market` });
      }

      if (!isPublishedTradeRecentLimit(tradeHub.recentLimit)) {
        return reply.code(503).send({
          code: WS_TRADE_RECENT_LIMIT_UNSET,
          message: 'WS_TRADE_RECENT_LIMIT unpublished',
        });
      }

      const trades = tradeHub.recentFor(marketId);
      if (trades.length === 0) {
        return reply.code(404).send({ code: 'NoTape', message: `"${marketId}": matching holds no prints` });
      }
      return reply.code(200).send({ marketId, trades });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'trades unavailable';
      req.log.error({ err, marketId }, 'ws: trades snapshot failed');
      return reply.code(502).send({ code: 'UpstreamUnavailable', message });
    }
  });

  /**
   * Public door has no orders blotter. Empty ≠ zero: never `200 { orders: [] }`.
   * Unknown market is `404 MarketNotFound`. Listed is `404 NoBlotter`.
   */
  app.get('/markets/:marketId/orders', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');

    if (!enabled()) return reply.code(503).send({ code: 'Unavailable', message: 'ws.gateway flag is off' });

    const { marketId } = req.params as { marketId: string };
    if (!MARKET_ID.test(marketId)) {
      return reply.code(400).send({ code: 'BadRequest', message: 'market id must be 1-64 chars of [A-Za-z0-9._:-]' });
    }

    try {
      if (!(await hub.ensureKnownMarket(marketId))) {
        return reply.code(404).send({ code: 'MarketNotFound', message: `"${marketId}" is not a listed market` });
      }
      return reply.code(404).send({ code: 'NoBlotter', message: `"${marketId}": no public orders blotter` });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'orders unavailable';
      req.log.error({ err, marketId }, 'ws: orders snapshot failed');
      return reply.code(502).send({ code: 'UpstreamUnavailable', message });
    }
  });

  /**
   * Public door has no positions blotter. Empty ≠ zero: never `200 { positions: [] }`.
   * Unknown market is `404 MarketNotFound`. Listed is `404 NoPositions`.
   */
  app.get('/markets/:marketId/positions', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');

    if (!enabled()) return reply.code(503).send({ code: 'Unavailable', message: 'ws.gateway flag is off' });

    const { marketId } = req.params as { marketId: string };
    if (!MARKET_ID.test(marketId)) {
      return reply.code(400).send({ code: 'BadRequest', message: 'market id must be 1-64 chars of [A-Za-z0-9._:-]' });
    }

    try {
      if (!(await hub.ensureKnownMarket(marketId))) {
        return reply.code(404).send({ code: 'MarketNotFound', message: `"${marketId}" is not a listed market` });
      }
      return reply.code(404).send({ code: 'NoPositions', message: `"${marketId}": no public positions blotter` });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'positions unavailable';
      req.log.error({ err, marketId }, 'ws: positions snapshot failed');
      return reply.code(502).send({ code: 'UpstreamUnavailable', message });
    }
  });

  /** The market list, so a client can discover what it may subscribe to. */
  app.get('/markets', async (_req, reply) => {
    reply.header('access-control-allow-origin', '*');
    return reply.code(200).send({ markets: hub.knownMarkets });
  });
}
