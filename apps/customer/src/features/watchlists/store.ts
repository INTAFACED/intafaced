/**
 * A record a person keeps on the account through the identity preferences door (`trade.watchlists`, `trade.screens`). The account
 * record is the source of truth: every change is a compare-and-set on the version read, and a conflict re-reads the newer record
 * instead of writing over it. A refusal from the owner's caps (or a blank cap) comes back with its identity code, so the screen
 * can say why nothing was saved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { z, type ZodType } from 'zod';
import {
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
  /** Store `next` on the account. The change shows at once; a refusal puts the last saved value back. */
  commit: (next: T) => Promise<CommitOutcome>;
  reload: () => void;
}

/** The code inside a refusal: the identity code the service sent (`identity.watchlist_cap_exceeded`), else 'not-saved'. */
export function refusalCode(message: string | undefined): string {
  const match = /identity\.[a-z_]+|preferences\.version_conflict/.exec(message ?? '');
  return match ? match[0] : 'not-saved';
}

/** One account record (a namespace), read and written with compare-and-set. */
export function useAccountRecord<T>(
  namespace: string,
  preference: ZodType<{ version: number; value: T | null }>,
  requestId: (userId: string, ifVersion: number, value: T) => string,
  empty: T,
): RecordStore<T> {
  const { api, userId } = useSession();
  const [status, setStatus] = useState<RecordStatus>(userId ? 'loading' : 'signed-out');
  const [value, setValue] = useState<T>(empty);
  const version = useRef(0);
  const saved = useRef<T>(empty);
  // Writes wait for the read: until the account record is read, there is no version to compare against.
  const readyRef = useRef(false);
  // Writes run one after another, so each reads the version the one before it stored.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // The reply carries the stored version and value, and an outcome. It is not strict: the outcome is an extra key.
  const stored = z.object({ outcome: z.literal('stored'), version: z.number().int(), value: z.unknown() });

  const adopt = useCallback((nextVersion: number, next: T | null) => {
    version.current = nextVersion;
    saved.current = next ?? empty;
    readyRef.current = true;
    setValue(next ?? empty);
    setStatus('ready');
    // `empty` is a constant per caller; the record is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(() => {
    if (!userId) {
      setStatus('signed-out');
      return;
    }
    setStatus('loading');
    readyRef.current = false;
    void api.query('identity', 'preferences.get', { namespace }, preference).then((result) => {
      if (result.ok) adopt(result.data.version, result.data.value);
      else {
        // A failed read is not an empty account: nothing is written over the record until a read succeeds.
        readyRef.current = false;
        setStatus('error');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, userId, namespace, adopt]);

  useEffect(() => reload(), [reload]);

  const send = useCallback(
    async (next: T): Promise<CommitOutcome> => {
      if (!userId) return { ok: false, code: 'auth.required' };
      if (!readyRef.current) return { ok: false, code: 'not-saved' };
      const ifVersion = version.current;
      setValue(next);
      const result = await api.mutate(
        'identity',
        'preferences.set',
        { namespace, value: next, ifVersion, clientRequestId: requestId(userId, ifVersion, next) },
        stored,
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
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, userId, namespace, adopt, reload, stored],
  );
  const commit = useCallback(
    (next: T): Promise<CommitOutcome> => {
      const run = queue.current.then(() => send(next));
      queue.current = run.catch(() => undefined);
      return run;
    },
    [send],
  );

  return { status, value, commit, reload };
}

/** The account's watchlists (`trade.watchlists`). */
export function useWatchlists(): RecordStore<WatchlistsValue> {
  return useAccountRecord<WatchlistsValue>(WATCHLISTS_NAMESPACE, watchlistsPreferenceSchema, watchlistsRequestId, []);
}
