/**
 * A record a person keeps on the account through the identity preferences door (`trade.watchlists`, `trade.screens`). The account
 * record is the source of truth: every change is a compare-and-set on the version read, and a conflict re-reads the newer record
 * instead of writing over it. Writes run one after another, and none is sent until the record has been read: a failed read
 * shows an error with a retry, never an empty record that a write would then overwrite from version 0.
 * A refusal from the owner's caps (or a blank cap) comes back with its identity code, so the screen can say why nothing was saved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { z, type ZodType } from 'zod';
import {
  savedScreensPreferenceSchema,
  watchlistsRequestId,
  watchlistsPreferenceSchema,
  WATCHLISTS_NAMESPACE,
  type WatchlistsValue,
} from '@intafaced/contracts/watchlists-preferences';
import { useSession } from '../session/session';

export type RecordStatus = 'loading' | 'ready' | 'signed-out' | 'error';
export type CommitOutcome = { ok: true } | { ok: false; code: string };

export interface RecordStore<T> {
  status: RecordStatus;
  value: T;
  /** A write is on its way: controls that change the record stay disabled until it answers. */
  busy: boolean;
  /** Store `next` on the account. Refused until the record has been read. A refusal puts the last saved value back. */
  commit: (next: T) => Promise<CommitOutcome>;
  reload: () => void;
}

/** The stored reply of a set: the record as the account now holds it, with the outcome. */
export const watchlistsStoredSchema = watchlistsPreferenceSchema.extend({ outcome: z.literal('stored') });
/** The stored reply of a saved-screens set (`trade.screens`). */
export const savedScreensStoredSchema = savedScreensPreferenceSchema.extend({ outcome: z.literal('stored') });

/** The code inside a refusal: the identity code the service sent (`identity.watchlist_cap_exceeded`), else 'not-saved'. */
export function refusalCode(message: string | undefined): string {
  const match = /identity\.[a-z_]+|preferences\.version_conflict/.exec(message ?? '');
  return match ? match[0] : 'not-saved';
}

/** One account record (a namespace), read and written with compare-and-set. `read` checks a get; `stored` checks a set's reply. */
export function useAccountRecord<T>(
  namespace: string,
  schemas: { read: ZodType<{ version: number; value: T | null }>; stored: ZodType<{ version: number; value: T | null }> },
  requestId: (userId: string, ifVersion: number, value: T) => string,
  empty: T,
): RecordStore<T> {
  const { api, userId } = useSession();
  const [status, setStatus] = useState<RecordStatus>(userId ? 'loading' : 'signed-out');
  const [value, setValue] = useState<T>(empty);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const saved = useRef<T>(empty);
  /** Writes go only from a record that was read. Cleared on any read start or sign-out. */
  const ready = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);

  const adopt = useCallback((nextVersion: number, next: T | null) => {
    version.current = nextVersion;
    saved.current = next ?? empty;
    ready.current = true;
    setValue(next ?? empty);
    setStatus('ready');
    // `empty` is a constant per caller; the record is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(() => {
    ready.current = false;
    if (!userId) {
      version.current = 0;
      saved.current = empty;
      setValue(empty);
      setStatus('signed-out');
      return;
    }
    setStatus('loading');
    void api.query('identity', 'preferences.get', { namespace }, schemas.read).then((result) => {
      if (result.ok) adopt(result.data.version, result.data.value);
      else {
        ready.current = false;
        setStatus('error');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, userId, namespace, adopt]);

  useEffect(() => reload(), [reload]);

  const send = async (next: T): Promise<CommitOutcome> => {
    if (!userId) return { ok: false, code: 'auth.required' };
    if (!ready.current) return { ok: false, code: 'not-loaded' };
    const ifVersion = version.current;
    setValue(next);
    const result = await api.mutate(
      'identity',
      'preferences.set',
      { namespace, value: next, ifVersion, clientRequestId: requestId(userId, ifVersion, next) },
      schemas.stored,
    );
    if (result.ok) {
      adopt(result.data.version, result.data.value as T | null);
      return { ok: true };
    }
    const code = refusalCode(result.message);
    if (code === 'preferences.version_conflict') {
      // Another device wrote first: keep the newer record, and say so.
      reload();
      return { ok: false, code };
    }
    setValue(saved.current);
    return { ok: false, code };
  };

  const commit = useCallback(
    (next: T): Promise<CommitOutcome> => {
      // Each write waits for the one before it, so every write carries the version the last one stored.
      pending.current += 1;
      setBusy(true);
      const run = queue.current.then(() => send(next));
      queue.current = run.catch(() => undefined);
      return run.finally(() => {
        pending.current -= 1;
        if (pending.current === 0) setBusy(false);
      }) as Promise<CommitOutcome>;
    },
    // `send` closes over the current session and version refs; the refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, userId, namespace, adopt, reload],
  );

  return { status, value, busy, commit, reload };
}

/** The account's watchlists (`trade.watchlists`). */
export function useWatchlists(): RecordStore<WatchlistsValue> {
  return useAccountRecord<WatchlistsValue>(
    WATCHLISTS_NAMESPACE,
    { read: watchlistsPreferenceSchema, stored: watchlistsStoredSchema },
    watchlistsRequestId,
    [],
  );
}
