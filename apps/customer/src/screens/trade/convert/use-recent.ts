import { useCallback, useEffect, useMemo, useState } from 'react';
import { classifyFailure } from '../../../data/poll';
import { createToolApi, useSession } from '../buy/deps';
import type { ConvertHistoryRow } from '../../../features/trade/tool-api';
import { recentRows, recentWindow } from './recent';

type Read =
  { status: 'loading' } | { status: 'ready'; rows: ConvertHistoryRow[] } | { status: 'refused'; code: string } | { status: 'error' };
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
    void tools.convertList(recentWindow(Date.now()), controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) return setState({ status: 'ready', rows: recentRows(result.data.rows) });
      const failure = classifyFailure(result);
      setState(failure.kind === 'refused' ? { status: 'refused', code: failure.code } : { status: 'error' });
    });
    return () => controller.abort();
  }, [tools, attempt]);

  return state.status === 'error' ? { status: 'error', retry } : state;
}
