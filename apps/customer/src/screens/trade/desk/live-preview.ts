import { useCallback, useEffect, useRef, useState } from 'react';
import type { Draft, Preview, TradeApi } from '../../../features/trade/trade-api';
import type { RefusalContext } from '../../../data';
import { failureOf, previewFailure, previewIsOrderable, type Failure } from './preview';

/** What the server's preview said about the order as it stands in the form (advisory: Review asks again). */
export type Live =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok'; preview: Preview }
  | { state: 'blocked'; failure: Failure }
  | { state: 'error' };

export const LIVE_PREVIEW_DELAY_MS = 600;

/**
 * Ask the service whether the order in the form can go, 600 ms after the person stops typing, and only for an order
 * the client-side rules already accept. The answer gates the Buy/Sell button and carries the refusal words. It is a
 * read: it never sends an order. A stale answer (the form changed meanwhile) is dropped.
 */
export function useLivePreview(
  api: TradeApi,
  draft: Draft | null,
  key: string,
  context: RefusalContext,
  onRequest: () => void,
  /** The market's tick, so a refusal that names prices reads them on it. */
  tickSize?: string,
): { live: Live; retry: () => void } {
  const [live, setLive] = useState<Live>({ state: 'idle' });
  const [nonce, setNonce] = useState(0);
  const sequence = useRef(0);
  const latest = useRef({ draft, context, onRequest, api, tickSize });
  latest.current = { draft, context, onRequest, api, tickSize };

  useEffect(() => {
    const current = latest.current;
    if (!current.draft) {
      setLive({ state: 'idle' });
      return;
    }
    setLive({ state: 'checking' });
    const mine = ++sequence.current;
    const timer = setTimeout(async () => {
      const { api: client, draft: asked, context: ctx, onRequest: count, tickSize: tick } = latest.current;
      if (!asked) return;
      count();
      const result = await client.preview(asked);
      if (mine !== sequence.current) return;
      if (!result.ok)
        setLive(
          result.reason === 'unauthorized' || result.code ? { state: 'blocked', failure: failureOf(result, ctx) } : { state: 'error' },
        );
      else if (previewIsOrderable(result.data)) setLive({ state: 'ok', preview: result.data });
      else setLive({ state: 'blocked', failure: previewFailure(result.data, ctx, tick) });
    }, LIVE_PREVIEW_DELAY_MS);
    return () => {
      sequence.current += 1;
      clearTimeout(timer);
    };
    // The key stands for every field of the draft; the other inputs are read from `latest`.
  }, [key, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { live, retry };
}
