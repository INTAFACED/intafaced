import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyAccessToken, type TokenConfig } from '@intafaced/auth';
import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_GOING_AWAY, type DepthSink, type HubLogger } from '../depth/hub.js';
import { type PrivateOrderHub, type PrivateStreamChannel } from './hub.js';
import { EMPTY_PRIVATE_BOOK, type PrivateBookPort } from './book.js';
import { CodController, type CodLeaseRange, type TradeCancelPort } from './cod.js';
import { assertLiveCredential, type LiveCredentialPort } from './live-credential.js';

/**
 * Authenticated private stream (orders, fills, positions).
 *
 * Separate path from the public `/stream` so the public port never grows a
 * credential. Token is `?access_token=` on the upgrade URL (browsers cannot
 * set Authorization on WebSocket upgrades reliably).
 *
 * `?channel=orders|fills|positions` selects one catalog. Omitted (or empty)
 * announces and fans all three — back-compat. Unknown channel is HTTP 400.
 * Positions updates still only arrive when `trade.futures` publishes
 * `positionUpdated`; a positions ready frame is not a fabricated book.
 *
 * When `tokens` is null the private path is disabled (403 on upgrade).
 */

export const PRIVATE_STREAM_PATH = '/private/stream';

/** Application close: access token `exp` elapsed (HTTP 401 is upgrade-only). */
export const CLOSE_UNAUTHORIZED = 4003;

/** `setTimeout` delay is a 32-bit signed int; longer waits fire immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

const PRIVATE_CHANNELS: readonly PrivateStreamChannel[] = ['orders', 'fills', 'positions'];

/**
 * Drop `access_token` from a request-target so access logs never store the credential.
 * Query parse uses a fixed base — the Host header is not involved.
 */
export function redactAccessTokenQuery(requestTarget: string): string {
  const q = requestTarget.indexOf('?');
  if (q === -1 || !requestTarget.includes('access_token=')) return requestTarget;
  let parsed: URL;
  try {
    parsed = new URL(requestTarget, 'http://gateway.invalid');
  } catch {
    return requestTarget.slice(0, q);
  }
  if (!parsed.searchParams.has('access_token')) return requestTarget;
  parsed.searchParams.delete('access_token');
  const search = parsed.searchParams.toString();
  return search ? `${parsed.pathname}?${search}` : parsed.pathname;
}

/**
 * `null` = unknown (caller 400s). `'all'` = omitted/empty query (three frames).
 * Mirrors public `parseChannel` shape, with a different default.
 */
function parsePrivateChannel(raw: string | null): PrivateStreamChannel | 'all' | null {
  if (raw === null || raw === '') return 'all';
  if (raw === 'orders' || raw === 'fills' || raw === 'positions') return raw;
  return null;
}

export interface PrivateWebSocketGatewayOptions {
  readonly server: Server;
  readonly hub: PrivateOrderHub;
  readonly heartbeatMs: number;
  readonly log: HubLogger;
  readonly enabled: () => boolean;
  /** Null ⇒ private path refuses all upgrades. */
  readonly tokens: TokenConfig | null;
  /**
   * Whether private bus consumers are attached. Ready frames include `bus: true|false`
   * so a client can tell "quiet market" from "unsubscribed — will miss updates".
   * Defaults to true when omitted (unit tests that do not wire a bus).
   */
  readonly busAttached?: () => boolean;
  /**
   * Current open orders (and positions). Tests inject a fake; production uses
   * `HttpPrivateBookPort` against svc-trade `GET /api/v1/orders/open`.
   * Omitted → honest empty snapshot (`orders: []`), not omitted frames.
   */
  readonly book?: PrivateBookPort;
  /** Owner socket. Null/omit → arm refuses `cod.lease_range_unconfigured`. */
  readonly codRange?: CodLeaseRange | null;
  /** Optional user-token cancel-all. Missing → fire reports OUTCOME_UNKNOWN. */
  readonly tradeCancel?: TradeCancelPort | null;
  readonly now?: () => number;
  readonly scheduleCod?: (fn: () => void, delayMs: number) => () => void;
  /**
   * Injected live session/key check. Omitted/null = JWT `exp` only.
   * Production does not wire this — svc-ws must not hold INTERNAL_SERVICE_SECRET.
   */
  readonly liveCredential?: LiveCredentialPort | null;
}

export interface PrivateWebSocketGateway {
  readonly connections: number;
  /** COD leases on this replica. Revoke must drop to 0 without `cod.fired`. */
  readonly armedCount: number;
  close(reason: string): Promise<void>;
}

