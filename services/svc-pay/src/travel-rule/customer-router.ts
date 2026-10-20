import { router, scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import { travelRuleToTrpcError } from './errors.js';
import { customerStatusSchema } from './schemas.js';
import type { TravelRuleService } from './service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw travelRuleToTrpcError(error);
  }
}

/**
 * `travelRule.status.get` (W-compliance-notices-04): the caller's own withdrawal's travel-rule status, with the fields
 * still to give and the wait deadline. `trade:read`; the user id comes from the token, so another account's withdrawal
 * reads as not found. The founder side is `founderAdmin.travelRule.*`.
 */
export function createTravelRuleCustomerRouter(service: TravelRuleService) {
  return router({
    travelRule: router({
      status: router({
        get: scopedProcedure('trade:read', { module: 'ledger' })
          .input(z.object({ withdrawalId: z.string().uuid() }).strict())
          .output(customerStatusSchema)
          .query(({ ctx, input }) => wrap(() => service.statusForCustomer(ctx.principal.userId, input.withdrawalId))),
      }),
    }),
  });
}
