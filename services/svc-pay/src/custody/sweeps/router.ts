import { router } from '@intafaced/contracts';
import { z } from 'zod';
import type { founderProcedure } from '../../namespaces/founder-procedure.js';
import { custodySweepToTrpcError } from './errors.js';
import {
  sweepCreateInputSchema,
  sweepDueViewSchema,
  sweepExecuteInputSchema,
  sweepListInputSchema,
  sweepPairInputSchema,
  sweepPolicyPreviewInputSchema,
  sweepPolicyPreviewViewSchema,
  sweepPolicySetInputSchema,
  sweepPolicyViewSchema,
  sweepViewSchema,
} from './schemas.js';
import type { CustodySweepService } from './service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw custodySweepToTrpcError(error);
  }
}

/** `founderAdmin.custody.sweeps.*` (W-custody-ops-05). Founder-only: built from the custody router's founder procedure. */
export function createCustodySweepRouters(
  founder: ReturnType<typeof founderProcedure>,
  service: CustodySweepService,
  actorOf: (ctx: unknown) => string,
) {
  return {
    sweeps: router({
      policy: router({
        get: founder
          .input(sweepPairInputSchema)
          .output(sweepPolicyViewSchema)
          .query(({ input }) => wrap(() => service.getPolicy(input.networkId, input.assetId))),
        preview: founder
          .input(sweepPolicyPreviewInputSchema)
          .output(sweepPolicyPreviewViewSchema)
          .query(({ input }) => wrap(async () => service.previewPolicy(input))),
        set: founder
          .input(sweepPolicySetInputSchema)
          .output(sweepPolicyViewSchema)
          .mutation(({ ctx, input }) => wrap(() => service.setPolicy(actorOf(ctx), input))),
      }),
      due: founder
        .input(sweepPairInputSchema)
        .output(sweepDueViewSchema)
        .query(({ input }) => wrap(() => service.due(input.networkId, input.assetId))),
      list: founder
        .input(sweepListInputSchema)
        .output(z.array(sweepViewSchema))
        .query(({ input }) => wrap(() => service.list(input))),
      create: founder
        .input(sweepCreateInputSchema)
        .output(sweepViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.create(actorOf(ctx), input.depositId))),
      execute: founder
        .input(sweepExecuteInputSchema)
        .output(sweepViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.execute(actorOf(ctx), input.sweepId))),
    }),
  };
}
