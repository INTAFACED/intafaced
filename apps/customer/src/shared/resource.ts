import { useEffect, useState } from 'react';
import type { ApiResult } from './api';

export type Resource<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'failed'; failure: Extract<ApiResult<T>, { ok: false }> };

export function useResource<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>, key: string): { resource: Resource<T>; reload: () => void } {
  const [revision, setRevision] = useState(0);
  const effectiveKey = `${key}:${revision}`;
  const [state, setState] = useState<{ key: string; resource: Resource<T> }>({ key: effectiveKey, resource: { status: 'loading' } });
  useEffect(() => {
    const controller = new AbortController();
    setState({ key: effectiveKey, resource: { status: 'loading' } });
    void load(controller.signal).then((result) => {
      if (!controller.signal.aborted) setState({ key: effectiveKey, resource: result.ok ? { status: 'ready', data: result.data } : { status: 'failed', failure: result } });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ key: effectiveKey, resource: { status: 'failed', failure: { ok: false, reason: 'error', message: 'This information could not be loaded.' } } });
    });
    return () => controller.abort();
  }, [effectiveKey]);
  return { resource: state.key === effectiveKey ? state.resource : { status: 'loading' }, reload: () => setRevision((value) => value + 1) };
}
