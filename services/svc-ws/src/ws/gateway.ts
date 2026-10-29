import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { sbeCodec, type SbeCodec } from '@intafaced/sbe-codec';
import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_GOING_AWAY, CLOSE_POLICY, CLOSE_TRY_LATER, type DepthHub, type DepthSink, type HubLogger } from '../depth/hub.js';
import type { NativeL3Hub, NativeL3Probe } from '../depth/l3-hub.js';
import { DROP_COPY_STREAM_PATH } from '../drop-copy/gateway.js';
import {
  DEPTH_L3_UNAVAILABLE,
  DEPTH_SBE_UNAVAILABLE,
  isNativeL3Ask,
  isPublicSbeL2Ask,
  marketDataFeedRefuse,
  sbeL2EntitlementRefuse,
  writeMarketDataFeedRefuse,
} from '../gateway-policy.js';
import { isPublishedConnectionCeiling } from '../max-connections.js';
import type { MuxGateway } from '../mux/gateway.js';
import { PRIVATE_STREAM_PATH } from '../private/gateway.js';
import { encodeL2JsonFrame } from '../sbe-l2-tape.js';
import type { TradeHub } from '../trade/hub.js';

/**
 * THE SOCKET.
 *
 * ── No authentication, and no way to become one ─────────────────────────────
 *
 * A price is not a secret and a public market's depth is the point of it being
 * public (§9). So this port takes no token, reads no cookie, and verifies no
 * principal. The hazard with an unauthenticated public port is not that
 * somebody reads a price — it is that it becomes a path to something else, so:
 *
 *   · **On this door inbound frames are never interpreted.** There is no
 *     subscribe verb, no command vocabulary, no JSON parser on the read side.
 *     The market is a query parameter on the upgrade and it is the only thing a
 *     client ever says. `maxPayload` is 1 KiB so a client cannot make us buffer
 *     one either. One market per socket. A terminal that wants many markets or
 *     tickers or candles on one socket uses the multiplexed door (`GET /stream`
 *     with NO `market`, `mux/gateway.ts`), which has the one inbound parser in
 *     this service, bounded and budgeted (`mux/protocol.ts`).
 *   · **The market id is checked against the engine's own list** before any
 *     depth call is made for it. `svc-matching`'s `engine.depth()` creates the
 *     book if it is missing, so an unvalidated id is a memory-growth primitive
 *     against the engine, driven from a browser. `DepthHub.ensureKnownMarket`
 *     is that check and `depth/source.ts` explains it at length.
 *   · **The process holds no credential.** Not `INTERNAL_SERVICE_SECRET`, not
 *     `EDGE_PRINCIPAL_SECRET`, no database URL. Compromising this service gets
 *     an attacker the ability to read public depth and public trade prints,
 *     which they already had. Connecting to NATS for `orderFilled` does not
 *     change that — the bus is not a money path and the public wire strips
 *     order ids before fan-out.
 *
 * There is deliberately no Origin check. An origin allow-list is an
 * authorisation control, and there is nothing here to authorise — it would
 * inconvenience a bot without protecting anything, since the same data is a
 * `curl` away. Cross-site WebSocket hijacking is a risk to endpoints that
 * carry ambient credentials; this one carries none. The private and drop-copy
 * upgrades do check Origin (`customer-origin.ts`) because a session cookie
 * can be attached to those sockets.
 *
 * ── Channels ────────────────────────────────────────────────────────────────
 *
 * `?market=<id>` alone is JSON L2 depth (snapshot + deltas), unchanged. Pass
 * `channel=trades` for the public trade tape. Pass `format=sbe` (or
 * `encoding=binary`) for the public L2 SBE tape encoded with Real Logic
 * SBE 1.39.0 via `@intafaced/sbe-codec` (`DepthLevel`). That tape is L2 —
 * never L3. JSON `channel=l3` (order-by-order / queue-position) projects
 * matching `GET /markets/:id/depth/l3` — never synthesized from L2, and still
 * a poll (`transport=poll` on the frame). A client asking for engine push on
 * depth/L3 is `depth.push_unavailable`. Missing matching hitch is
 * `depth.l3_unavailable`. Queue-probability stays refused.
 * L3+SBE is `depth.binary_unavailable` (no L3 SBE). L4 / public maker identity
 * on the SBE door is `depth.entitlement_unauthorized`. Unlinked codec is
 * `depth.sbe_unavailable` — JSON is never served as SBE. Private binary stays
 * refused on `/private/stream`. Orders and positions are per-principal on
 * `/private/stream?channel=orders|positions` (see `private/gateway.ts`) —
 * deliberately not on this public port.
 *
 * ── Why not through svc-edge ────────────────────────────────────────────────
 *
 * The edge proxy buffers with `response.text()` — its README lists streaming
 * under "Not built yet" — so it cannot carry a socket. Routing this through it
 * would mean teaching the edge to upgrade connections, which grows the one
 * component whose whole design goal is the smallest blast radius in the fleet.
 * A second public port on a process that holds nothing is the cheaper trade.
 */

