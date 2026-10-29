import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyAccessToken, type TokenConfig } from '@intafaced/auth';
import type { CurrentAuthorityInput } from '@intafaced/contracts';
import type { CurrentAuthorityPort } from './authority.js';
import { PrivateAuthorityLease } from './authority-lease.js';
import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_GOING_AWAY, type DepthSink, type HubLogger } from '../depth/hub.js';
import { marketDataFeedRefuse, writeMarketDataFeedRefuse } from '../gateway-policy.js';
import { type PrivateOrderHub, type PrivateStreamChannel } from './hub.js';
import { EMPTY_PRIVATE_BOOK, type PrivateBookPort } from './book.js';
import { CodController, type CodLeaseRange, type TradeCancelPort } from './cod.js';
import { assertLiveCredential, type LiveCredentialPort } from './live-credential.js';
import { callerIpFromUpgrade } from './caller-ip.js';
import { requestOriginFromUpgrade } from './key-origin.js';
import { foreignUpgradeOrigin } from '../customer-origin.js';
import { requestAccountIdFromUpgrade } from './key-account.js';
import { handlePositionsSubscribeText, type PositionsSeed, type PositionsStream } from './positions-stream.js';

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

/**
 * Open-positions hydrate threw. Not a snapshot, so a client cannot read it as
 * `{ positions: [] }` — that frame is reserved for a read that succeeded empty.
 */
export const POSITIONS_SNAPSHOT_UNAVAILABLE = 'positions.snapshot_unavailable' as const;

/** Application close: access token `exp` elapsed (HTTP 401 is upgrade-only). */
export const CLOSE_UNAUTHORIZED = 4003;

/** `setTimeout` delay is a 32-bit signed int; longer waits fire immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The channels `/private/stream?channel=` serves; `parsePrivateChannel` accepts exactly these. */
export const PRIVATE_CHANNELS: readonly PrivateStreamChannel[] = ['orders', 'fills', 'positions'];

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
export function parsePrivateChannel(raw: string | null): PrivateStreamChannel | 'all' | null {
  if (raw === null || raw === '') return 'all';
  return (PRIVATE_CHANNELS as readonly string[]).includes(raw) ? (raw as PrivateStreamChannel) : null;
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
   * Explicit supplemental adapter, primarily for existing policy tests. It
   * cannot substitute for the mandatory identity authority lease.
   */
  readonly liveCredential?: LiveCredentialPort | null;
  /** Mandatory positive authority for every private seat; missing refuses upgrades. */
  readonly authority?: CurrentAuthorityPort | null;
  /**
   * Sequenced positions journal. Omitted refuses `positions` subscribe with
   * `ws.positions_source_unavailable` and leaves the existing fan-out alone.
   */
  readonly positions?: PositionsStream | null;
  /**
   * Customer page origins (`EDGE_ALLOWED_ORIGINS`). Undefined disables the
   * check so older tests keep their shape. An empty list still refuses a
   * foreign Origin. Missing Origin and a same-host Origin stay allowed.
   */
  readonly customerOrigins?: readonly string[];
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
  lease: PrivateAuthorityLease;
  token: string;
  expiresAtMs: number;
  userId: string;
  hasWrite: boolean;
  sessionId: string;
  scopes: string[];
  apiKeyId?: string;
  callerIp: string | null;
  requestOrigin: string | null;
  accountId?: string;
};

function liveCredentialInput(seat: PrivateSeat) {
  return {
    userId: seat.userId,
    sessionId: seat.sessionId,
    apiKeyId: seat.apiKeyId,
    callerIp: seat.callerIp,
    requestOrigin: seat.requestOrigin,
    accountId: seat.accountId,
  };
}

/**
 * One live-credential check at a time. The next frame's assert starts only
 * after the previous assert settles, so a later failure cannot close the
 * socket and then let an earlier frame out. A rejection latches the sink:
 * `onDead` once, close, and no `socket.send` for a frame still waiting.
 */
