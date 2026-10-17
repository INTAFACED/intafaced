/**
 * The one way these rooms send a request that changes money or state.
 * It wraps `runGuarded` (device note + browser lock, shared with the spot desk and Convert): one request at a time,
 * a note that survives a reload, and an unknown outcome stays locked until the person checks it. Nothing re-sends.
 */
import { useCallback, useRef, useState } from 'react';
import type { ApiResult } from '../../../shared/api';
import { usePendingNote } from '../buy/order-flow';
import { clearPending, runGuarded, type BlockReason, type Pending } from '../buy/write-lock';
import { useSession } from './ui';
import { roomWords, type Words } from './refusals';

export interface Intent<T> {
  kind: Pending['kind'];
  /** Stable identity of this one request; a re-send of the same intent must reuse it. */
  id: string;
  symbol: string;
  call: () => Promise<ApiResult<T>>;
}

export type WriteOutcome<T> =
  | { kind: 'idle' }
  | { kind: 'blocked'; reason: BlockReason; pending?: Pending }
  | { kind: 'done'; data: T }
  | { kind: 'refused'; words: Words }
  /** No verified answer. The note stays; the person checks the original before anything else is sent. */
  | { kind: 'uncertain'; id: string; words: Words };

export const BLOCK_WORDS: Readonly<Record<BlockReason, string>> = {
  signedOut: 'Sign in to do this.',
  pending: 'An earlier trading request is still unconfirmed. Check it first; new requests stay locked until then.',
  unreadable: 'This device holds an unreadable trading note, so new requests are locked. Contact support with the request id.',
  storage: 'This browser cannot save a note of the request, so nothing was sent. Turn on device storage and try again.',
  otherTab: 'Another tab is sending a trading request right now. Wait for it to finish.',
  noLocks: 'This browser cannot coordinate trading across tabs. Use a current browser.',
};

export function useRoomWriter() {
  const { userId } = useSession();
  const note = usePendingNote(userId);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome<unknown>>({ kind: 'idle' });
  const inFlight = useRef(false);

  const run = useCallback(
    async <T>(intent: Intent<T>): Promise<WriteOutcome<T>> => {
      if (inFlight.current) return { kind: 'blocked', reason: 'otherTab' };
      inFlight.current = true;
      setBusy(true);
      let result: WriteOutcome<T>;
      try {
        const ran = await runGuarded(
          userId,
          { kind: intent.kind, symbol: intent.symbol, id: intent.id, startedAt: Date.now() },
          intent.call,
          (value) => !value.ok && value.reason === 'uncertain',
        );
        if (ran.kind === 'blocked') result = { kind: 'blocked', reason: ran.reason, pending: ran.pending };
        else if (ran.kind === 'threw') result = { kind: 'uncertain', id: intent.id, words: roomWords({ reason: 'uncertain' }) };
        else if (ran.value.ok) result = { kind: 'done', data: ran.value.data };
        else if (ran.value.reason === 'uncertain') result = { kind: 'uncertain', id: intent.id, words: roomWords(ran.value) };
        else result = { kind: 'refused', words: roomWords(ran.value) };
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
      setOutcome(result);
      return result;
    },
    [userId],
  );

  /** After a status check proves what happened to the original request, drop its note. */
  const resolve = useCallback(
    (id: string) => {
      if (userId) clearPending(userId, id);
      setOutcome({ kind: 'idle' });
    },
    [userId],
  );
  const dismiss = useCallback(() => setOutcome({ kind: 'idle' }), []);

  return { busy, outcome, note, run, resolve, dismiss, signedIn: Boolean(userId) };
}
export type RoomWriter = ReturnType<typeof useRoomWriter>;
