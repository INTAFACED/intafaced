'use client';
import { useEffect, useState } from 'react';

export type Resource<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'failed'; error: unknown };

/** Loads once per `key`, aborts the load the key replaced, and reloads on `reload()`. The admin app's one loading effect:
 * a desk reads its data through this, so its own code holds no effect. */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, key: string): { resource: Resource<T>; reload: () => void } {
  const [revision, setRevision] = useState(0);
  const effectiveKey = `${key}:${revision}`;
  const [state, setState] = useState<{ key: string; resource: Resource<T> }>({ key: effectiveKey, resource: { status: 'loading' } });
  useEffect(() => {
    const controller = new AbortController();
    setState({ key: effectiveKey, resource: { status: 'loading' } });
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key: effectiveKey, resource: { status: 'ready', data } });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ key: effectiveKey, resource: { status: 'failed', error } });
      },
    );
    return () => controller.abort();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the key, not the closure, decides when to load again
  }, [effectiveKey]);
  return { resource: state.key === effectiveKey ? state.resource : { status: 'loading' }, reload: () => setRevision((value) => value + 1) };
}
