// A read that refreshes itself and remembers when it last succeeded, so a screen can show a freshness chip and keep
// old rows on screen (marked) while a refresh is under way or has failed.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../../shared/api';
import type { Failure } from './guard';

export type Live<T> = {
  status: 'loading' | 'ready' | 'error';
  data: T | null;
  asOf: number | null;
  failure: Failure | null;
  refreshing: boolean;
  reload: () => void;
};

export function useLive<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>, key: string, intervalMs: number | null): Live<T> {
  const [state, setState] = useState<{
    data: T | null;
    asOf: number | null;
    failure: Failure | null;
    settled: boolean;
    refreshing: boolean;
  }>({
    data: null,
    asOf: null,
    failure: null,
    settled: false,
    refreshing: true,
  });
  const [revision, setRevision] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const shownKey = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller = new AbortController();
    const tick = async () => {
      controller = new AbortController();
      setState((previous) => ({ ...previous, refreshing: true }));
      const result = await loader.current(controller.signal);
      if (stopped || controller.signal.aborted) return;
      setState((previous) =>
        result.ok
          ? { data: result.data, asOf: Date.now(), failure: null, settled: true, refreshing: false }
          : { ...previous, failure: result, settled: true, refreshing: false },
      );
      if (intervalMs !== null) timer = setTimeout(() => void tick(), intervalMs);
    };
    // A new key is a different read, so its old rows go; a reload of the same key keeps them on screen while it runs.
    if (shownKey.current !== key) setState({ data: null, asOf: null, failure: null, settled: false, refreshing: true });
    shownKey.current = key;
    void tick();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [key, revision, intervalMs]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const status = !state.settled ? 'loading' : state.data === null && state.failure ? 'error' : 'ready';
  return { status, data: state.data, asOf: state.asOf, failure: state.failure, refreshing: state.refreshing, reload };
}
