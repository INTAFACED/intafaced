import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../../shared/api';
import type { Page } from './schemas';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** What a list view renders. `more` is the state of the "Load more" button, kept apart so a failed second page never hides the first. */
export type ListState<T> =
  | { status: 'loading' }
  | { status: 'failed'; failure: Failed }
  | { status: 'ready'; items: T[]; hasMore: boolean; more: 'idle' | 'loading' | Failed };

/**
 * Cursor pagination (B3): newest first, one page at a time, appended in order. The cursor is opaque and is
 * handed back exactly as received. A new `key` (a filter changed) starts again from the first page.
 */
export function useCursorList<T>(
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<ApiResult<Page<T>>>,
  key: string,
  identity: (item: T) => string,
): { state: ListState<T>; loadMore: () => void; reload: (quietly?: boolean) => void } {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ListState<T>>({ status: 'loading' });
  const cursor = useRef<string | null>(null);
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const idRef = useRef(identity);
  idRef.current = identity;
  const silent = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const mine = ++generation.current;
    // A background refresh keeps the rows on screen; a failed one leaves them as they were.
    const quiet = silent.current;
    silent.current = false;
    if (!quiet) setState({ status: 'loading' });
    cursor.current = null;
    void loadRef
      .current(undefined, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || mine !== generation.current) return;
        if (!result.ok) return quiet ? undefined : setState({ status: 'failed', failure: result });
        cursor.current = result.data.nextCursor;
        setState({ status: 'ready', items: result.data.items, hasMore: result.data.nextCursor !== null, more: 'idle' });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [key, revision]);

  const loadMore = useCallback(() => {
    const at = cursor.current;
    if (!at) return;
    const mine = generation.current;
    setState((current) => (current.status === 'ready' ? { ...current, more: 'loading' } : current));
    void loadRef.current(at, new AbortController().signal).then((result) => {
      if (mine !== generation.current) return;
      setState((current) => {
        if (current.status !== 'ready') return current;
        if (!result.ok) return { ...current, more: result };
        cursor.current = result.data.nextCursor;
        const seen = new Set(current.items.map(idRef.current));
        return {
          status: 'ready',
          items: [...current.items, ...result.data.items.filter((item) => !seen.has(idRef.current(item)))],
          hasMore: result.data.nextCursor !== null,
          more: 'idle',
        };
      });
    });
  }, []);
  return {
    state,
    loadMore,
    reload: (quietly = false) => {
      silent.current = quietly === true;
      setRevision((value) => value + 1);
    },
  };
}

/** Filters live in the URL (B3) so a filtered view can be shared and survives a reload. Falls back to memory without a browser. */
export function useUrlParam(name: string, fallback = ''): [string, (value: string) => void] {
  const read = () => {
    try {
      return new URLSearchParams(location.search).get(name) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const [value, setValue] = useState(read);
  const set = useCallback(
    (next: string) => {
      setValue(next);
      try {
        const url = new URL(location.href);
        if (next && next !== fallback) url.searchParams.set(name, next);
        else url.searchParams.delete(name);
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      } catch {
        /* the URL is a convenience; the filter still applies */
      }
    },
    [name, fallback],
  );
  return [value, set];
}

/**
 * The moment a read finished, kept so the page can say how old its numbers are (B12). It changes only when a new
 * answer arrives, not on every render. `null` while loading or after a refusal.
 */
export function useReadAt(ready: boolean, signal: unknown): string | null {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    setAt(ready ? new Date().toISOString() : null);
  }, [ready, signal]);
  return at;
}

/** The current time, refreshed on a timer, so a request that expires while the page is open is seen to expire. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Names for team members, where the team list can be read. If it cannot (a role that may not list the team), ids are shown short instead. */
export function useMemberNames(portal: import('./api').PortalApi): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    const controller = new AbortController();
    void portal
      .teamList(undefined, '', controller.signal)
      .then((result) => {
        if (controller.signal.aborted || !result.ok) return;
        setNames(new Map(result.data.items.flatMap((m) => (m.label ? [[m.userId, m.label] as const] : []))));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [portal]);
  return names;
}
