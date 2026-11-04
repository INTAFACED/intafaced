import { useEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../../shared/api';

/**
 * Reads `load` now and every `everyMs` while mounted, keeping the last good answer on screen between reads (a list that
 * blinks empty on every refresh would make its counts jump). `failure` is the last read's refusal, cleared by a good one.
 * A load that answers null means there is nothing to read yet (no wallet), and clears the data.
 */
export function usePolled<T>(load: (signal: AbortSignal) => Promise<ApiResult<T> | null>, key: string, everyMs: number) {
  const [state, setState] = useState<{ key: string; data: T | null; failure: Extract<ApiResult<T>, { ok: false }> | null }>({
    key,
    data: null,
    failure: null,
  });
  const [revision, setRevision] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await loader.current(controller.signal);
        if (controller.signal.aborted) return;
        if (result === null) setState({ key, data: null, failure: null });
        else if (result.ok) setState({ key, data: result.data, failure: null });
        else setState((previous) => ({ key, data: previous.key === key ? previous.data : null, failure: result }));
      } catch {
        /* a read that threw is tried again on the next tick */
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void read(), everyMs);
    };
    void read();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [key, everyMs, revision]);
  const current = state.key === key ? state : { data: null, failure: null };
  return { data: current.data, failure: current.failure, reload: () => setRevision((value) => value + 1) };
}
