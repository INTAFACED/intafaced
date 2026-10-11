import { useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useSession } from '../session/session';

/** A private P2P view retires in the observed event, before React may batch
 * departure and return. Retiring this view never removes an original journal. */
export function useP2PView() {
  const { api, userId, session } = useSession();
  const token = session?.accessToken ?? null;
  const version = useRef({ api, userId, token, href: location.href, epoch: 0 });
  if (
    version.current.api !== api ||
    version.current.userId !== userId ||
    version.current.token !== token ||
    version.current.href !== location.href
  )
    version.current = { api, userId, token, href: location.href, epoch: version.current.epoch + 1 };
  const context = version.current;
  const mounted = useRef(true);
  const [, invalidate] = useReducer((value: number) => value + 1, 0);
  useLayoutEffect(() => {
    mounted.current = true;
    const departed = (event: Event) => {
      const href = event instanceof HashChangeEvent && event.newURL ? event.newURL : location.href;
      if (version.current.href === href) return;
      version.current = { ...version.current, href, epoch: version.current.epoch + 1 };
      flushSync(invalidate);
    };
    const originalChanged = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(`pay.unresolved:${version.current.userId}:`)) return;
      try {
        if (event.storageArea !== localStorage) return;
      } catch {
        // If original storage itself became unreadable, retire the review.
        // The journal still refuses admission; no notification clears it.
      }
      // Another tab's original may retire this review; it never becomes an
      // acknowledgement, nor can its notification erase that original.
      version.current = { ...version.current, epoch: version.current.epoch + 1 };
      flushSync(invalidate);
    };
    window.addEventListener('popstate', departed);
    window.addEventListener('hashchange', departed);
    window.addEventListener('storage', originalChanged);
    return () => {
      mounted.current = false;
      window.removeEventListener('popstate', departed);
      window.removeEventListener('hashchange', departed);
      window.removeEventListener('storage', originalChanged);
    };
  }, []);
  return useMemo(
    () => ({
      api,
      userId,
      epoch: context.epoch,
      current: () => mounted.current && version.current === context && location.href === context.href && !!userId && api.canWrite(),
    }),
    [context],
  );
}
export type P2PView = ReturnType<typeof useP2PView>;
