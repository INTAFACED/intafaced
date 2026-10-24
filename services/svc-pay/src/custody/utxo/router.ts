import { router } from '@intafaced/contracts';
import { z } from 'zod';
import type { founderProcedure } from '../../namespaces/founder-procedure.js';
import { custodyUtxoToTrpcError } from './errors.js';
import {
  consolidateInputSchema,
  consolidationViewSchema,
  dueInputSchema,
  dueViewSchema,
  triggerKeyInputSchema,
  triggerSetInputSchema,
  triggerViewSchema,
  utxoLabelInputSchema,
  utxoListInputSchema,
  utxoViewSchema,
} from './schemas.js';
import type { CustodyUtxoService } from './service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw custodyUtxoToTrpcError(error);
  }
}

/**
 * `founderAdmin.custody.utxo.*` (W-custody-ops-13). Built from the custody router's own founder procedure, so every call
 * is founder-only. With no node connected, list, due and consolidate answer `rail.crypto`.
 */
export function createCustodyUtxoRouters(
  founder: ReturnType<typeof founderProcedure>,
  service: CustodyUtxoService,
  actorOf: (ctx: unknown) => string,
) {
  return {
    utxo: router({
      list: founder
        .input(utxoListInputSchema)
        .output(z.array(utxoViewSchema))
        .query(({ input }) => wrap(() => service.list(input))),
      label: founder
        .input(utxoLabelInputSchema)
        .output(utxoViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.label(actorOf(ctx), input))),
      triggers: founder
        .input(triggerKeyInputSchema)
        .output(triggerViewSchema)
        .query(({ input }) => wrap(() => service.triggers(input.networkId))),
      setTriggers: founder
        .input(triggerSetInputSchema)
        .output(triggerViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.setTriggers(actorOf(ctx), input))),
      due: founder
        .input(dueInputSchema)
        .output(dueViewSchema)
        .query(({ input }) => wrap(() => service.due(input.walletId))),
      consolidate: founder
        .input(consolidateInputSchema)
        .output(consolidationViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.consolidate(actorOf(ctx), input))),
      consolidations: founder
        .input(z.object({ walletId: z.string().guid(), limit: z.number().int().min(1).max(200) }).strict())
        .output(z.array(consolidationViewSchema))
        .query(({ input }) => wrap(() => service.listConsolidations(input.walletId, input.limit))),
    }),
  };
}
