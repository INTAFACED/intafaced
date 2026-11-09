/**
 * Instant placement (J-charts-desk-14 #6, C-trade-dom-02): the account's `trade.instant` record, read through the identity
 * preferences door and written with compare-and-set on the version read.
 *
 * Off unless the record says on: signed out, still loading, unreadable, or an empty record all read as off, so a click
 * always reviews unless the account holds the person's agreement. Turning it on writes the agreement's version and the
 * moment the person accepted it; turning it off clears both. A write that fails or whose answer is lost re-reads the
 * record and shows what the account holds, never what was asked for.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  TRADE_INSTANT_AGREEMENT,
  TRADE_INSTANT_NAMESPACE,
  TRADE_INSTANT_OFF,
  tradeInstantPreferenceSchema,
  tradeInstantRequestId,
  type TradeInstantValue,
} from '@intafaced/contracts/trade-instant-preferences';
import { useSession } from '../../../features/session/session';

export type InstantState =
  { status: 'signed-out' } | { status: 'loading' } | { status: 'failed' } | { status: 'ready'; value: TradeInstantValue };

export type InstantWrite = 'saved' | 'not-saved' | 'unknown';

const storedSchema = tradeInstantPreferenceSchema.extend({ outcome: z.literal('stored') });

/** Instant placement is on only when the account's record says so, with the current agreement. */
export const instantOn = (state: InstantState): boolean =>
  state.status === 'ready' && state.value.on && state.value.agreement === TRADE_INSTANT_AGREEMENT;

export function useInstantPlacement() {
  const { api, userId } = useSession();
  const [state, setState] = useState<InstantState>(userId ? { status: 'loading' } : { status: 'signed-out' });
  const version = useRef<number | null>(null);
  const busy = useRef(false);

  const read = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api.query('identity', 'preferences.get', { namespace: TRADE_INSTANT_NAMESPACE }, tradeInstantPreferenceSchema, {
        signal,
      });
      if (signal?.aborted) return;
      if (result.ok) {
        version.current = result.data.version;
        setState({ status: 'ready', value: result.data.value ?? TRADE_INSTANT_OFF });
      } else {
        version.current = null;
        setState({ status: 'failed' });
      }
    },
    [api],
  );

  useEffect(() => {
    version.current = null;
    if (!userId) {
      setState({ status: 'signed-out' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    void read(controller.signal);
    return () => controller.abort();
  }, [userId, read]);

  const write = useCallback(
    async (value: TradeInstantValue): Promise<InstantWrite> => {
      const ifVersion = version.current;
      if (!userId || ifVersion === null || busy.current) return 'not-saved';
      busy.current = true;
      try {
        const result = await api.mutate(
          'identity',
          'preferences.set',
          { namespace: TRADE_INSTANT_NAMESPACE, value, ifVersion, clientRequestId: tradeInstantRequestId(userId, ifVersion, value) },
          storedSchema,
        );
        if (result.ok) {
          version.current = result.data.version;
          setState({ status: 'ready', value: result.data.value ?? TRADE_INSTANT_OFF });
          return 'saved';
        }
        // Refused, a newer record, or an answer lost on the way: show what the account holds now.
        await read();
        return result.reason === 'uncertain' || result.reason === 'unreachable' ? 'unknown' : 'not-saved';
      } finally {
        busy.current = false;
      }
    },
    [api, userId, read],
  );

  /** On, with the agreement the person just accepted and the moment they accepted it. */
  const turnOn = useCallback(
    (agreedAt: Date) => write({ on: true, agreement: TRADE_INSTANT_AGREEMENT, agreedAt: agreedAt.toISOString() }),
    [write],
  );
  const turnOff = useCallback(() => write(TRADE_INSTANT_OFF), [write]);

  return { state, on: instantOn(state), turnOn, turnOff };
}
