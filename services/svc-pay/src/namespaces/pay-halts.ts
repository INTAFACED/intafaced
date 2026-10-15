import { z } from 'zod';
import {
  router,
  scopedProcedure,
  TRPCError,
  payHaltStatusInputSchema,
  payHaltStatusSchema,
  payHaltOperatorStatusSchema,
  payHaltSetInputSchema,
  payHaltSetResultSchema,
  payHaltHistoryInputSchema,
  payHaltEventSchema,
} from '@intafaced/contracts';
import type { FounderAuthority } from '../founder-authority.js';
import { PayHaltError, type PayHaltStore } from '../halts/store.js';
import { assertMerchantOwnership, type MerchantOwnerLookup } from '../merchant-ownership.js';
import { founderProcedure, type FounderContext } from './founder-procedure.js';

/**
 * `payHalts.*` (W5).
 *   - `status` is readable by a merchant: its own effective halts, MERCHANT-SAFE
 *     shape only (on/off and since when; no reason, actor or trip source).
 *   - `operatorStatus`, `set` and `history` are OPERATOR actions behind founder
 *     authority. Setting a halt takes one founder. CLEARING one takes two distinct
 *     founders: the first call answers `pending_confirmation`, a different
 *     founder repeating the same call applies it.
 *
 * Without a store (`deps` absent) every procedure refuses with
 * `pay.halt_store_unavailable`; it never answers "nothing is halted".
 */
export interface PayHaltsDeps {
  readonly store: PayHaltStore;
  /** Only `getMerchant` is used, to prove the caller owns the merchant it asks about. */
  readonly merchants: MerchantOwnerLookup;
}

class PayHaltsRouterError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function unavailable(): never {
  const cause = new PayHaltsRouterError('pay.halt_store_unavailable');
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: cause.code, cause });
}

function mapError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof PayHaltError && error.code === 'pay.halt_target_not_found') {
    throw new TRPCError({ code: 'NOT_FOUND', message: error.code, cause: error });
  }
  const cause = new PayHaltsRouterError('pay.halt_store_unavailable');
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: cause.code, cause });
}

export function createPayHaltsRouter(founderAuthority: FounderAuthority, deps?: PayHaltsDeps) {
  const read = scopedProcedure('pay:read', { module: 'pay' });
  const founder = founderProcedure(founderAuthority);
  return router({
    payHalts: router({
      status: read
        .input(payHaltStatusInputSchema)
        .output(payHaltStatusSchema)
        .query(async ({ ctx, input }) => {
          if (!deps) return unavailable();
          if (input.merchantId) {
            try {
              await assertMerchantOwnership(deps.merchants, ctx.principal?.userId, input.merchantId);
            } catch {
              // Same answer for "not yours" and "does not exist": no existence leak.
              const cause = new PayHaltsRouterError('pay.merchant_forbidden');
              throw new TRPCError({ code: 'FORBIDDEN', message: cause.code, cause });
            }
          }
          return deps.store.status(input.merchantId);
        }),
      operatorStatus: founder.output(payHaltOperatorStatusSchema).query(async () => {
        if (!deps) return unavailable();
        return deps.store.operatorStatus();
      }),
      set: founder
        .input(payHaltSetInputSchema)
        .output(payHaltSetResultSchema)
        .mutation(async ({ ctx, input }) => {
          if (!deps) return unavailable();
          try {
            return await deps.store.set((ctx as FounderContext).founderUserId, input);
          } catch (error) {
            return mapError(error);
          }
        }),
      history: founder
        .input(payHaltHistoryInputSchema)
        .output(z.array(payHaltEventSchema))
        .query(async ({ input }) => {
          if (!deps) return unavailable();
          try {
            return await deps.store.history(input);
          } catch (error) {
            return mapError(error);
          }
        }),
    }),
  });
}
