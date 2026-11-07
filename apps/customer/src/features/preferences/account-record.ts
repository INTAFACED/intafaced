/**
 * One record the account keeps through the identity preferences door (a view record: saved desk layouts, chart
 * templates), read once per person and written with compare-and-set on its version through `rebaseAndWrite`: a change
 * runs on the record as read, and on a conflict once more on the newer record. Only the signed-in account's own record is
 * ever read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ZodType } from 'zod';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { CONFLICT, rebaseAndWrite, type RecordIo } from '../watchlists/rebase';

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

export type AccountRecord<T> =
  | { status: 'signed-out' }
  | { status: 'loading' }
  | { status: 'failed'; reload: () => void }
  | { status: 'ready'; value: T };

/** How a write ended: stored, or refused with the account's code (`reply.unknown` when the reply was lost; the record was read again). */
export type RecordWrite = { ok: true } | { ok: false; code: string };

export const REPLY_UNKNOWN = 'reply.unknown';
const isConflict = (result: Failure) => result.status === 409 || result.code === 'CONFLICT' || result.message.includes(CONFLICT);
const isUncertain = (result: Failure) => result.reason === 'uncertain' || result.reason === 'unreachable';

export function useAccountRecord<T>(options: {
  namespace: string;
  schema: ZodType<{ version: number; value: T | null }>;
  /** The reply to a stored write: the schema with `outcome: 'stored'`. */
  stored: ZodType<{ version: number; value: T | null }>;
  empty: T;
  requestId: (userId: string, ifVersion: number, value: T) => string;
}) {
  const { namespace, schema, stored, empty, requestId } = options;
  const { api, userId } = useSession();
  const [record, setRecord] = useState<AccountRecord<T>>(userId ? { status: 'loading' } : { status: 'signed-out' });
  const [revision, setRevision] = useState(0);
  const held = useRef<{ version: number; value: T } | null>(null);

  const read = useCallback(
    async (signal?: AbortSignal) => api.query('identity', 'preferences.get', { namespace }, schema, { signal }),
    [api, namespace, schema],
  );
  const adopt = useCallback(
    (version: number, value: T | null) => {
      held.current = { version, value: value ?? empty };
      setRecord({ status: 'ready', value: value ?? empty });
    },
    [empty],
  );

  useEffect(() => {
    held.current = null;
    if (!userId) {
      setRecord({ status: 'signed-out' });
      return;
    }
    const controller = new AbortController();
    setRecord({ status: 'loading' });
    void read(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) adopt(result.data.version, result.data.value);
      else setRecord({ status: 'failed', reload: () => setRevision((count) => count + 1) });
    });
    return () => controller.abort();
  }, [userId, read, adopt, revision]);

  const change = useCallback(
    async (update: (value: T) => T): Promise<RecordWrite> => {
      const start = held.current;
      if (!userId || !start) return { ok: false, code: 'auth.required' };
      const io: RecordIo<T> = {
        read: async () => {
          const result = await read();
          return result.ok ? { version: result.data.version, value: result.data.value } : null;
        },
        write: async (value, ifVersion) => {
          const result = await api.mutate(
            'identity',
            'preferences.set',
            { namespace, value, ifVersion, clientRequestId: requestId(userId, ifVersion, value) },
            stored,
          );
          if (result.ok) return { ok: true, version: result.data.version, value: result.data.value };
          return { ok: false, code: isConflict(result) ? CONFLICT : isUncertain(result) ? REPLY_UNKNOWN : (result.code ?? result.message) };
        },
      };
      const written = await rebaseAndWrite(start, io, update, empty);
      if (written.record) adopt(written.record.version, written.record.value);
      if (written.outcome.ok) return { ok: true };
      if (written.outcome.code === REPLY_UNKNOWN) {
        const latest = await io.read();
        if (latest) adopt(latest.version, latest.value);
      }
      return { ok: false, code: written.outcome.code };
    },
    [api, userId, namespace, read, stored, adopt, empty, requestId],
  );

  return { record, change };
}
