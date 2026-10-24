import { router } from '@intafaced/contracts';
import { z } from 'zod';
import type { founderProcedure } from '../../namespaces/founder-procedure.js';
import { custodyStuckToTrpcError } from './errors.js';
import {
  actionIdInputSchema,
  actionInputSchema,
  actionListInputSchema,
  actionViewSchema,
  cancelInputSchema,
  diagnosisSchema,
  linkInputSchema,
  linkViewSchema,
  queueInputSchema,
  queueViewSchema,
  reverseIdInputSchema,
  reverseRequestInputSchema,
  reverseViewSchema,
  thresholdKeyInputSchema,
  thresholdSetInputSchema,
  thresholdViewSchema,
} from './schemas.js';
import type { CustodyStuckService } from './service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw custodyStuckToTrpcError(error);
  }
}

/**
 * `founderAdmin.custody.queue.*` and `.stuck.*` (W-custody-ops-12). Built from the custody router's own founder procedure,
 * so every call is founder-only. With no signer or chain reader connected, the calls that need one answer `rail.crypto`.
 */
export function createCustodyStuckRouters(
  founder: ReturnType<typeof founderProcedure>,
  service: CustodyStuckService,
  actorOf: (ctx: unknown) => string,
) {
  return {
    queue: router({
      link: founder
        .input(linkInputSchema)
        .output(linkViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.link(actorOf(ctx), input))),
      list: founder
        .input(queueInputSchema)
        .output(queueViewSchema)
        .query(({ input }) => wrap(() => service.queue(input.walletId))),
      diagnose: founder
        .input(queueInputSchema)
        .output(diagnosisSchema)
        .query(({ input }) => wrap(() => service.diagnose(input.walletId))),
      cancel: founder
        .input(cancelInputSchema)
        .output(z.object({ withdrawalId: z.string().guid(), canceled: z.literal(true) }))
        .mutation(({ ctx, input }) => wrap(() => service.cancel(actorOf(ctx), input.withdrawalId))),
    }),
    stuck: router({
      threshold: founder
        .input(thresholdKeyInputSchema)
        .output(thresholdViewSchema)
        .query(({ input }) => wrap(() => service.threshold(input.networkId))),
      setThreshold: founder
        .input(thresholdSetInputSchema)
        .output(thresholdViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.setThreshold(actorOf(ctx), input))),
      act: founder
        .input(actionInputSchema)
        .output(actionViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.act(actorOf(ctx), input))),
      resolve: founder
        .input(actionIdInputSchema)
        .output(actionViewSchema)
        .mutation(({ input }) => wrap(() => service.resolve(input.actionId))),
      get: founder
        .input(actionIdInputSchema)
        .output(actionViewSchema)
        .query(({ input }) => wrap(() => service.action(input.actionId))),
      list: founder
        .input(actionListInputSchema)
        .output(z.array(actionViewSchema))
        .query(({ input }) => wrap(() => service.listActions(input.withdrawalId))),
      requestReverse: founder
        .input(reverseRequestInputSchema)
        .output(reverseViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.requestReverse(actorOf(ctx), input))),
      approveReverse: founder
        .input(reverseIdInputSchema)
        .output(reverseViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.approveReverse(actorOf(ctx), input.requestId))),
      executeReverse: founder
        .input(reverseIdInputSchema)
        .output(reverseViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.executeReverse(actorOf(ctx), input.requestId))),
    }),
  };
}
