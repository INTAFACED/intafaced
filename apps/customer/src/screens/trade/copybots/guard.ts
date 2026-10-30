// One write at a time, with the request's identity kept on this device until the outcome is known.
// Same marker key and shape as the legacy trading rooms (features/trade/TradingTools.tsx), so an unresolved request
// from either room locks both. A lost reply ('uncertain') keeps the marker; the room then checks the real state
// (a follow in the list, a schedule by its id) before anything is sent again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../../features/session/session';
import type { ApiResult } from '../../../shared/api';

const markerSchema = z.object({
  kind: z.string(),
  id: z.string(),
  symbol: z.string(),
  operation: z.string().optional(),
  startedAt: z.number(),
});
export type Marker = z.infer<typeof markerSchema>;
export type Failure = Extract<ApiResult<unknown>, { ok: false }>;
export type Identity = { kind: 'convert' | 'rfq' | 'position' | 'algo' | 'copy' | 'grid'; id: string; symbol: string; operation?: string };

function read(key: string): { pending: Marker | null; blocked: boolean; storage: boolean } {
  try {
    const wire = localStorage.getItem(key);
    if (!wire) return { pending: null, blocked: false, storage: true };
    const parsed = markerSchema.safeParse(JSON.parse(wire));
    return { pending: parsed.success ? parsed.data : null, blocked: true, storage: true };
  } catch {
    return { pending: null, blocked: true, storage: false };
  }
}

/** Removes the marker only when it is still the one the caller checked (another tab may have replaced it meanwhile). */
export function clearIfSame(storage: Pick<Storage, 'getItem' | 'removeItem'>, key: string, expected: Marker): boolean {
  try {
    const wire = storage.getItem(key);
    if (!wire) return false;
    const parsed = markerSchema.safeParse(JSON.parse(wire));
    if (!parsed.success) return false;
    const stored = parsed.data;
    if (
      stored.kind !== expected.kind ||
      stored.id !== expected.id ||
      stored.startedAt !== expected.startedAt ||
      stored.operation !== expected.operation
    )
      return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** The id the service stores a bot under: a create is remembered by the id we chose, prefixed with the first 8 of the user id. */
export function algoServiceId(userId: string | null, pending: Marker): string {
  return pending.operation ? pending.id : `algo-${(userId ?? '').slice(0, 8)}-${pending.id}`;
}

const storageFailure: Failure = { ok: false, reason: 'error', message: '', code: 'device.storage_unavailable' };

export function useWriteGuard() {
  const { userId, session } = useSession();
  const key = `trade-pending:${userId ?? 'signed-out'}`;
  const [state, setState] = useState(() => read(key));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => setState(read(key));
    window.addEventListener('storage', refresh);
    window.addEventListener('trade-pending-change', refresh);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', refresh);
      window.removeEventListener('trade-pending-change', refresh);
    };
  }, [key]);

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(key);
      window.dispatchEvent(new Event('trade-pending-change'));
    } catch {
      /* the lock stays; the banner still tells the customer why */
    }
    setState(read(key));
  }, [key]);

  /** Clears the marker the caller checked, and only that one; a newer marker from another tab stays. */
  const settle = useCallback(
    (expected: Marker) => {
      try {
        if (clearIfSame(localStorage, key, expected)) window.dispatchEvent(new Event('trade-pending-change'));
      } catch {
        /* the lock stays; the banner still tells the customer why */
      }
      setState(read(key));
    },
    [key],
  );

  /** Sends one write. Returns true when the service answered ok. A lost reply keeps the marker and locks every write. */
  const run = useCallback(
    async function run<T>(identity: Identity, call: () => Promise<ApiResult<T>>, done: (data: T) => void): Promise<boolean> {
      const stored = read(key);
      if (!mounted.current || !session || inFlight.current || stored.blocked) {
        setState(stored);
        return false;
      }
      if (!('locks' in navigator)) {
        setFailure(storageFailure);
        return false;
      }
      inFlight.current = true;
      setBusy(true);
      setFailure(null);
      let ok = false;
      try {
        await navigator.locks.request(`trade-account:${userId ?? 'signed-out'}`, { ifAvailable: true }, async (lock) => {
          if (!lock || read(key).blocked) return;
          try {
            localStorage.setItem(key, JSON.stringify({ ...identity, startedAt: Date.now() }));
            window.dispatchEvent(new Event('trade-pending-change'));
          } catch {
            setFailure(storageFailure);
            return;
          }
          const result = await call();
          if (result.ok) {
            ok = true;
            done(result.data);
            clear();
          } else {
            setFailure(result);
            if (result.reason !== 'uncertain') clear();
            else setState(read(key));
          }
        });
      } finally {
        setBusy(false);
        inFlight.current = false;
      }
      return ok;
    },
    [key, session, userId, clear],
  );

  return {
    busy,
    locked: state.blocked,
    pending: state.pending,
    storageOk: state.storage,
    failure,
    setFailure,
    run,
    clear,
    settle,
    signedIn: Boolean(session),
  };
}
export type WriteGuard = ReturnType<typeof useWriteGuard>;
