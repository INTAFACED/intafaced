/**
 * The quote desk's reads. The desk status and the pair list are polled through the tab's one scheduler; each quote is
 * read on its own with `rfq.get` (there is no list door), never trusted from device storage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiResult } from '../../../shared/api';
import type { DeskStatus, OtcMakers, RfqQuote, RoomApi } from '../rooms/api';
import { ROOM_INTERVALS, usePrivateRead, usePublicRead } from '../rooms/read';
import { roomWords, type Words } from '../rooms/refusals';
import { forgetId, readIds, rememberId } from '../rooms/store';
import type { Loadable } from '../rooms/ui';
import { lifecycleOf, sameQuote, type ReadQuote } from './model';

export function useDeskStatus(api: RoomApi): Loadable<DeskStatus> {
  return usePrivateRead<DeskStatus>('otc-desk-status', (signal) => api.deskStatus(signal), ROOM_INTERVALS.deskStatus);
}

/** The owner's provider list (CB-otc-01); blank is an honest "No providers set", never a sample provider. */
export function useOtcMakers(api: RoomApi): Loadable<OtcMakers> {
  return usePrivateRead<OtcMakers>('otc-makers', (signal) => api.otcMakers(signal), ROOM_INTERVALS.deskStatus);
}

export interface PairOption {
  symbol: string;
  base: string;
  quote: string;
  /** Smallest size step, or null when the market does not say. */
  lot: string | null;
}

/** Real spot markets only: the desk quotes spot pairs, and a paper market is not a real price. */
export function usePairs(api: RoomApi): Loadable<PairOption[]> {
  return usePublicRead<PairOption[]>(
    'otc-pairs',
    async (signal) => {
      const result = await api.markets(signal);
      if (!result.ok) return result;
      const seen = new Set<string>();
      const pairs: PairOption[] = [];
      for (const m of result.data) {
        if (!m.spot || m.paper || !m.orderable || seen.has(m.symbol)) continue;
        seen.add(m.symbol);
        pairs.push({ symbol: m.symbol, base: m.base, quote: m.quote, lot: m.precision.amount });
      }
      return { ok: true, data: pairs };
    },
    ROOM_INTERVALS.markets,
  );
}

export type QuoteEntry =
  | { status: 'loading' }
  | { status: 'ready'; quote: RfqQuote; readAt: number }
  /** The service answered with a typed no (for example the id is not yours). */
  | { status: 'refused'; words: Words }
  | { status: 'error' };

/** One `rfq.get`, with the answer checked against the id asked for. */
export async function readQuote(api: RoomApi, quoteId: string, signal?: AbortSignal): Promise<ApiResult<RfqQuote>> {
  const result = await api.rfqGet(quoteId, signal);
  if (result.ok && !sameQuote(quoteId, result.data))
    return { ok: false, reason: 'invalid_response', message: 'The desk answered with a different quote.' };
  return result;
}

function entryOf(result: ApiResult<RfqQuote>, now: number): QuoteEntry {
  if (result.ok) return { status: 'ready', quote: result.data, readAt: now };
  if (result.reason === 'unreachable' || result.reason === 'aborted') return { status: 'error' };
  return { status: 'refused', words: roomWords(result) };
}

const WATCH_EVERY_MS = ROOM_INTERVALS.quote;

/**
 * Every quote id this browser knows (stored, opened by id, or in the link), each re-read once on arrival, and the
 * watched one again every few seconds while it can still change. A stored id is only a pointer to be re-read.
 */
export function useQuoteBook(api: RoomApi, userId: string | null, linkedId: string | null, watched: string | null) {
  const [stored, setStored] = useState<string[]>(() => readIds('rfq', userId));
  const [entries, setEntries] = useState<Record<string, QuoteEntry>>({});
  const requested = useRef(new Set<string>());

  useEffect(() => {
    const sync = () => setStored(readIds('rfq', userId));
    sync();
    window.addEventListener('trade-room-ids-change', sync);
    return () => window.removeEventListener('trade-room-ids-change', sync);
  }, [userId]);

  const ids = useMemo(() => (linkedId && !stored.includes(linkedId) ? [linkedId, ...stored] : stored), [linkedId, stored]);

  const load = useCallback(
    async (id: string): Promise<ApiResult<RfqQuote>> => {
      setEntries((prev) => (prev[id]?.status === 'ready' ? prev : { ...prev, [id]: { status: 'loading' } }));
      const result = await readQuote(api, id);
      setEntries((prev) => ({ ...prev, [id]: entryOf(result, Date.now()) }));
      return result;
    },
    [api],
  );

  useEffect(() => {
    for (const id of ids) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      void load(id);
    }
  }, [ids, load]);

  const watchedLife = (() => {
    const entry = watched ? entries[watched] : undefined;
    return entry?.status === 'ready' ? lifecycleOf(entry.quote) : null;
  })();
  useEffect(() => {
    if (!watched || (watchedLife !== 'open' && watchedLife !== 'bound')) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(watched);
    }, WATCH_EVERY_MS);
    return () => clearInterval(timer);
  }, [watched, watchedLife, load]);

  /** Open a quote the person typed. Remembered only when the service shows it to them. */
  const open = useCallback(
    async (rawId: string): Promise<{ ok: true } | { ok: false; words: Words }> => {
      const id = rawId.trim();
      const result = await readQuote(api, id);
      if (!result.ok) return { ok: false, words: roomWords(result) };
      requested.current.add(id);
      setEntries((prev) => ({ ...prev, [id]: entryOf(result, Date.now()) }));
      rememberId('rfq', userId, id);
      return { ok: true };
    },
    [api, userId],
  );

  /** A quote a write just returned: show it now, and keep a pointer to it. */
  const adopt = useCallback(
    (quote: RfqQuote) => {
      requested.current.add(quote.quoteId);
      setEntries((prev) => ({ ...prev, [quote.quoteId]: { status: 'ready', quote, readAt: Date.now() } }));
      return rememberId('rfq', userId, quote.quoteId);
    },
    [userId],
  );

  const forget = useCallback(
    (id: string) => {
      forgetId('rfq', userId, id);
      requested.current.delete(id);
      setEntries((prev) => {
        const { [id]: _gone, ...rest } = prev;
        return rest;
      });
    },
    [userId],
  );

  const read = useMemo<ReadQuote[]>(
    () =>
      ids.flatMap((id) => {
        const entry = entries[id];
        return entry?.status === 'ready' ? [{ quote: entry.quote, readAt: entry.readAt }] : [];
      }),
    [ids, entries],
  );

  return { ids, entries, read, load, open, adopt, forget };
}
