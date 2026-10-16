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

// Both creation surfaces must record the same proof and use the same admission lock.
export async function createSubscriptionWithRecovery(pay: BusinessPayApi, mandateId: string, path: string) {
  const input = z.object({ mandateId: id, path: z.enum(['crypto_invoice', 'card', 'card_mandate']) }).safeParse({ mandateId, path });
  if (!input.success) return payRefusal('invalidInput', { reason: 'error' });
  const existing = await pay.query('subscription.list', { merchantId: pay.authority!.merchantId, limit: 200 }, z.array(subscriptionSchema));
  if (!existing.ok) return existing;
  const reference = JSON.stringify({
    path,
    after: new Date().toISOString(),
    existingIds: existing.data.filter((s) => s.mandateId === mandateId).map((s) => s.id),
  });
  return pay.mutate('subscription.create', input.data, subscriptionSchema, 'pay:write', `subscription-create:${mandateId}`, reference);
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

export function checkSubscriptionCreateOriginal(pay: BusinessPayApi, mandateId: string, current: () => boolean) {
  return pay.guard.checkOriginal(
    `${pay.authority!.userId}:subscription-create:${mandateId}`,
    async (original) => {
      const result = await pay.query(
        'subscription.list',
        { merchantId: pay.authority!.merchantId, limit: 200 },
        z.array(subscriptionSchema),
      );
      if (!result.ok) return result;
      // An older schedule on the same mandate cannot prove this create succeeded.
      const proof = z.object({ path: z.string(), after: z.string().datetime(), existingIds: z.array(z.string()) }).safeParse(
        (() => {
          try {
            return JSON.parse(original.reference ?? 'null');
          } catch {
            return null;
          }
        })(),
      );
      if (!proof.success) return unresolved();
      const matches = result.data.filter(
        (s) =>
          s.mandateId === mandateId &&
          s.path === proof.data.path &&
          !proof.data.existingIds.includes(s.id) &&
          Date.parse(s.createdAt) >= Date.parse(proof.data.after),
      );
      return matches.length === 1 ? { ok: true as const, data: matches[0]! } : unresolved();
    },
    current,
  );
}
