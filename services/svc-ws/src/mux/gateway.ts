import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_GOING_AWAY, CLOSE_POLICY, CLOSE_TRY_LATER, type HubLogger } from '../depth/hub.js';
import { marketDataFeedRefuse, writeMarketDataFeedRefuse } from '../gateway-policy.js';
import { isPublishedConnectionCeiling } from '../max-connections.js';
import { MUX_MAX_PAYLOAD_BYTES } from './protocol.js';
import { MuxSession, type MuxSessionDeps, type MuxSocket } from './session.js';

/**
 * THE MULTIPLEXED UPGRADE (`GET /stream` with no `market`).
 *
 * Mounted by `ws/gateway.ts`, which keeps owning the path: a request that names
 * a market is the original single-market socket and never reaches this file.
 * Everything that makes the legacy door safe on an anonymous port carries over
 * — no credential in the process, no Origin allow-list to pretend at security,
 * compression off — and the one thing that is new, an inbound parser, is the
 * smallest that can do the job (`protocol.ts`): 8 KiB frames, a closed
 * vocabulary, an operation budget.
 */

export interface MuxGatewayOptions {
  readonly session: MuxSessionDeps;
  /** Owner-published ceiling on multiplexed connections. Unset refuses the connection. */
  readonly maxConnections: number | undefined;
  readonly heartbeatMs: number;
  readonly log: HubLogger;
}

export interface MuxGateway {
  readonly connections: number;
  readonly maxConnections: number | undefined;
  readonly subscriptions: number;
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void;
  close(reason: string): Promise<void>;
}

function closeReason(reason: string): string {
  const copy = resolveWsCopy(reason);
  return copy.length <= 120 ? copy : `${copy.slice(0, 117)}...`;
}

function adapt(ws: WebSocket): MuxSocket {
  return {
    get bufferedBytes() {
      return ws.bufferedAmount;
    },
    send(frame: string) {
      ws.send(frame);
    },
    close(code: number, reason: string) {
      try {
        ws.close(code, closeReason(reason));
      } catch {
        ws.terminate();
      }
    },
  };
}

export function createMuxGateway(options: MuxGatewayOptions): MuxGateway {
  const { session: sessionDeps, heartbeatMs, log } = options;

  const wss = new WebSocketServer({
    noServer: true,
    // The cap on what one client can make this process buffer. Above it `ws`
    // closes the socket with 1009 before the frame is assembled.
    maxPayload: MUX_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  const sessions = new Set<MuxSession>();
  const alive = new WeakSet<WebSocket>();
  let closed = false;

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

  // A connection that holds no subscription still costs a heartbeat and a seat.
  // The sweep closes it after `idleMs` (1008 `ws.close.mux_idle`).
  const idleSweep = setInterval(
    () => {
      const now = Date.now();
      for (const session of [...sessions]) if (session.idleExpired(now)) session.closeIdle();
    },
    Math.max(250, Math.floor(sessionDeps.idleMs / 4)),
  );
  idleSweep.unref?.();

  return {
    get connections() {
      return sessions.size;
    },
    get maxConnections() {
      return options.maxConnections;
    },
    get subscriptions() {
      let total = 0;
      for (const session of sessions) total += session.subscriptions;
      return total;
    },

    upgrade(request, socket, head, url) {
      if (closed) {
        socket.destroy();
        return;
      }
      // The mux door has no L3 / SBE / entitlement variants; say so, the same way the legacy door does.
      const feedRefuse = marketDataFeedRefuse(url.searchParams, { allowPublicSbeL2: false, allowNativeL3: false });
      if (feedRefuse) return writeMarketDataFeedRefuse(socket, feedRefuse);

      wss.handleUpgrade(request, socket, head, (ws) => {
        if (closed) {
          ws.terminate();
          return;
        }
        const ceiling = options.maxConnections;
        const refuseWith = (code: number, reason: string) => {
          try {
            ws.close(code, closeReason(reason));
          } catch {
            ws.terminate();
          }
        };
        if (!isPublishedConnectionCeiling(ceiling)) {
          refuseWith(CLOSE_POLICY, resolveWsCopy(WS_COPY.maxConnectionsUnset));
          return;
        }
        if (sessions.size >= ceiling) {
          refuseWith(CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.atCapacity));
          return;
        }

        const session = new MuxSession(adapt(ws), sessionDeps);
        if (!session.start()) {
          // start() already closed the socket with the unset-ceiling name.
          return;
        }
        sessions.add(session);
        alive.add(ws);
        ws.on('pong', () => alive.add(ws));
        ws.on('message', (data, isBinary) => {
          if (isBinary) session.onBinary();
          else session.onMessage(data.toString());
        });
        ws.on('error', () => ws.terminate());
        ws.on('close', () => {
          session.onClose();
          sessions.delete(session);
        });
      });
    },

    async close(reason: string) {
      closed = true;
      clearInterval(heartbeat);
      clearInterval(idleSweep);
      const copy = resolveWsCopy(reason);
      for (const session of [...sessions]) session.close(CLOSE_GOING_AWAY, copy);
      for (const ws of wss.clients) ws.close(CLOSE_GOING_AWAY, closeReason(copy));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      log.info({ reason: copy }, 'ws: mux gateway closed');
    },
  };
}
