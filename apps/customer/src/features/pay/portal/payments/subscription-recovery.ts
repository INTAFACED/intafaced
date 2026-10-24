import { z } from 'zod';
import type { BusinessPayApi } from '../../pay-api';
import { id, subscriptionSchema } from '../../schemas';
import type { ApiResult } from '../../../../shared/api';
import { payRefusal } from '../../copy';
import * as portalSchemas from '../schemas';
import { plainFailure } from '../refusal';
import { extensionCopy as c } from './copy';
import { definite, neverRan } from './not-available';

const unresolved = (): ApiResult<z.infer<typeof subscriptionSchema>> => ({
  ok: false,
  reason: 'uncertain',
  code: 'pay.operation_unresolved',
  message: c.t('subscriptionStillUnresolved'),
});

// Both creation surfaces share this admission. pay.mutate stores the attempt id
// and original charge path (and catalogue price, when one was chosen) on
// `subscription-create:${mandateId}`. Replays use that body; definite refusals
// clear the journal so a fresh attempt is allowed.
export async function createSubscriptionWithRecovery(pay: BusinessPayApi, mandateId: string, path: string, priceId?: string) {
  const input = z
    .object({ mandateId: id, path: z.enum(['crypto_invoice', 'card', 'card_mandate']), priceId: id.optional() })
    .safeParse({ mandateId, path, ...(priceId ? { priceId } : {}) });
  if (!input.success) return payRefusal('invalidInput', { reason: 'error' });
  // A call that never ran (the gateway has no such procedure) is a definite refusal, never an outcome to wait for.
  return plainFailure(
    definite(await pay.mutate('subscription.create', input.data, subscriptionSchema, 'pay:write', `subscription-create:${mandateId}`)),
  );
}

/**
 * Before any second create is sent, ask whether this mandate already has an open subscription. A create that committed
 * but lost its reply shows up here, so the check can finish without another request. A failed read says nothing: the
 * caller then falls back to resending the original request, which carries the same key and so cannot create a second one.
 */
async function findOpenSubscription(pay: BusinessPayApi, mandateId: string) {
  for (const status of ['active', 'paused'] as const) {
    const listed = await pay.query(
      'subscription.list',
      { merchantId: pay.authority!.merchantId, status, limit: 200 },
      portalSchemas.page(subscriptionSchema),
    );
    if (!listed.ok) return null;
    const found = listed.data.items.find((row) => row.mandateId === mandateId && row.merchantId === pay.authority!.merchantId);
    if (found) return found;
  }
  return null;
}

// A blank path must not be sent: the server binds the attempt id to the request
// body, and this form may have been reloaded. A departed view does not send.
export function replaySubscriptionCreate(
  pay: BusinessPayApi,
  mandateId: string,
  path: string,
  current: () => boolean,
  priceId?: string,
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
  return checkThenResend(pay, mandateId, path, priceId);
}
async function checkThenResend(
  pay: BusinessPayApi,
  mandateId: string,
  path: string,
  priceId: string | undefined,
): Promise<ApiResult<z.infer<typeof subscriptionSchema>>> {
  const existing = await findOpenSubscription(pay, mandateId);
  if (existing) {
    const lockId = `${pay.authority!.userId}:subscription-create:${mandateId}`;
    const held = pay.guard.original(lockId);
    if (held?.status === 'present') await pay.guard.resolve(lockId, held.raw);
    return { ok: true, data: existing };
  }
  return createSubscriptionWithRecovery(pay, mandateId, path, priceId);
}

export function checkSubscriptionOriginal(pay: BusinessPayApi, subscriptionId: string, current: () => boolean) {
  return pay.guard.checkOriginal(
    `${pay.authority!.userId}:subscription:${subscriptionId}`,
    async (original) => {
      // Not wrapped in definite(): this is a read of an outcome that may already exist, so "nothing was changed" would be wrong.
      const result = await pay.query('subscription.get', { subscriptionId }, subscriptionSchema);
      if (!result.ok) return neverRan(result) ? { ...result, message: c.t('subscriptionCheckFailed') } : result;
      if (result.data.id !== subscriptionId || result.data.status !== original.reference) return unresolved();
      return result;
    },
    current,
  );
}
