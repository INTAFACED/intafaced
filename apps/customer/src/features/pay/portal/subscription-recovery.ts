import { z } from 'zod';
import type { BusinessPayApi } from '../pay-api';
import { id, subscriptionSchema } from '../schemas';
import type { ApiResult } from '../../../shared/api';
import { payRefusal } from '../copy';
import { extensionCopy as c } from './extension-copy';

const unresolved = (): ApiResult<z.infer<typeof subscriptionSchema>> => ({
  ok: false,
  reason: 'uncertain',
  code: 'pay.operation_unresolved',
  message: c.t('subscriptionStillUnresolved'),
});

// Both creation surfaces share this admission. pay.mutate stores the attempt id
// on `subscription-create:${mandateId}` and replays that attempt while the lock
// is uncertain. A confirmed outcome or a definite refusal clears it.
export async function createSubscriptionWithRecovery(pay: BusinessPayApi, mandateId: string, path: string) {
  const input = z.object({ mandateId: id, path: z.enum(['crypto_invoice', 'card', 'card_mandate']) }).safeParse({ mandateId, path });
  if (!input.success) return payRefusal('invalidInput', { reason: 'error' });
  return pay.mutate('subscription.create', input.data, subscriptionSchema, 'pay:write', `subscription-create:${mandateId}`);
}

// A blank path must not be sent: the server binds the attempt id to the request
// body, and this form may have been reloaded. A departed view does not send.
export function replaySubscriptionCreate(
  pay: BusinessPayApi,
  mandateId: string,
  path: string,
  current: () => boolean,
): Promise<ApiResult<z.infer<typeof subscriptionSchema>>> {
  if (!current()) {
    return Promise.resolve(
      payRefusal('theOriginalActionHasNotBeenConfirmed', {
        code: 'pay.reconciliation_context_changed',
        reason: 'aborted',
      }),
    );
  }
  if (!path) return Promise.resolve(unresolved());
  return createSubscriptionWithRecovery(pay, mandateId, path);
}

export function checkSubscriptionOriginal(pay: BusinessPayApi, subscriptionId: string, current: () => boolean) {
  return pay.guard.checkOriginal(
    `${pay.authority!.userId}:subscription:${subscriptionId}`,
    async (original) => {
      const result = await pay.query('subscription.get', { subscriptionId }, subscriptionSchema);
      if (!result.ok) return result;
      if (result.data.id !== subscriptionId || result.data.status !== original.reference) return unresolved();
      return result;
    },
    current,
  );
}
