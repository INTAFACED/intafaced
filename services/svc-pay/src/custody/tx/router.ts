import { router } from '@intafaced/contracts';
import { z } from 'zod';
import type { founderProcedure } from '../../namespaces/founder-procedure.js';
import { custodyTxToTrpcError } from './errors.js';
import {
  confirmationApproveInputSchema,
  confirmationGetInputSchema,
  confirmationListInputSchema,
  confirmationRequestInputSchema,
  confirmationRequestViewSchema,
  confirmationViewSchema,
  reasonViewSchema,
  timelineEntrySchema,
  timeoutSetInputSchema,
  timeoutViewSchema,
  txDetailSchema,
  txIdInputSchema,
  txListInputSchema,
  txListViewSchema,
  txNoteInputSchema,
} from './schemas.js';
import type { CustodyTxService } from './service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw custodyTxToTrpcError(error);
  }
}

/**
 * `founderAdmin.custody.tx.*`, `.reasons.*`, `.lifecycle.*` and `.confirmation.*` (W-custody-ops-11). Built from the
 * custody router's own founder procedure, so every call is founder-only.
 */
export function createCustodyTxRouters(
  founder: ReturnType<typeof founderProcedure>,
  service: CustodyTxService,
  actorOf: (ctx: unknown) => string,
) {
  return {
    tx: router({
      list: founder
        .input(txListInputSchema)
        .output(txListViewSchema)
        .query(({ input }) => wrap(() => service.list(input))),
      get: founder
        .input(txIdInputSchema)
        .output(txDetailSchema)
        .query(({ input }) => wrap(() => service.get(input.withdrawalId))),
      addNote: founder
        .input(txNoteInputSchema)
        .output(txDetailSchema)
        .mutation(({ ctx, input }) => wrap(() => service.addNote(actorOf(ctx), input.withdrawalId, input.note))),
      timeline: founder
        .input(txIdInputSchema)
        .output(z.array(timelineEntrySchema))
        .query(({ input }) => wrap(() => service.timeline(input.withdrawalId))),
    }),
    reasons: router({
      catalog: founder.output(z.array(reasonViewSchema)).query(() => wrap(async () => service.reasons())),
    }),
    lifecycle: router({
      timeouts: founder.output(z.array(timeoutViewSchema)).query(() => wrap(() => service.listTimeouts())),
      setTimeout: founder
        .input(timeoutSetInputSchema)
        .output(timeoutViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.setTimeout(actorOf(ctx), input))),
    }),
    confirmation: router({
      get: founder
        .input(confirmationGetInputSchema)
        .output(confirmationViewSchema)
        .query(({ input }) => wrap(() => service.confirmationPolicy(input.networkId, input.withdrawalId ?? null))),
      request: founder
        .input(confirmationRequestInputSchema)
        .output(confirmationRequestViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.requestOverride(actorOf(ctx), input))),
      approve: founder
        .input(confirmationApproveInputSchema)
        .output(confirmationRequestViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.approveOverride(actorOf(ctx), input.requestId))),
      list: founder
        .input(confirmationListInputSchema)
        .output(z.array(confirmationRequestViewSchema))
        .query(({ input }) => wrap(() => service.listOverrides(input.networkId, input.limit))),
    }),
  };
}