function closeReason(reason: string): string {
  const copy = resolveWsCopy(reason);
  return copy.length <= 120 ? copy : `${copy.slice(0, 117)}...`;
}

function closeUnauthorized(socket: WebSocket): void {
  try {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      socket.close(CLOSE_UNAUTHORIZED, closeReason(WS_COPY.tokenExpired));
    }
  } catch {
    try {
      socket.terminate();
    } catch {
      /* ignore */
    }
  }
}

type PrivateSeat = {
  token: string;
  expiresAtMs: number;
  userId: string;
  hasWrite: boolean;
  sessionId: string;
  apiKeyId?: string;
};

function sinkFor(
  socket: WebSocket,
  seat: PrivateSeat,
  live?: { assert: () => Promise<void>; onDead: () => void },
): DepthSink {
  return {
    get bufferedBytes() {
      return socket.bufferedAmount;
    },
    send(frame: string) {
      if (Date.now() >= seat.expiresAtMs) {
        closeUnauthorized(socket);
        return;
      }
      if (!live) {
        socket.send(frame);
        return;
      }
      void live.assert().then(
        () => {
          if (socket.readyState === socket.OPEN && Date.now() < seat.expiresAtMs) {
            socket.send(frame);
          }
        },
        () => {
          live.onDead();
          closeUnauthorized(socket);
        },
      );
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

function tokenFrom(url: URL, headers: IncomingMessage['headers']): string | null {
  const q = url.searchParams.get('access_token')?.trim();
  if (q) return q;
  const raw = headers.authorization;
  if (!raw || Array.isArray(raw)) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return m?.[1] ?? null;
}

async function hydratePrivateBook(input: {
  hub: PrivateOrderHub;
  book: PrivateBookPort;
  sink: DepthSink;
  userId: string;
  accessToken: string;
  channelSel: PrivateStreamChannel | 'all';
  log: HubLogger;
}): Promise<void> {
  const { hub, book, sink, userId, accessToken, channelSel, log } = input;
  const wantOrders = channelSel === 'all' || channelSel === 'orders';
  const wantPositions = channelSel === 'all' || channelSel === 'positions';
  try {
    if (wantOrders) {
      let orders: Awaited<ReturnType<PrivateBookPort['listOpenOrders']>> = [];
      try {
        orders = await book.listOpenOrders({ accessToken, userId });
      } catch (err) {
        log.warn({ userId, err: String(err) }, 'ws-private: open-orders snapshot read failed — empty list');
      }
      // Matching-down is named on the hub. An empty reconnect snapshot next to
      // that still looks like a blank blotter — skip the empty one.
      if (orders.length > 0 || !hub.isEngineUnavailable) {
        hub.sendOrdersSnapshot(sink, userId, orders);
      }
    }
    if (wantPositions) {
      let positions: Awaited<ReturnType<PrivateBookPort['listOpenPositions']>> = [];
      try {
        positions = await book.listOpenPositions({ accessToken, userId });
      } catch (err) {
        log.warn({ userId, err: String(err) }, 'ws-private: open-positions snapshot read failed — empty list');
      }
      hub.sendPositionsSnapshot(sink, userId, positions);
    }
  } finally {
    hub.releaseSnapshot(sink);
  }
}

function defaultCodSchedule(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, Math.max(0, Math.min(delayMs, MAX_TIMEOUT_MS)));
  timer.unref?.();
  return () => clearTimeout(timer);
}

function messageText(data: WebSocket.RawData): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return null;
}

export function createPrivateWebSocketGateway(options: PrivateWebSocketGatewayOptions): PrivateWebSocketGateway {
  const {
    server,
    hub,
    heartbeatMs,
    log,
    enabled,
    tokens,
    busAttached = () => true,
    book = EMPTY_PRIVATE_BOOK,
    codRange = null,
    tradeCancel = null,
    now = () => Date.now(),
    scheduleCod = defaultCodSchedule,
    liveCredential = null,
  } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_024, perMessageDeflate: false });
  const cod = new CodController({ range: codRange ?? null, now, schedule: scheduleCod, cancel: tradeCancel ?? null });
  let draining = false;

  /**
   * Sockets that have not answered the last ping. Same contract as the public
   * gateway: a client that stops ponging is not a subscriber, it is hub work
   * for nobody — TCP will not tell us for minutes, so we terminate.
   */
  const alive = new WeakSet<WebSocket>();
  /**
   * Access token + `exp` for each open seat. Upgrade verifies once; a timer
   * closes at `exp` so a quiet seat cannot stay OPEN until the next heartbeat.
   * Outbound send and heartbeat re-check as a second gate.
   */
  const seats = new WeakMap<WebSocket, PrivateSeat>();
  const expiryTimers = new Set<ReturnType<typeof setTimeout>>();

  function armExpiry(ws: WebSocket, expiresAtMs: number): ReturnType<typeof setTimeout> {
    const delay = Math.max(0, Math.min(expiresAtMs - Date.now(), MAX_TIMEOUT_MS));
    const timer = setTimeout(() => {
      expiryTimers.delete(timer);
      closeUnauthorized(ws);
    }, delay);
    timer.unref?.();
    expiryTimers.add(timer);
    return timer;
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void (async () => {
      // Fixed base — never Host. Path+query live on `req.url`. A Host-derived
      // base can throw (e.g. `Host: a b`) *before* the private-path check; the
      // catch below would then HTTP-500/destroy a socket the public gateway
      // already upgraded on the same server. That is a co-mount isolation break.
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://gateway.invalid');
      } catch (err) {
        // Destroy the socket — a bare return leaves the TCP upgrade hung until
        // the client times out, and on co-mount a public-path parse throw used
        // to abort this listener before we could even get here.
        log.warn({ err: String(err) }, 'ws-private: unreadable upgrade URL');
        try {
          reject(socket, 400, 'Bad Request');
        } catch {
          /* already gone */
        }
        return;
      }
      if (url.pathname !== PRIVATE_STREAM_PATH) return;
      // Strip the credential before any later logger reads `req.url`.
      req.url = redactAccessTokenQuery(req.url ?? '/');

      try {
        if (!enabled()) {
          reject(socket, 503, 'Service Unavailable');
          return;
        }
        if (!tokens) {
          reject(socket, 403, 'Forbidden');
          return;
        }

        const raw = tokenFrom(url, req.headers);
        if (!raw) {
          reject(socket, 401, 'Unauthorized');
          return;
        }

        let userId: string;
        let expiresAtMs: number;
        let hasWrite: boolean;
        let sessionId: string;
        let apiKeyId: string | undefined;
        try {
          const principal = await verifyAccessToken(raw, tokens);
          if (!principal.userId) {
            reject(socket, 401, 'Unauthorized');
            return;
          }
          if (!principal.scopes.includes('trade:read') && !principal.scopes.includes('trade:write')) {
            reject(socket, 403, 'Forbidden');
            return;
          }
          userId = principal.userId;
          expiresAtMs = principal.expiresAt.getTime();
          hasWrite = principal.scopes.includes('trade:write');
          sessionId = principal.sid;
          apiKeyId = principal.kid;
        } catch {
          reject(socket, 401, 'Unauthorized');
          return;
        }

        if (liveCredential) {
          try {
            await assertLiveCredential(liveCredential, { userId, sessionId, apiKeyId });
          } catch {
            reject(socket, 401, 'Unauthorized');
            return;
          }
        }

        const channelSel = parsePrivateChannel(url.searchParams.get('channel'));
        if (channelSel === null) {
          reject(socket, 400, 'Bad Request');
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          const attachChannel = channelSel === 'all' ? null : channelSel;
          const seat: PrivateSeat = {
            token: raw,
            expiresAtMs,
            userId,
            hasWrite,
            sessionId,
            apiKeyId,
          };
          const live = liveCredential
            ? {
                assert: () =>
                  assertLiveCredential(liveCredential, {
                    userId: seat.userId,
                    sessionId: seat.sessionId,
                    apiKeyId: seat.apiKeyId,
                  }).then(() => undefined),
                onDead: () => {
                  cod.drop(ws);
                },
              }
            : undefined;
          const sink = sinkFor(ws, seat, live);
          const detach = hub.attach(userId, sink, attachChannel, { holdUntilSnapshot: true });
          // Capacity refuse closes the sink inside attach — never announce ready
          // for a subscription the hub did not take (fail-closed, no false start).
          if (!detach) {
            // sink.close may race the client open; terminate so the client always
            // sees a hard end and does not sit half-open with zero ready frames.
            try {
              ws.terminate();
            } catch {
              /* ignore */
            }
            return;
          }

          seats.set(ws, seat);
          alive.add(ws);
          const expiryTimer = armExpiry(ws, expiresAtMs);
          const sendCod = (frame: string) => {
            try {
              if (ws.readyState === ws.OPEN) sink.send(frame);
            } catch {
              /* ignore */
            }
          };
          const unlisten = cod.listen(userId, sendCod);
          ws.on('pong', () => alive.add(ws));
          // Inbound: COD arm/renew/disarm only. Anything else stays ignored.
          ws.on('message', (data) => {
            const text = messageText(data);
            if (text === null) return;
            void (async () => {
              let hasWrite = seat.hasWrite;
              try {
                const principal = await verifyAccessToken(seat.token, tokens);
                hasWrite = principal.scopes.includes('trade:write');
                seat.hasWrite = hasWrite;
                seat.expiresAtMs = principal.expiresAt.getTime();
              } catch {
                closeUnauthorized(ws);
                return;
              }
              if (liveCredential) {
                try {
                  await assertLiveCredential(liveCredential, {
                    userId: seat.userId,
                    sessionId: seat.sessionId,
                    apiKeyId: seat.apiKeyId,
                  });
                } catch {
                  cod.drop(ws);
                  closeUnauthorized(ws);
                  return;
                }
              }
              cod.handleText(ws, text, {
                userId: seat.userId,
                accessToken: seat.token,
                hasWrite,
                send: sendCod,
              });
            })();
          });
          ws.on('error', () => ws.terminate());
          // terminate() still emits close — free the hub seat and the exp timer.
          ws.on('close', () => {
            clearTimeout(expiryTimer);
            expiryTimers.delete(expiryTimer);
            unlisten();
            detach();
            if (draining) cod.drop(ws);
            else void cod.disconnect(ws);
          });

          try {
            // `bus` is honesty, not a second auth: false means the process has no
            // private consumer yet (or it failed), so silence is unsubscribed not quiet.
            const bus = busAttached();
            const announced = channelSel === 'all' ? PRIVATE_CHANNELS : [channelSel];
            for (const channel of announced) {
              sink.send(JSON.stringify({ channel, type: 'ready', userId, bus }));
            }
          } catch {
            /* ignore */
          }
          const replay = (frame: string) => {
            try {
              sink.send(frame);
            } catch {
              /* ignore */
            }
          };
          cod.replayLastFire(userId, replay);
          log.info({ userId }, 'ws-private: client connected');
          void hydratePrivateBook({ hub, book, sink, userId, accessToken: raw, channelSel, log });
        });
      } catch (err) {
        // Only runs for PRIVATE_STREAM_PATH after the early return above.
        log.warn({ err: String(err) }, 'ws-private: upgrade failed');
        try {
          reject(socket, 500, 'Internal Server Error');
        } catch {
          /* ignore */
        }
      }
    })();
  };

  server.on('upgrade', onUpgrade);

  /**
   * A socket that stopped answering is not a private subscriber — it still holds
   * a hub seat and keeps the process computing frames for nobody. Mirror public
   * `/stream`: miss one pong window → terminate.
   */
  const heartbeat = setInterval(() => {
    // Quiet lag: free seats held by slow consumers even when no events publish.
    hub.sweepLag();
    for (const ws of wss.clients) {
      const seat = seats.get(ws);
      if (seat && Date.now() >= seat.expiresAtMs) {
        closeUnauthorized(ws);
        continue;
      }
      if (seat && liveCredential) {
        void assertLiveCredential(liveCredential, {
          userId: seat.userId,
          sessionId: seat.sessionId,
          apiKeyId: seat.apiKeyId,
        }).then(
          () => undefined,
          () => {
            if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
              cod.drop(ws);
              closeUnauthorized(ws);
            }
          },
        );
      }
      if (seat && tokens) {
        void verifyAccessToken(seat.token, tokens).then(
          (principal) => {
            if (ws.readyState !== ws.OPEN) return;
            seat.expiresAtMs = principal.expiresAt.getTime();
          },
          () => closeUnauthorized(ws),
        );
      }
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
    get armedCount() {
      return cod.armedCount;
    },
    async close(reason: string) {
      draining = true;
      cod.dispose();
      clearInterval(heartbeat);
      for (const timer of expiryTimers) clearTimeout(timer);
      expiryTimers.clear();
      server.off('upgrade', onUpgrade);
      const copy = resolveWsCopy(reason);
      await hub.close(copy);
      for (const client of wss.clients) {
        try {
          client.close(CLOSE_GOING_AWAY, closeReason(copy));
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
