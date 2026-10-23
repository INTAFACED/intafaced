import { tradeRefusal, tradeCopy as copy } from './copy';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
type BookStatus =
  | 'loadingDepth'
  | 'snapshot'
  | 'snapshotIsStale'
  | 'unverifiedDepth'
  | 'depthUnavailable'
  | 'unverifiedStream'
  | 'liveDepth'
  | 'resynchronizingDepth'
  | 'streamInterrupted'
  | 'reconnecting';
export function useLinkedBook(api: TradeApi, market: Listing) {
  const [state, setState] = useState<{
    key: string;
    book: ReturnType<LinkedDepth['read']>;
    status: BookStatus;
    failure: Extract<ApiResult<unknown>, { ok: false }> | null;
  }>({ key: market.id, book: new LinkedDepth(market.id).read(), status: 'loadingDepth', failure: null });
  useEffect(() => {
    const controller = new AbortController(),
      depth = new LinkedDepth(market.id);
    let socket: WebSocket | null = null,
      closed = false,
      inFlight = false,
      retry: ReturnType<typeof setTimeout> | undefined,
      source: BookStatus = 'snapshot';
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
        if (Date.now() - result.data.timestamp >= 15000 || result.data.timestamp > Date.now() + 5000) {
          depth.invalidate();
          source = 'snapshotIsStale';
          publish(tradeRefusal('thisDepthSnapshotIsTooOldToAuthorizeANewOrder', { reason: 'invalid_response' }));
          return;
        }
        const verdict = depth.receive(
          {
            type: 'snapshot',
            marketId: market.id,
            sequence: result.data.nonce,
            bids: result.data.bids,
            asks: result.data.asks,
          },
          result.data.timestamp,
        );
        if (verdict === 'invalid') {
          source = 'unverifiedDepth';
          publish(tradeRefusal('depthContainsAnInvalidPriceOrQuantity', { reason: 'invalid_response' }));
        } else publish();
      } else {
        depth.invalidate();
        source = 'depthUnavailable';
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
          source = 'unverifiedStream';
          publish();
          void snapshot();
          return;
        }
        const verdict = depth.receive(wire);
        if (verdict === 'accepted') {
          source = 'liveDepth';
          publish();
        } else if (verdict === 'gap' || verdict === 'invalid') {
          source = 'resynchronizingDepth';
          publish();
          void snapshot();
        }
      };
      socket.onerror = () => {
        depth.invalidate();
        source = 'streamInterrupted';
        publish();
      };
      socket.onclose = () => {
        if (closed) return;
        depth.invalidate();
        source = 'reconnecting';
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
        source = 'snapshot';
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
    ? { ...state, status: copy.t(state.status) }
    : { key: market.id, book: new LinkedDepth(market.id).read(), status: copy.t('loadingDepth'), failure: null };
}
export function useDeviceSetting<T>(key: string, initial: T, validate: (value: unknown) => value is T) {
  const read = (k: string): T => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(k) ?? 'null');
      return validate(stored) ? stored : initial;
    } catch {
      return initial;
    }
  };
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: read(key) }));
  // When the key changes (another user signs in, another market), the value is read again in this same render, so the
  // value held for the old key is never written under the new one.
  let current = state;
  if (state.key !== key) {
    current = { key, value: read(key) };
    setState(current);
  }
  useEffect(() => {
    if (state.key !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify(state.value));
    } catch {
      /* Display settings remain usable without browser storage. */
    }
  }, [key, state]);
  const setValue = useCallback(
    (next: T | ((prev: T) => T)) =>
      setState((s) => ({ key: s.key, value: typeof next === 'function' ? (next as (prev: T) => T)(s.value) : next })),
    [],
  );
  return [current.value, setValue] as const;
}
export function useTradeApi(factory: () => TradeApi, dependency: unknown) {
  return useMemo(factory, [dependency]);
}