/** Bounded before anything else touches it. The hub does the authoritative check. */
const MARKET_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** The probe did not settle inside the bound. The caller releases the raw socket and does not attach. */
const NATIVE_L3_PROBE_EXPIRED = Symbol('native-l3-probe-expired');

function nativeL3ProbeBoundMs(configured: number | undefined, heartbeatMs: number): number {
  if (typeof configured === 'number' && Number.isInteger(configured) && configured >= 1) return configured;
  return heartbeatMs;
}

function probeWithinBound(probe: Promise<NativeL3Probe>, boundMs: number): Promise<NativeL3Probe | typeof NATIVE_L3_PROBE_EXPIRED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof NATIVE_L3_PROBE_EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(NATIVE_L3_PROBE_EXPIRED), boundMs);
    timer.unref?.();
  });
  const finished = probe.finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  // A probe that settles after the bound must not surface as an unhandled rejection.
  void finished.catch(() => undefined);
  return Promise.race([finished, expired]);
}

export const STREAM_PATH = '/stream';

/** The channels `/stream?market=<id>&channel=` serves; `parseChannel` accepts exactly these. */
export const STREAM_CHANNELS = ['depth', 'trades'] as const;
export type StreamChannel = (typeof STREAM_CHANNELS)[number];

export interface WebSocketGatewayOptions {
  readonly server: Server;
  readonly hub: DepthHub;
  readonly tradeHub: TradeHub;
  readonly heartbeatMs: number;
  readonly log: HubLogger;
  /** Reads the kill-switch at connection time, so flipping it needs no restart. */
  readonly enabled: () => boolean;
  /** Real Logic SBE 1.39.0 adapter. Tests inject; production uses the package singleton. */
  readonly sbe?: SbeCodec;
  /** Native matching L3. Omit = L3 asks stay `depth.l3_unavailable`. */
  readonly l3Hub?: NativeL3Hub;
  /** How long a native L3 probe may hold the raw upgrade socket. Omitted uses `heartbeatMs`. */
  readonly l3ProbeBoundMs?: number;
  /**
   * The multiplexed door. Omit = `GET /stream` with no `market` stays the 400 it
   * has always been. Present = that exact request (and only that request)
   * upgrades to a multiplexed session; every `?market=` request is untouched.
   */
  readonly mux?: MuxGateway;
  /**
   * Owner-published new-connection window. Omitted or a true result admits.
   * False refuses this upgrade and leaves sockets already open alone.
   */
  readonly admitNewConnection?: () => boolean;
}

export interface WebSocketGateway {
  readonly connections: number;
  close(reason: string): Promise<void>;
}

/** RFC 6455 caps a close reason at 123 bytes; a longer one throws. Catalog keys resolve first. */
function closeReason(reason: string): string {
  const copy = resolveWsCopy(reason);
  return copy.length <= 120 ? copy : `${copy.slice(0, 117)}...`;
}

function sinkFor(socket: WebSocket): DepthSink {
  return {
    get bufferedBytes() {
      // The socket's OWN buffer. This service keeps no queue of its own, so
      // this is the only place a slow client can accumulate anything.
      return socket.bufferedAmount;
    },
    send(frame: string) {
      socket.send(frame);
    },
    close(code: number, reason: string) {
      socket.close(code, closeReason(reason));
    },
  };
}

