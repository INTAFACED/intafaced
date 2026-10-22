import { z } from 'zod';
import {
  router,
  TRPCError,
  payHaltStatusInputSchema,
  payHaltStatusSchema,
  payHaltOperatorStatusSchema,
  payHaltSetInputSchema,
  payHaltSetResultSchema,
  payHaltHistoryInputSchema,
  payHaltEventSchema,
  payHaltPendingClearListInputSchema,
  payHaltPendingClearListSchema,
} from '@intafaced/contracts';
import type { FounderAuthority } from '../founder-authority.js';
import { PayHaltError, type PayHaltStore } from '../halts/store.js';
import { PayError } from '../payment-service.js';
import { allowMerchantRead } from '../merchant-read-access.js';
import type { MerchantTeamRead } from '../merchant-team-read.js';
import { assertMerchantOwnership, type MerchantOwnerLookup } from '../merchant-ownership.js';
import { founderProcedure, type FounderContext } from './founder-procedure.js';
import { ownMerchantRead } from '../own-merchant-read.js';
import { hasScope } from '@intafaced/auth';

/**
 * `payHalts.*` (W5).
 *   - `status` is readable by a merchant: its own effective halts, MERCHANT-SAFE
 *     shape only (on/off and since when; no reason, actor or trip source).
 *   - `operatorStatus`, `set`, `history` and `pendingClears` are OPERATOR actions
 *     behind founder authority. Setting a halt takes one founder. CLEARING one takes
 *     two distinct founders: the first call answers `pending_confirmation`, a different
 *     founder repeating the same call applies it. `pendingClears` lists those open proposals.
 *
 * Without a store (`deps` absent) every procedure refuses with
 * `pay.halt_store_unavailable`; it never answers "nothing is halted".
 */
export interface PayHaltsDeps {
  readonly store: PayHaltStore;
  /** Only `getMerchant` is used, to prove the caller owns the merchant it asks about. */
  readonly merchants: MerchantOwnerLookup;
  /** Active team members, by role. Absent keeps the owner-only rule. */
  readonly team?: MerchantTeamRead | null;
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
  if (error instanceof PayHaltError) {
    switch (error.code) {
      case 'pay.halt_target_not_found':
      case 'pay.halt_target_unknown_rail':
        throw new TRPCError({ code: 'NOT_FOUND', message: error.code, cause: error });
      case 'pay.halt_target_unsupported':
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.code, cause: error });
      case 'pay.halt_store_unavailable':
        break;
      default: {
        const unreachable: never = error.code;
        void unreachable;
      }
    }
  }
  const cause = new PayHaltsRouterError('pay.halt_store_unavailable');
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: cause.code, cause });
}

export function createPayHaltsRouter(founderAuthority: FounderAuthority, deps?: PayHaltsDeps) {
  const read = ownMerchantRead();
  const founder = founderProcedure(founderAuthority);
  return router({
    payHalts: router({
      status: read
        .input(payHaltStatusInputSchema)
        .output(payHaltStatusSchema)
        .query(async ({ ctx, input }) => {
          if (!deps) return unavailable();
          // The platform-wide answer stays with acquiring merchants; an owner still onboarding asks about its own.
          if (!input.merchantId && !hasScope(ctx.principal.scopes, 'pay:read')) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Scope "pay:read" is required' });
          }
          if (input.merchantId) {
            try {
              await allowMerchantRead({
                ownerCheck: () => assertMerchantOwnership(deps.merchants, ctx.principal?.userId, input.merchantId!),
                team: deps.team,
                userId: ctx.principal?.userId,
                merchantId: input.merchantId,
                permission: 'halts.read',
              });
            } catch (err) {
              if (err instanceof PayError && err.code !== 'pay.merchant_not_found') throw err;
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
      pendingClears: founder
        .input(payHaltPendingClearListInputSchema)
        .output(payHaltPendingClearListSchema)
        .query(async ({ input }) => {
          if (!deps) return unavailable();
          try {
            return await deps.store.pendingClears(input);
          } catch (error) {
            return mapError(error);
          }
        }),
    }),
  });
}
