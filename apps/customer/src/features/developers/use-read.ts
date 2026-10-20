import { useCallback, useEffect, useState } from 'react';
import type { ApiResult } from '../../shared/api';

export type Read<T> = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; data: T };

/** Run one read when the page opens and again whenever `deps` change; `reload` runs it again after a failure. */
export function useRead<T>(
  run: (signal: AbortSignal) => Promise<ApiResult<T>>,
  deps: readonly unknown[],
): { read: Read<T>; reload: () => void } {
  const [read, setRead] = useState<Read<T>>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setRead({ status: 'loading' });
    void run(controller.signal).then((result) => {
      if (!controller.signal.aborted) setRead(result.ok ? { status: 'ready', data: result.data } : { status: 'failed' });
    });
    return () => controller.abort();
    // `run` is rebuilt every render; the caller's deps say when the read really changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, revision]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { read, reload };
}