function sbeSink(socket: WebSocket, codec: SbeCodec): DepthSink {
  return {
    get bufferedBytes() {
      return socket.bufferedAmount;
    },
    send(frame: string) {
      const encoded = encodeL2JsonFrame(codec, frame);
      if (!encoded.ok) {
        try {
          socket.close(CLOSE_POLICY, closeReason(encoded.reason));
        } catch {
          socket.terminate();
        }
        return;
      }
      if (encoded.skip) return;
      for (const payload of encoded.payloads) {
        socket.send(Buffer.from(payload));
      }
    },
    close(code: number, reason: string) {
      socket.close(code, closeReason(reason));
    },
  };
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** `null` = unknown (caller 400s). Omitted or empty = `depth`. */
export function parseChannel(raw: string | null): StreamChannel | null {
  if (raw === null || raw === '') return 'depth';
  return (STREAM_CHANNELS as readonly string[]).includes(raw) ? (raw as StreamChannel) : null;
}

export function createWebSocketGateway(options: WebSocketGatewayOptions): WebSocketGateway {
  const { server, hub, tradeHub, heartbeatMs, log, enabled, sbe = sbeCodec, l3Hub, l3ProbeBoundMs, mux, admitNewConnection } = options;

  const wss = new WebSocketServer({
    noServer: true,
    // Nothing inbound is read, so nothing inbound needs room. This is the cap
    // on what one client can make this process allocate.
    maxPayload: 1024,
    // Compression is off: per-message deflate holds a zlib context per socket
    // (~300 KiB with default windows), which turns "many idle subscribers" —
    // the normal state of a market-data server — into a memory problem. Depth
    // frames are small and already mostly digits.
    perMessageDeflate: false,
  });

  /** Sockets that have not answered the last ping. */
  const alive = new WeakSet<WebSocket>();
  /** Set at the start of close(). An in-flight L3 probe must not attach after this. */
  let closed = false;
  /** Native L3 handshakes awaiting probe. Counted with attached sockets against maxConnections. */
  let l3ProbesInFlight = 0;

  const dropRaw = (socket: Duplex): void => {
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  };

  const refuseNativeL3AtCapacity = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (closed) {
      dropRaw(socket);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (closed) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        sinkFor(ws).close(CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.atCapacity));
      } catch {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
    });
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Fixed base — never Host. Same reason as private: a Host-derived base can
    // throw before the path check and, on co-mount, abort later upgrade listeners
    // with an uncaught exception so the socket never gets a 4xx and hangs.
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://gateway.invalid');
    } catch (err) {
      log.warn({ err: String(err) }, 'ws: unreadable upgrade URL');
      return reject(socket, 400, 'Bad Request');
    }
    // Co-mounted with private + drop-copy: Node fires every upgrade listener.
    // Ignore those paths so their auth can run; other paths still 404.
    if (url.pathname === PRIVATE_STREAM_PATH) return;
    if (url.pathname === DROP_COPY_STREAM_PATH) return;
    if (url.pathname !== STREAM_PATH) return reject(socket, 404, 'Not Found');

    if (!enabled()) return reject(socket, 503, 'Service Unavailable');

    // No `market` parameter at all: the multiplexed door, when one is mounted.
    // `?market=` with any value (even empty) is the single-market socket and is
    // validated exactly as before.
    if (mux && !url.searchParams.has('market')) {
      if (admitNewConnection && !admitNewConnection()) return reject(socket, 429, 'Too Many Requests');
      return mux.upgrade(request, socket, head, url);
    }

    const marketId = url.searchParams.get('market');
    if (!marketId || !MARKET_ID.test(marketId)) return reject(socket, 400, 'Bad Request');

    const feedRefuse = marketDataFeedRefuse(url.searchParams, { allowPublicSbeL2: true, allowNativeL3: true });
    if (feedRefuse) return writeMarketDataFeedRefuse(socket, feedRefuse);

    if (admitNewConnection && !admitNewConnection()) return reject(socket, 429, 'Too Many Requests');

    if (isNativeL3Ask(url.searchParams)) {
      if (!l3Hub) return writeMarketDataFeedRefuse(socket, DEPTH_L3_UNAVAILABLE);
      const nativeL3 = l3Hub;
      void (async () => {
        let counted = false;
        try {
          const ceiling = nativeL3.maxConnections;
          if (isPublishedConnectionCeiling(ceiling) && nativeL3.connections + l3ProbesInFlight >= ceiling) {
            refuseNativeL3AtCapacity(request, socket, head);
            return;
          }
          if (isPublishedConnectionCeiling(ceiling)) {
            l3ProbesInFlight += 1;
            counted = true;
          }
          const probe = await probeWithinBound(nativeL3.probe(marketId), nativeL3ProbeBoundMs(l3ProbeBoundMs, heartbeatMs));
          // close() already cleared the heartbeat. A probe that outlives the
          // bound is the same: upgrading now would pin a socket nothing reaps.
          if (closed || probe === NATIVE_L3_PROBE_EXPIRED) {
            dropRaw(socket);
            return;
          }
          if (probe === 'unavailable') return writeMarketDataFeedRefuse(socket, DEPTH_L3_UNAVAILABLE);
          wss.handleUpgrade(request, socket, head, (ws) => {
            if (closed) {
              try {
                ws.terminate();
              } catch {
                /* ignore */
              }
              return;
            }
            const detach = nativeL3.attach(marketId, sinkFor(ws));
            if (!detach) {
              try {
                ws.terminate();
              } catch {
                /* ignore */
              }
              return;
            }
            alive.add(ws);
            ws.on('pong', () => alive.add(ws));
            ws.on('message', () => undefined);
            ws.on('error', () => ws.terminate());
            ws.on('close', detach);
          });
        } finally {
          if (counted) l3ProbesInFlight -= 1;
        }
      })().catch((err: unknown) => {
        log.warn({ err: String(err), marketId }, 'ws: native L3 upgrade failed');
        try {
          writeMarketDataFeedRefuse(socket, DEPTH_L3_UNAVAILABLE);
        } catch {
          socket.destroy();
        }
      });
      return;
    }

    if (isPublicSbeL2Ask(url.searchParams)) {
      const entitlement = sbeL2EntitlementRefuse(url.searchParams);
      if (entitlement) return writeMarketDataFeedRefuse(socket, entitlement);
      if (!sbe.linked) return writeMarketDataFeedRefuse(socket, DEPTH_SBE_UNAVAILABLE);

      wss.handleUpgrade(request, socket, head, (ws) => {
        const detach = hub.attach(marketId, sbeSink(ws, sbe));
        if (!detach) {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          return;
        }
        alive.add(ws);
        ws.on('pong', () => alive.add(ws));
        ws.on('message', () => undefined);
        ws.on('error', () => ws.terminate());
        ws.on('close', detach);
      });
      return;
    }

    const channel = parseChannel(url.searchParams.get('channel'));
    if (channel === null) return reject(socket, 400, 'Bad Request');

    wss.handleUpgrade(request, socket, head, (ws) => {
      const detach = channel === 'trades' ? tradeHub.attach(marketId, sinkFor(ws)) : hub.attach(marketId, sinkFor(ws));
      // Capacity refuse closes the sink inside attach — terminate so the client
      // never sits half-open with zero frames (mirrors private gateway).
      if (!detach) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }

      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      // Inbound frames are dropped without being parsed. See the header.
      ws.on('message', () => undefined);
      ws.on('error', () => ws.terminate());
      ws.on('close', detach);
    });
  };

  server.on('upgrade', onUpgrade);

  /**
   * A socket that stopped answering is not a subscriber, it is a book snapshot
   * being computed for nobody every tick. TCP will not tell us for minutes.
   */
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    get connections() {
      return wss.clients.size;
    },
    async close(reason: string) {
      closed = true;
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      // Say why, rather than dropping the TCP connection: a client that is told
      // reconnects with backoff, and one that is not reconnects immediately.
      const copy = resolveWsCopy(reason);
      hub.closeAll(CLOSE_GOING_AWAY, copy);
      tradeHub.closeAll(CLOSE_GOING_AWAY, copy);
      l3Hub?.closeAll(CLOSE_GOING_AWAY, copy);
      await mux?.close(copy);
      for (const ws of wss.clients) ws.close(CLOSE_GOING_AWAY, closeReason(copy));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      log.info({ reason: copy }, 'ws: gateway closed');
    },
  };
}

export { CLOSE_POLICY };