export function sinkFor(
  socket: WebSocket,
  seat: { readonly expiresAtMs: number; readonly lease: Pick<PrivateAuthorityLease, 'isCurrent'> },
  live?: { assert: () => Promise<void>; onDead: () => void },
): DepthSink {
  const pending: string[] = [];
  let pumping = false;
  let dead = false;
  let pendingBytes = 0;

  const discard = (): void => {
    dead = true;
    pending.length = 0;
    pendingBytes = 0;
    pumping = false;
  };

  const latch = (): void => {
    if (dead || !live) return;
    discard();
    live.onDead();
    closeUnauthorized(socket);
  };

  const step = (): void => {
    if (!seat.lease.isCurrent() || socket.readyState !== socket.OPEN) {
      discard();
      return;
    }
    if (dead || !live || pending.length === 0) {
      pumping = false;
      return;
    }
    const frame = pending.shift();
    if (frame === undefined) {
      pumping = false;
      return;
    }
    let asserted: Promise<void>;
    try {
      asserted = live.assert();
    } catch {
      latch();
      return;
    }
    void Promise.resolve(asserted).then(
      () => {
        if (!dead && socket.readyState === socket.OPEN && seat.lease.isCurrent()) {
          pendingBytes -= Buffer.byteLength(frame);
          socket.send(frame);
        }
        step();
      },
      () => {
        latch();
      },
    );
  };

  return {
    get bufferedBytes() {
      return socket.bufferedAmount + pendingBytes;
    },
    send(frame: string) {
      if (!seat.lease.isCurrent()) {
        closeUnauthorized(socket);
        return;
      }
      if (!live) {
        socket.send(frame);
        return;
      }
      if (dead) return;
      pending.push(frame);
      pendingBytes += Buffer.byteLength(frame);
      if (pumping) return;
      pumping = true;
      step();
    },
    close(code: number, reason: string) {
      discard();
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
      let ordersReadFailed = false;
      try {
        orders = await book.listOpenOrders({ accessToken, userId });
      } catch (err) {
        ordersReadFailed = true;
        log.warn({ userId, err: String(err) }, 'ws-private: open-orders snapshot read failed');
        // Same disclosure as a matching-down seed: name it, do not publish [].
        hub.markEngineUnavailable();
      }
      // Matching-down is named on the hub. An empty reconnect snapshot next to
      // that — or in place of a thrown read — looks like a book that is empty.
      if (!ordersReadFailed && (orders.length > 0 || !hub.isEngineUnavailable)) {
        hub.sendOrdersSnapshot(sink, userId, orders);
      }
    }
    if (wantPositions) {
      let positions: Awaited<ReturnType<PrivateBookPort['listOpenPositions']>> = [];
      let positionsReadFailed = false;
      try {
        positions = await book.listOpenPositions({ accessToken, userId });
      } catch (err) {
        positionsReadFailed = true;
        log.warn({ userId, err: String(err) }, 'ws-private: open-positions snapshot read failed');
        sink.send(
          JSON.stringify({
            channel: 'positions',
            type: 'status',
            code: POSITIONS_SNAPSHOT_UNAVAILABLE,
            userId,
          }),
        );
      }
      if (!positionsReadFailed) {
        hub.sendPositionsSnapshot(sink, userId, positions);
      }
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
    book: configuredBook,
    codRange = null,
    tradeCancel = null,
    now = () => Date.now(),
    scheduleCod = defaultCodSchedule,
    liveCredential = null,
    authority = null,
    customerOrigins,
    positions = null,
  } = options;
  const book = configuredBook ?? EMPTY_PRIVATE_BOOK;
  // The positions channel seeds only through the strict read. `listOpenPositions`
  // still feeds the connect-time hydrate and still turns a miss into [].
  const positionsSeed: PositionsSeed | undefined =
    configuredBook?.readOpenPositions !== undefined
      ? (userId, accessToken) => configuredBook.readOpenPositions!({ accessToken, userId })
      : undefined;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_024, perMessageDeflate: false });
  const cod = new CodController({ range: codRange ?? null, now, schedule: scheduleCod, cancel: tradeCancel ?? null });
  let draining = false;

  /**
   * Sockets that have not answered the last ping. Same contract as the public
   * gateway: a client that stops ponging is not a subscriber, it is hub work
   * for nobody — TCP will not tell us for minutes, so we terminate.
   * `awaitingPong` is set only after a ping is sent. A seat that is not yet
   * in `alive` on the first tick is not a missed pong.
   */
  const alive = new WeakSet<WebSocket>();
  const awaitingPong = new WeakSet<WebSocket>();
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
      if (foreignUpgradeOrigin(req, customerOrigins)) {
        reject(socket, 403, 'Forbidden');
        return;
      }
      const feedRefuse = marketDataFeedRefuse(url.searchParams);
      if (feedRefuse) {
        writeMarketDataFeedRefuse(socket, feedRefuse);
        return;
      }
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

        if (!authority) {
          reject(socket, 503, 'Service Unavailable');
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
        let scopes: string[];
        let apiKeyId: string | undefined;
        let subject: CurrentAuthorityInput;
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
          scopes = [...principal.scopes];
          sessionId = principal.sid;
          apiKeyId = principal.kid;
          subject = {
            userId,
            credential: apiKeyId ? { kind: 'api_key', apiKeyId } : { kind: 'session', sessionId },
            ...(principal.sub_account ? { subAccountId: principal.sub_account } : {}),
          };
        } catch {
          reject(socket, 401, 'Unauthorized');
          return;
        }

        const callerIp = callerIpFromUpgrade(req);
        const requestOrigin = requestOriginFromUpgrade(req);
        const accountId = requestAccountIdFromUpgrade(req);
        const policy = { userId, sessionId, apiKeyId, callerIp, requestOrigin, accountId };
        let lease: PrivateAuthorityLease;
        try {
          lease = await PrivateAuthorityLease.acquire({
            port: authority,
            subject,
            jwtExpiresAtMs: expiresAtMs,
            policy,
            additional: liveCredential ? () => assertLiveCredential(liveCredential, policy) : undefined,
          });
        } catch {
          reject(socket, 401, 'Unauthorized');
          return;
        }
        if (!lease.isCurrent() || draining || !enabled() || socket.destroyed) {
          lease.dispose();
          if (!socket.destroyed) reject(socket, 401, 'Unauthorized');
          return;
        }

        const channelSel = parsePrivateChannel(url.searchParams.get('channel'));
        if (channelSel === null) {
          lease.dispose();
          reject(socket, 400, 'Bad Request');
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          const attachChannel = channelSel === 'all' ? null : channelSel;
          const seat: PrivateSeat = {
            lease,
            token: raw,
            expiresAtMs,
            userId,
            hasWrite,
            sessionId,
            scopes,
            apiKeyId,
            callerIp,
            requestOrigin,
            accountId,
          };
          const live = liveCredential
            ? {
                assert: () => assertLiveCredential(liveCredential, liveCredentialInput(seat)).then(() => undefined),
                onDead: () => {
                  lease.revoke();
                  cod.drop(ws);
                },
              }
            : undefined;
          const sink = sinkFor(ws, seat, live);
          const detach = hub.attach(userId, sink, attachChannel, { holdUntilSnapshot: true });
          // Capacity refuse closes the sink inside attach — never announce ready
          // for a subscription the hub did not take (fail-closed, no false start).
          if (!detach) {
            lease.dispose();
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
          ws.on('pong', () => {
            alive.add(ws);
            awaitingPong.delete(ws);
          });
          // Inbound: COD arm/renew/disarm only. Anything else stays ignored.
          // L1073: one chain per socket so verification awaits cannot reorder
          // COD commands; each step runs after the previous settles.
          let inbound: Promise<void> = Promise.resolve();
          let inboundClosed = false;
          let detachPositions: (() => void) | null = null;
          ws.on('message', (data) => {
            const text = messageText(data);
            if (text === null) return;
            inbound = inbound
              .then(async () => {
                if (inboundClosed || !lease.isCurrent()) return;
                let hasWrite = seat.hasWrite;
                try {
                  const principal = await verifyAccessToken(seat.token, tokens);
                  hasWrite = principal.scopes.includes('trade:write');
                  seat.hasWrite = hasWrite;
                  seat.scopes = [...principal.scopes];
                  seat.expiresAtMs = principal.expiresAt.getTime();
                } catch {
                  // Break F1: graceful close() fires 'close' later; stop queued frames now.
                  inboundClosed = true;
                  closeUnauthorized(ws);
                  return;
                }
                if (liveCredential) {
                  try {
                    await assertLiveCredential(liveCredential, liveCredentialInput(seat));
                  } catch {
                    lease.revoke();
                    inboundClosed = true;
                    cod.drop(ws);
                    closeUnauthorized(ws);
                    return;
                  }
                }
                if (inboundClosed || !lease.isCurrent() || ws.readyState !== ws.OPEN) return;
                const positionsHandled = await handlePositionsSubscribeText(text, {
                  stream: positions,
                  session: { userId: seat.userId, scopes: seat.scopes },
                  nowIso: new Date(now()).toISOString(),
                  accessToken: seat.token,
                  seed: positionsSeed,
                  send: (frame) => sink.send(frame),
                  onDetach: (detach) => {
                    detachPositions?.();
                    detachPositions = detach;
                  },
                });
                if (positionsHandled) return;
                cod.handleText(ws, text, {
                  userId: seat.userId,
                  accessToken: seat.token,
                  hasWrite,
                  send: sendCod,
                });
              })
              .catch(() => undefined);
          });
          ws.on('error', () => ws.terminate());
          // terminate() still emits close — free the hub seat and the exp timer.
          ws.on('close', () => {
            inboundClosed = true;
            detachPositions?.();
            detachPositions = null;
            clearTimeout(expiryTimer);
            expiryTimers.delete(expiryTimer);
            unlisten();
            detach();
            const current = lease.isCurrent();
            lease.dispose();
            if (draining || !current) cod.drop(ws);
            else void cod.disconnect(ws);
          });

          lease.start(() => {
            cod.drop(ws);
            closeUnauthorized(ws);
            ws.terminate();
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
    positions?.heartbeat(new Date(now()).toISOString());
    for (const ws of wss.clients) {
      const seat = seats.get(ws);
      if (seat && !seat.lease.isCurrent()) {
        closeUnauthorized(ws);
        continue;
      }
      if (seat && liveCredential) {
        void assertLiveCredential(liveCredential, liveCredentialInput(seat)).then(
          () => undefined,
          () => {
            if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
              seat.lease.revoke();
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
        // First ping cycle: not-in-alive without a prior ping is not a miss.
        if (seat && liveCredential && !awaitingPong.has(ws)) {
          awaitingPong.add(ws);
          try {
            ws.ping();
          } catch {
            ws.terminate();
          }
          continue;
        }
        // Missed pong on a still-live private seat is not 1006 — identity
        // heartbeat already drops revoked seats 4003. terminate() here killed
        // KEEP across 40ms tests (`session-revoked-stream`, recovery-mint-key).
        if (seat && liveCredential) {
          void assertLiveCredential(liveCredential, liveCredentialInput(seat)).then(
            () => {
              if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
                awaitingPong.add(ws);
                try {
                  ws.ping();
                } catch {
                  ws.terminate();
                }
              }
            },
            () => {
              if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
                seat.lease.revoke();
                cod.drop(ws);
                closeUnauthorized(ws);
              }
            },
          );
        } else {
          ws.terminate();
        }
        continue;
      }
      alive.delete(ws);
      awaitingPong.add(ws);
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
        seats.get(client)?.lease.dispose();
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
