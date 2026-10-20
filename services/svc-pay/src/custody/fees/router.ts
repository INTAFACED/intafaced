import { router } from '@intafaced/contracts';
import { z } from 'zod';
import type { founderProcedure } from '../../namespaces/founder-procedure.js';
import { custodyFeesToTrpcError } from './errors.js';
import {
  feeCheckInputSchema,
  feeCheckViewSchema,
  feeEstimateViewSchema,
  feeHistoryInputSchema,
  feeListInputSchema,
  feeSetInputSchema,
  feeSettingViewSchema,
  gasPolicyViewSchema,
  gasSetInputSchema,
  networkKeyInputSchema,
  refuelListInputSchema,
  refuelRecordInputSchema,
  refuelViewSchema,
} from './schemas.js';
import type { CustodyFeesService } from './service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw custodyFeesToTrpcError(error);
  }
}

/**
 * `founderAdmin.custody.fees.*` and `founderAdmin.custody.gas.*` (W-custody-ops-10). Built from the custody router's own
 * founder procedure, so every call is founder-only. `actorOf` is the custody router's own.
 */
export function createCustodyFeesRouters(
  founder: ReturnType<typeof founderProcedure>,
  service: CustodyFeesService,
  actorOf: (ctx: unknown) => string,
) {
  return {
    fees: router({
      get: founder
        .input(networkKeyInputSchema)
        .output(feeSettingViewSchema)
        .query(({ input }) => wrap(() => service.getFees(input.networkId))),
      list: founder
        .input(feeListInputSchema)
        .output(z.array(feeSettingViewSchema))
        .query(({ input }) => wrap(() => service.listFees(input.limit, input.after))),
      history: founder
        .input(feeHistoryInputSchema)
        .output(z.array(feeSettingViewSchema))
        .query(({ input }) => wrap(() => service.feeHistory(input.networkId, input.limit))),
      set: founder
        .input(feeSetInputSchema)
        .output(feeSettingViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.setFees(actorOf(ctx), input))),
      estimate: founder
        .input(networkKeyInputSchema)
        .output(feeEstimateViewSchema)
        .query(({ input }) => wrap(() => service.estimate(input.networkId))),
      check: founder
        .input(feeCheckInputSchema)
        .output(feeCheckViewSchema)
        .query(({ input }) => wrap(() => service.assertSendFee(input.networkId, input.level))),
    }),
    gas: router({
      policy: router({
        get: founder
          .input(networkKeyInputSchema)
          .output(gasPolicyViewSchema)
          .query(({ input }) => wrap(() => service.getGasPolicy(input.networkId))),
        set: founder
          .input(gasSetInputSchema)
          .output(gasPolicyViewSchema)
          .mutation(({ ctx, input }) => wrap(() => service.setGasPolicy(actorOf(ctx), input))),
      }),
      refuels: router({
        record: founder
          .input(refuelRecordInputSchema)
          .output(refuelViewSchema)
          .mutation(({ ctx, input }) => wrap(() => service.recordRefuel(actorOf(ctx), input))),
        list: founder
          .input(refuelListInputSchema)
          .output(z.array(refuelViewSchema))
          .query(({ input }) => wrap(() => service.listRefuels(input.networkId, input.limit))),
      }),
    }),
  };
}
