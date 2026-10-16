import { z } from 'zod';
import type { BusinessPayApi } from '../pay-api';
import { subscriptionSchema } from '../schemas';
import type { ApiResult } from '../../../shared/api';
import { extensionCopy as c } from './extension-copy';

const unresolved = (): ApiResult<z.infer<typeof subscriptionSchema>> => ({
  ok: false,
  reason: 'uncertain',
  code: 'pay.operation_unresolved',
  message: c.t('subscriptionStillUnresolved'),
});

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
      const proof = z.object({ path: z.string(), after: z.string().datetime() }).safeParse(
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
        (s) => s.mandateId === mandateId && s.path === proof.data.path && Date.parse(s.createdAt) >= Date.parse(proof.data.after),
      );
      return matches.length === 1 ? { ok: true as const, data: matches[0]! } : unresolved();
    },
    current,
  );
}
