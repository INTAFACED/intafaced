import { useCallback, useEffect, useMemo, useState } from 'react';
import { classifyFailure } from '../../../data/poll';
import { createToolApi, useSession } from '../buy/deps';
import type { ConvertHistoryRow } from '../../../features/trade/tool-api';
import { RECENT_SHOWN, recentRows, recentWindow } from './recent';

/** Pages read at most per open; each is up to RECENT_FETCH quotes. */
const MAX_PAGES = 5;

type Read =
  | { status: 'loading' }
  | { status: 'ready'; rows: ConvertHistoryRow[]; more: boolean }
  | { status: 'refused'; code: string }
  | { status: 'error' };
export type RecentState = Exclude<Read, { status: 'error' }> | { status: 'error'; retry: () => void };

/** Reads the customer's conversions once when the panel opens, and again on Retry. Never polls. */
export function useRecentConversions(): RecentState {
  const { api } = useSession();
  const tools = useMemo(() => createToolApi(api), [api]);
  const [state, setState] = useState<Read>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const window = recentWindow(Date.now());
      const rows: ConvertHistoryRow[] = [];
      let cursor: string | undefined;
      // Most stored quotes are never taken up, so a page can hold none. Keep reading pages until there are enough rows or the
      // window is exhausted, so the empty state is only ever shown when there truly are none.
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await tools.convertList({ ...window, ...(cursor ? { cursor } : {}) }, controller.signal);
        if (controller.signal.aborted) return;
        if (!result.ok) {
          const failure = classifyFailure(result);
          return setState(failure.kind === 'refused' ? { status: 'refused', code: failure.code } : { status: 'error' });
        }
        rows.push(...recentRows(result.data.rows));
        cursor = result.data.nextCursor ?? undefined;
        if (!cursor || rows.length >= RECENT_SHOWN) break;
      }
      setState({ status: 'ready', rows: rows.slice(0, RECENT_SHOWN), more: cursor !== undefined && rows.length < RECENT_SHOWN });
    })();
    return () => controller.abort();
  }, [tools, attempt]);

  return state.status === 'error' ? { status: 'error', retry } : state;
}
