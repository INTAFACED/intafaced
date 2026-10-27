import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';

/** The rail svc-pay records for a send to another account's platform address (W-withdraw-14). */
export const INTERNAL_RAIL = 'internal';

// hand-declared-ok: svc-pay declares `withdrawal.destination`'s output in its router; there is no contracts schema for it.
/** svc-pay `withdrawal.destination`: where an address leads. It never names the other account. */
export const withdrawDestinationSchema = z.union([
  z.object({ kind: z.enum(['internal', 'self', 'external']) }),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['expired', 'unavailable']) }),
]);
export type WithdrawDestination = z.infer<typeof withdrawDestinationSchema>;

export type DestinationRead = { state: 'idle' } | { state: 'checking' } | { state: 'failed' } | ({ state: 'known' } & WithdrawDestination);

/** Something an address could be: a run of 8 to 256 characters with no space. Shorter text is still being typed. */
const ADDRESS_LIKE = /^\S{8,256}$/;

/**
 * Asks svc-pay where a typed wallet address leads, once it looks like an address (8 to 256 characters, no space): another
 * INTAFACED account (the send settles inside, at once, with no network fee), one of the person's own addresses (refused as a
 * send to yourself), a platform address that cannot take a transfer now, or somewhere outside. Anything else is `idle`.
 */
export function useWithdrawDestination(address: string): DestinationRead {
  const { api } = useSession();
  const ref = address.trim();
  const whole = ADDRESS_LIKE.test(ref);
  const [read, setRead] = useState<{ ref: string; read: DestinationRead }>({ ref: '', read: { state: 'idle' } });
  useEffect(() => {
    if (!whole) return;
    const controller = new AbortController();
    // A short pause, so a pasted address is asked about once and typing does not ask on every key.
    const timer = setTimeout(() => {
      void api
        .query('pay', 'withdrawal.destination', { destination: { kind: 'crypto', ref } }, withdrawDestinationSchema, {
          signal: controller.signal,
        })
        .then((result) => {
          if (controller.signal.aborted) return;
          setRead({ ref, read: result.ok ? { state: 'known', ...result.data } : { state: 'failed' } });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, ref, whole]);
  if (!whole) return { state: 'idle' };
  return read.ref === ref ? read.read : { state: 'checking' };
}
