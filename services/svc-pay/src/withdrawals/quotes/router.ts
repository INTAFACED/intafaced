import { router, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { FounderAuthority } from '../../founder-authority.js';
import { founderProcedure, type FounderContext } from '../../namespaces/founder-procedure.js';
import { withdrawalQuoteToTrpcError } from './errors.js';
import { adminQuoteViewSchema, listInputSchema, policyViewSchema, setPolicyInputSchema } from './schemas.js';
import { WithdrawalQuoteService } from './service.js';

/** What a mount supplies besides the founder authority. */
export type WithdrawalQuoteMountDeps = Omit<WithdrawalQuoteRouterDeps, 'founderAuthority'>;

export interface WithdrawalQuoteRouterDeps {
  readonly founderAuthority: FounderAuthority;
  readonly sql: Sql;
  /** Tests inject a clock; production uses the wall clock. */
  readonly now?: () => Date;
}

function actorOf(ctx: unknown): string {
  const id = (ctx as Partial<FounderContext>).founderUserId;
  if (typeof id !== 'string' || id.trim() === '') throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
  return id;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw withdrawalQuoteToTrpcError(error);
  }
}

/**
 * `founderAdmin.withdrawalQuotes.*` (W-withdraw-04): the owner's fee mode and quote lifetime, and a read of the quotes
 * customers asked for. Founder-only: every procedure is built from `founderProcedure`. Mounted INSIDE the founderAdmin
 * router. The customer's own quote is `withdrawal.quote` on the pay router.
 */
export function createWithdrawalQuoteRouter(deps: WithdrawalQuoteRouterDeps) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new WithdrawalQuoteService({ sql: deps.sql, now: deps.now });
  return router({
    policy: founder
      .input(z.object({}).strict())
      .output(policyViewSchema)
      .query(() => wrap(() => service.policy())),
    setPolicy: founder
      .input(setPolicyInputSchema)
      .output(policyViewSchema)
      .mutation(({ ctx, input }) => wrap(() => service.setPolicy(actorOf(ctx), input))),
    list: founder
      .input(listInputSchema)
      .output(z.array(adminQuoteViewSchema))
      .query(({ input }) => wrap(() => service.list(input))),
  });
}
