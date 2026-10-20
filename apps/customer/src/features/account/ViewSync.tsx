import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSession } from '../session/session';
import { accountFields, createViewSync, type ViewSync, type ViewSyncStatus } from '../../shared/view-sync';
import { currentPreferences, savePreferences, usePreferences } from '../../shared/preferences';

let status: ViewSyncStatus = 'idle';
const listeners = new Set<() => void>();
function setStatus(next: ViewSyncStatus) {
  if (next === status) return;
  status = next;
  for (const notify of [...listeners]) notify();
}
/** `not-saved` when the last write to the account was refused or could not be sent. */
export function useAccountViewStatus(): ViewSyncStatus {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => status,
    () => 'idle',
  );
}

/** How long a run of changes (a slider, a quick toggle) waits before one write goes out. */
const SETTLE_MS = 500;

/**
 * Renders nothing. While someone is signed in it reads the account's view record (it wins over this device's copy) and writes
 * later changes back. Signed out, the device copy is the only copy.
 */
export function AccountViewSync() {
  const { api, userId } = useSession();
  const preferences = usePreferences();
  const apiRef = useRef(api);
  apiRef.current = api;
  const sync = useRef<{ view: ViewSync; signal: AbortSignal } | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!userId) {
      sync.current = null;
      setReady(false);
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    const next = createViewSync({
      api: () => apiRef.current,
      userId,
      local: currentPreferences,
      applyRemote: (patch) => savePreferences(patch),
    });
    sync.current = { view: next, signal: controller.signal };
    void next.pull(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setStatus(result);
      setReady(true);
    });
    return () => {
      controller.abort();
      sync.current = null;
      setReady(false);
    };
  }, [userId]);
  const fields = JSON.stringify(accountFields(preferences));
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      // Tied to the sign-in that made it: a result that lands after sign-out or an account switch is dropped.
      const current = sync.current;
      if (current) void current.view.push(current.signal).then((result) => sync.current === current && setStatus(result));
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [ready, fields]);
  return null;
}
