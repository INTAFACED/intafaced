import { useEffect, useMemo, useState } from 'react';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { LinkedDepth } from './depth';
import type { Listing, TradeApi } from './trade-api';

export function usePolled<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>, key: string, seconds = 15) {
  const result = useResource(load, key);
  useEffect(() => {
    const timer = setInterval(result.reload, seconds * 1000);
    return () => clearInterval(timer);
  }, [key, seconds]);
  return result;
}
export function useLinkedBook(api: TradeApi, market: Listing) {
  const [state, setState] = useState<{
    key: string;
    book: ReturnType<LinkedDepth['read']>;
    status: string;
    failure: Extract<ApiResult<unknown>, { ok: false }> | null;
  }>({ key: market.id, book: new LinkedDepth(market.id).read(), status: 'Loading depth', failure: null });
  useEffect(() => {
    const controller = new AbortController(),
      depth = new LinkedDepth(market.id);
    let socket: WebSocket | null = null,
      closed = false,
      inFlight = false,
      retry: ReturnType<typeof setTimeout> | undefined,
      source = 'Snapshot';
    const publish = (failure: Extract<ApiResult<unknown>, { ok: false }> | null = null) => {
      if (!closed) setState({ key: market.id, book: depth.read(), status: source, failure });
    };
    const snapshot = async () => {
      if (inFlight || closed) return;
      inFlight = true;
      const result = await api.book(market.symbol, controller.signal);
      inFlight = false;
      if (closed) return;
      if (result.ok) {
        const verdict = depth.receive({
          type: 'snapshot',
          marketId: market.id,
          sequence: result.data.nonce,
          bids: result.data.bids,
          asks: result.data.asks,
        });
        if (verdict === 'invalid') {
          source = 'Unverified depth';
          publish({ ok: false, reason: 'invalid_response', message: 'Depth contains an invalid price or quantity.' });
        } else publish();
      } else {
        depth.invalidate();
        source = 'Depth unavailable';
        publish(result);
      }
    };
    const connect = () => {
      if (closed) return;
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/stream?market=${encodeURIComponent(market.id)}`,
      );
      socket.onmessage = (event) => {
        if (closed) return;
        let wire: unknown;
        try {
          wire = JSON.parse(String(event.data));
        } catch {
          depth.invalidate();
          source = 'Unverified stream';
          publish();
          void snapshot();
          return;
        }
        const verdict = depth.receive(wire);
        if (verdict === 'accepted') {
          source = 'Live depth';
          publish();
        } else if (verdict === 'gap' || verdict === 'invalid') {
          source = 'Resynchronizing depth';
          publish();
          void snapshot();
        }
      };
      socket.onerror = () => {
        depth.invalidate();
        source = 'Stream interrupted';
        publish();
      };
      socket.onclose = () => {
        if (closed) return;
        depth.invalidate();
        source = 'Reconnecting';
        publish();
        retry = setTimeout(() => {
          void snapshot();
          connect();
        }, 2000);
      };
    };
    void snapshot();
    connect();
    const clock = setInterval(() => publish(), 1000),
      poll = setInterval(() => {
        source = 'Snapshot';
        void snapshot();
      }, 10000);
    return () => {
      closed = true;
      controller.abort();
      socket?.close();
      clearInterval(clock);
      clearInterval(poll);
      clearTimeout(retry);
    };
  }, [api, market.id, market.symbol]);
  return state.key === market.id
    ? state
    : { key: market.id, book: new LinkedDepth(market.id).read(), status: 'Loading depth', failure: null };
}
export function useDeviceSetting<T>(key: string, initial: T, validate: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      return validate(stored) ? stored : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Display settings remain usable without browser storage. */
    }
  }, [key, value]);
  return [value, setValue] as const;
}
export function useTradeApi(factory: () => TradeApi, dependency: unknown) {
  return useMemo(factory, [dependency]);
}
