import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../../../features/session/session';
import type { Pending, PendingState } from '../buy/write-lock';
import { useFuturesApi } from './data';
import { checkPending, readPending, runIntent, type Intent, type WriteOutcome } from './write';

/** The device note of an unresolved trade write (any kind), kept in step with other tabs and other screens. */
export function usePendingNote(userId: string | null): PendingState {
  const [state, setState] = useState<PendingState>(() => readPending(userId));
  useEffect(() => {
    const refresh = () => setState(readPending(userId));
    refresh();
    window.addEventListener('trade-pending-change', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('trade-pending-change', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [userId]);
  return state;
}

export interface Writer {
  /** A write or a status check is in flight. */
  busy: boolean;
  /** The last finished outcome of this panel, until `dismiss`. */
  outcome: WriteOutcome | null;
  note: PendingState;
  /** True when a new write must not start: busy, or an unresolved note exists. */
  locked: boolean;
  run(intent: Intent): Promise<WriteOutcome>;
  /** Look up the unresolved request with the same identity. Never builds a new request. */
  check(pending: Pending): Promise<WriteOutcome>;
  dismiss(): void;
}

/** One writer per panel. Resolves once per call; ignores a second call while one is in flight. */
export function useFuturesWriter(onDone?: () => void): Writer {
  const { userId } = useSession();
  const api = useFuturesApi();
  const note = usePendingNote(userId);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const inflight = useRef(false);
  const mounted = useRef(true);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const finish = useCallback((result: WriteOutcome) => {
    if (mounted.current) setOutcome(result);
    if (result.kind === 'done') done.current?.();
    return result;
  }, []);
  const run = useCallback(
    async (intent: Intent): Promise<WriteOutcome> => {
      if (inflight.current) return { kind: 'blocked', reason: 'otherTab' };
      inflight.current = true;
      setBusy(true);
      try {
        return finish(await runIntent(api, userId, intent));
      } finally {
        inflight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [api, userId, finish],
  );
  const check = useCallback(
    async (pending: Pending): Promise<WriteOutcome> => {
      if (inflight.current) return { kind: 'blocked', reason: 'otherTab' };
      inflight.current = true;
      setBusy(true);
      try {
        return finish(await checkPending(api, userId, pending));
      } finally {
        inflight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [api, userId, finish],
  );
  const dismiss = useCallback(() => setOutcome(null), []);
  return { busy, outcome, note, locked: busy || note.state !== 'none', run, check, dismiss };
}

/** A fresh request nonce for one intent. Kept in component state so the same intent re-sends the same id. */
export function newNonce(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 24);
}
