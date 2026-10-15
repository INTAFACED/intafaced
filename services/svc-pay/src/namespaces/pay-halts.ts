import { z } from 'zod';
import {
  router,
  scopedProcedure,
  payHaltStatusInputSchema,
  payHaltStatusSchema,
  payHaltSetInputSchema,
  payHaltSetResultSchema,
  payHaltHistoryInputSchema,
  payHaltStateSchema,
} from '@intafaced/contracts';
import type { FounderAuthority } from '../founder-authority.js';
import { notBuilt } from './errors.js';
import { founderProcedure } from './founder-procedure.js';

/**
 * `payHalts.*` (W5 replaces these stubs).
 *   - `status` is readable by a merchant (its own effective halts).
 *   - `set` and `history` are OPERATOR actions and sit behind founder authority.
 */
export function createPayHaltsRouter(founderAuthority: FounderAuthority) {
  const read = scopedProcedure('pay:read', { module: 'pay' });
  const founder = founderProcedure(founderAuthority);
  return router({
    payHalts: router({
      status: read
        .input(payHaltStatusInputSchema)
        .output(payHaltStatusSchema)
        .query(() => notBuilt('payHalts.status')),
      set: founder
        .input(payHaltSetInputSchema)
        .output(payHaltSetResultSchema)
        .mutation(() => notBuilt('payHalts.set')),
      history: founder
        .input(payHaltHistoryInputSchema)
        .output(z.array(payHaltStateSchema))
        .query(() => notBuilt('payHalts.history')),
    }),
  });
}
