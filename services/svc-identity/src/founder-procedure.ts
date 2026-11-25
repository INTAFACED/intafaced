import { protectedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { isInteractiveFounderPrincipal } from './auth/action-approval-audience.js';

/** Who is a founder now: identity's own entitlement read, never cached. */
export interface Founders {
  isFounder(userId: string): Promise<boolean>;
}

/**
 * The founder guard of identity's console rooms: a live founder on an interactive second-factor session, before any
 * input is parsed; anyone else is refused `operator.denied`. The founder's user id goes on the context as
 * `founderUserId`, as a `founder` record's handler reads it (`ServiceParts.founder`).
 */
export function founderProcedure(founders: Founders) {
  return protectedProcedure.use(async ({ ctx, next }) => {
    const p = ctx.principal;
    if (!isInteractiveFounderPrincipal(p) || !(await founders.isFounder(p.userId)))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
    return next({ ctx: { ...ctx, founderUserId: p.userId } });
  });
}
