/**
 * The reads and writes behind the bell and the Notifications page.
 *
 * The unread count and the market names go through the tab's one scheduler (`data/poll.ts`), so a hidden tab stops polling
 * and the whole tab stays inside its request budget. The inbox list is read on demand (when the popover or the page opens)
 * and is never polled.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../features/session/session';
import type { ApiResult } from '../../shared/api';
import type { Loadable } from './deps';
import { useDataEnv, useSource } from './deps';
import { announceChange, listNotifications, markAllRead, markRead, onChange, unreadCount, type Notification } from './notify-api';
import type { NotifyMarket } from './notify-view';

/**
 * The poller adds up to 20% to a source's first wait, so a 50 s interval means the count is read again every 50 to 60 s: a fill shows on the
 * bell within a minute (UI-SPEC 5.12 acceptance).
 */
export const UNREAD_INTERVAL_MS = 50_000;
const MARKETS_INTERVAL_MS = 300_000;

const marketRow = z
  .object({ id: z.string(), base: z.string(), quote: z.string(), spot: z.boolean().optional(), paper: z.boolean().optional() })
  .passthrough();

/** The signed-in person's unread count, polled every 60 s; `null` until the first answer (and if the service can't be reached). */
export function useUnreadCount(): number | null {
  const env = useDataEnv();
  const key = `notify-unread:${env.userId ?? 'none'}`;
  const source = useMemo(
    () =>
      env.poller.source<number>(
        key,
        async (signal) => {
          const result = await unreadCount(env.api, signal);
          return result.ok
            ? { ok: true, data: result.data }
            : { ok: false, reason: result.reason, code: result.code, status: result.status };
        },
        { intervalMs: UNREAD_INTERVAL_MS },
      ),
    [env, key],
  );
  const load: Loadable<number> = useSource(source);
  // Something was read in the popover or on the page: ask again now rather than at the next 60 s tick.
  useEffect(() => onChange(() => env.poller.refresh(key)), [env, key]);
  return load.status === 'ready' ? load.data : null;
}

/**
 * Market id -> names, so "bought 0.00015 on <id>" can say "BTC". `settled` turns true once the list has answered, ready or not, and stays
 * true (a later retry does not take a drawn list away); before that the map is empty, and a fill drawn from it would read "Your buy order
 * was filled." and open Trades unfiltered. `useInboxView` holds such rows until then.
 */
export function useMarketNames(): { settled: boolean; markets: ReadonlyMap<string, NotifyMarket> } {
  const env = useDataEnv();
  const source = useMemo(
    () =>
      env.poller.source<NotifyMarket[]>(
        'notify-markets',
        async (signal) => {
          const result = await env.api.rest('/markets', z.array(marketRow), { query: { limit: 500 }, signal });
          return result.ok
            ? { ok: true, data: result.data.filter((row) => row.spot !== false).map(({ id, base, quote }) => ({ id, base, quote })) }
            : { ok: false, reason: result.reason, code: result.code, status: result.status };
        },
        { intervalMs: MARKETS_INTERVAL_MS },
      ),
    [env],
  );
  const load = useSource(source);
  // Only ever goes from false to true, so setting it while rendering is safe.
  const settled = useRef(false);
  if (load.status !== 'loading') settled.current = true;
  const markets = useMemo(() => new Map(load.status === 'ready' ? load.data.map((market) => [market.id, market]) : []), [load]);
  return { settled: settled.current, markets };
}

type Failure = Extract<ApiResult<unknown>, { ok: false }>;
export type InboxState =
  { status: 'loading' } | { status: 'ready'; items: Notification[]; nextCursor: string | null } | { status: 'failed'; failure: Failure };

export interface Inbox {
  state: InboxState;
  /** A change (mark read, load more) went wrong; the list stays as it was. */
  actionFailed: boolean;
  loadingMore: boolean;
  reload: () => void;
  loadMore: () => void;
  read: (id: string) => void;
  readAll: () => Promise<void>;
}

