import { useRef, useState } from 'react';
import { z } from 'zod';
import { useMounted } from '../../../../shared/outside';
import type { ApiResult } from '../../../../shared/api';
import type { subscriptionSchema } from '../../schemas';
import { extensionCopy as c } from './copy';

type Subscription = z.infer<typeof subscriptionSchema>;

/**
 * "Check the original request" for a subscription create whose reply was lost: one check at a time, its answer kept
 * as the message, nothing set once the room has gone. `Subscriptions.tsx`'s `SubscriptionRecovery` and its kit view
 * (`../flow/subscription-parts.tsx`) both run this.
 */
export function useSubscriptionCheck({
  check,
  onKnown,
  onSettled,
}: {
  check: (current: () => boolean) => Promise<ApiResult<Subscription>>;
  onKnown: (subscription: Subscription) => void;
  onSettled?: (result: ApiResult<Subscription>) => void;
}) {
  const mounted = useMounted();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await check(() => mounted.current);
      if (!mounted.current) return;
      if (result.ok) onKnown(result.data);
      else setMessage(result.reason === 'uncertain' || result.reason === 'aborted' ? c.t('subscriptionStillUnresolved') : result.message);
      onSettled?.(result);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, message, run };
}
