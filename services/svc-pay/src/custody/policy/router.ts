import { router } from '@intafaced/contracts';
import { z } from 'zod';
import type { founderProcedure } from '../../namespaces/founder-procedure.js';
import { custodyPolicyToTrpcError } from './errors.js';
import {
  policyDecisionViewSchema,
  policyDraftInputSchema,
  policyListInputSchema,
  policySimulateInputSchema,
  policyValidateInputSchema,
  policyValidationViewSchema,
  policyVersionViewSchema,
} from './schemas.js';
import type { CustodyPolicyService } from './service.js';

async function wrap<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw custodyPolicyToTrpcError(error);
  }
}

/**
 * `founderAdmin.custody.policy.*` (W-custody-ops-07). Founder-only: built from the custody router's founder procedure.
 * Publishing is not here: it is a custody `config` task with scope `policy` (see CustodyPolicyService).
 */
export function createCustodyPolicyRouters(
  founder: ReturnType<typeof founderProcedure>,
  service: CustodyPolicyService,
  actorOf: (ctx: unknown) => string,
) {
  return {
    policy: router({
      list: founder
        .input(policyListInputSchema)
        .output(z.array(policyVersionViewSchema))
        .query(({ input }) => wrap(() => service.list(input.limit))),
      current: founder
        .input(z.object({}).strict().optional())
        .output(policyVersionViewSchema)
        .query(() => wrap(() => service.current())),
      validate: founder
        .input(policyValidateInputSchema)
        .output(policyValidationViewSchema)
        .query(({ input }) => wrap(() => service.validate(input.rules))),
      draft: founder
        .input(policyDraftInputSchema)
        .output(policyVersionViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.saveDraft(actorOf(ctx), input))),
      simulate: founder
        .input(policySimulateInputSchema)
        .output(policyDecisionViewSchema)
        .query(({ input }) => wrap(() => service.simulate(input))),
    }),
  };
}
