/**
 * A live feed kept in step with a room: a WebSocket that reconnects, and a clock that starts again with it. Each knows
 * no screen (garden/no-effect-in-product). Both start again whenever `restart` changes (see `useRestart` in
 * chart-binding.ts) and stop when the room goes; the handlers of the render that started them are the ones called,
 * so a room's handlers read the values that started the feed.
 *
 * - `useLiveSocket`: opens `url` (none while `null`); after a close it reports `reconnecting` and opens it again
 *   `retryMs` later. Every event is dropped while `admit()` is false, and a message or close after the feed stopped
 *   is dropped too; an error is still reported while `admit()` holds.
 * - `useRestartingClock`: calls `start` when it starts, then `tick` every `ms`.
 */
import { useEffect, useRef } from 'react';

export interface LiveSocketHandlers {
  admit: () => boolean;
  /** The socket opened; `connection` counts from 0 for each start. */
  open: (connection: number) => void;
  message: (data: unknown) => void;
  error: () => void;
  reconnecting: () => void;
}

/** Opens `url` while it is not `null`, reconnecting `retryMs` after a close; starts again whenever `restart` changes. */
export function useLiveSocket(url: string | null, restart: number, handlers: LiveSocketHandlers, retryMs: number): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (url === null) return;
    const started = latest.current;
    let socket: WebSocket | null = null,
      closed = false,
      retry: ReturnType<typeof setTimeout> | undefined,
      connections = 0;
    const connect = () => {
      if (closed || !started.admit()) return;
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (!started.admit()) return;
        started.open(connections++);
      };
      socket.onmessage = (event) => {
        if (closed || !started.admit()) return;
        started.message(event.data);
      };
      socket.onerror = () => {
        if (started.admit()) started.error();
      };
      socket.onclose = () => {
        if (closed || !started.admit()) return;
        started.reconnecting();
        retry = setTimeout(connect, retryMs);
      };
    };
    connect();
    return () => {
      closed = true;
      socket?.close();
      clearTimeout(retry);
    };
  }, [url, restart, retryMs]);
}

/** Calls `start` when it starts (and whenever `restart` changes), then `tick` every `ms`. */
export function useRestartingClock(clock: { start: () => void; tick: () => void }, ms: number, restart: number): void {
  const latest = useRef(clock);
  latest.current = clock;
  useEffect(() => {
    const started = latest.current;
    started.start();
    const timer = setInterval(() => started.tick(), ms);
    return () => clearInterval(timer);
  }, [ms, restart]);
}