/**
 * The newest `limit` notifications (all, or only unread), "Load more" by cursor. Reading one marks it in the list at once and tells
 * the service; if the service says no, the list is reloaded so it never shows a state the service doesn't have.
 */
export function useInbox({ limit, unreadOnly, enabled = true }: { limit: number; unreadOnly: boolean; enabled?: boolean }): Inbox {
  const { api, userId } = useSession();
  const [state, setState] = useState<InboxState>({ status: 'loading' });
  const [cycle, setCycle] = useState(0);
  const [actionFailed, setActionFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !userId) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    setActionFailed(false);
    void listNotifications(api, { limit, unreadOnly }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) return setState({ status: 'failed', failure: result });
      // Never show another account's inbox, or the same notification twice.
      const mine = result.data.items.filter(
        (item, index, all) => item.userId === userId && all.findIndex((other) => other.id === item.id) === index,
      );
      setState({ status: 'ready', items: mine, nextCursor: result.data.nextCursor });
    });
    return () => controller.abort();
  }, [api, userId, limit, unreadOnly, enabled, cycle]);

  const reload = useCallback(() => setCycle((value) => value + 1), []);

  const loadMore = useCallback(() => {
    if (state.status !== 'ready' || !state.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setActionFailed(false);
    void listNotifications(api, { limit, unreadOnly, cursor: state.nextCursor }).then((result) => {
      if (!alive.current) return;
      setLoadingMore(false);
      if (!result.ok) return setActionFailed(true);
      setState((current) => {
        if (current.status !== 'ready') return current;
        const seen = new Set(current.items.map((item) => item.id));
        const fresh = result.data.items.filter((item) => item.userId === userId && !seen.has(item.id));
        return { status: 'ready', items: [...current.items, ...fresh], nextCursor: result.data.nextCursor };
      });
    });
  }, [api, limit, unreadOnly, loadingMore, state, userId]);

  const read = useCallback(
    (id: string) => {
      const stamped = new Date().toISOString();
      setState((current) =>
        current.status === 'ready'
          ? { ...current, items: current.items.map((item) => (item.id === id && !item.readAt ? { ...item, readAt: stamped } : item)) }
          : current,
      );
      void markRead(api, [id]).then((result) => {
        announceChange();
        if (!result.ok && alive.current) {
          setActionFailed(true);
          reload();
        }
      });
    },
    [api, reload],
  );

  const readAll = useCallback(async () => {
    setActionFailed(false);
    const result = await markAllRead(api);
    announceChange();
    if (!alive.current) return;
    if (!result.ok) {
      setActionFailed(true);
      return;
    }
    const stamped = new Date().toISOString();
    setState((current) =>
      current.status === 'ready'
        ? unreadOnly
          ? { status: 'ready', items: [], nextCursor: null }
          : { ...current, items: current.items.map((item) => (item.readAt ? item : { ...item, readAt: stamped })) }
        : current,
    );
  }, [api, unreadOnly]);

  return { state, actionFailed, loadingMore, reload, loadMore, read, readAll };
}

const LOADING: InboxState = { status: 'loading' };

/**
 * The inbox as its rows are drawn. A list holding a notice tied to a market (a fill) stays loading until the market names have settled
 * too, so that row is never shown, or opened, without its coin. A failed market read settles it; the row then names no coin and opens
 * Trades unfiltered. Any other list, and a failed inbox read, is shown at once.
 */
export function useInboxView(options: Parameters<typeof useInbox>[0]): {
  inbox: Inbox;
  state: InboxState;
  markets: ReadonlyMap<string, NotifyMarket>;
} {
  const inbox = useInbox(options);
  const { settled, markets } = useMarketNames();
  const { state } = inbox;
  const waiting = !settled && state.status === 'ready' && state.items.some((item) => typeof item.params.marketId === 'string');
  return { inbox, state: waiting ? LOADING : state, markets };
}
